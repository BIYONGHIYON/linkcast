import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../hooks/use-voice-mesh.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const listeners = new Map();
const connections = [];
function client(selfId) {
  const effects = [];
  const exports = {};
  class Peer {
    signalingState = 'stable';
    connectionState = 'new';
    remoteDescription = null;
    constructor() { connections.push(this); }
    addTransceiver(track, options) {
      assert.equal(options.direction, 'sendrecv');
      this.sender = { track, replaceTrack: async next => { this.sender.track = next; } };
      return { sender: this.sender };
    }
    async createOffer() { return { type: 'offer', sdp: 'audio-only' }; }
    async createAnswer() { return { type: 'answer', sdp: 'audio-only' }; }
    async setLocalDescription(value) { this.localDescription = value; this.signalingState = value.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(value) { this.remoteDescription = value; this.signalingState = value.type === 'offer' ? 'have-remote-offer' : 'stable'; }
    async addIceCandidate() {}
    close() { this.closed = true; }
  }
  runInNewContext(compiled, { exports, require: () => ({
    useRef: current => ({ current }), useCallback: fn => fn, useEffect: fn => effects.push(fn),
  }), RTCPeerConnection: Peer, window: { setTimeout, clearTimeout } });
  const received = [];
  const microphone = { kind: 'audio', id: selfId };
  const replace = exports.useVoiceMesh({ selfId, hostId: 'host',
    participants: [{ id: 'host' }, { id: selfId === 'a' ? 'b' : 'a' }],
    track: { current: microphone }, attach: (id, track) => received.push({ id, track }), remove() {},
    send: (id, message) => queueMicrotask(() => listeners.get(id)?.(selfId, message)),
    subscribe: listener => { listeners.set(selfId, listener); return () => listeners.delete(selfId); },
  });
  const cleanup = effects.map(fn => fn());
  return { replace, received, microphone, cleanup: () => cleanup.forEach(fn => fn?.()) };
}
const a = client('a');
const b = client('b');
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(connections.length, 2, 'one audio peer at each viewer, no duplicate offers');
assert.ok(connections.every(pc => pc.remoteDescription && pc.signalingState === 'stable'));
assert.equal(connections[0].sender.track, a.microphone);
assert.equal(connections[1].sender.track, b.microphone);
connections[0].ontrack({ track: b.microphone });
assert.equal(a.received[0].id, 'mesh:b');
await a.replace(null);
assert.equal(connections[0].sender.track, null);
await a.replace(a.microphone);
assert.equal(connections[0].sender.track, a.microphone);
a.cleanup(); b.cleanup();
assert.ok(connections.every(pc => pc.closed));
assert.equal(listeners.size, 0);
console.log('PASS: viewer audio negotiation, remote playback attachment, microphone replacement, room cleanup');
