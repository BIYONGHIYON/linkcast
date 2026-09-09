import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../hooks/use-voice-mesh.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const listeners = new Map();
const connections = [];
const A_ID = 'aaaaaaaaaaaaaaaa';
const B_ID = 'bbbbbbbbbbbbbbbb';
const C_ID = 'cccccccccccccccc';
function client(selfId, visiblePeerIds) {
  const effects = [];
  const exports = {};
  class Peer {
    signalingState = 'stable';
    connectionState = 'new';
    remoteDescription = null;
    constructor() { connections.push(this); }
    addTransceiver(track, options) {
      assert.equal(options.direction, 'sendrecv');
      this.initialTrack = track;
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
    participants: [{ id: 'host' }, ...visiblePeerIds.map(id => ({ id }))],
    track: { current: microphone }, attach: (id, track) => received.push({ id, track }), remove() {},
    send: (id, message) => queueMicrotask(() => listeners.get(id)?.(selfId, message)),
    subscribe: listener => { listeners.set(selfId, listener); return () => listeners.delete(selfId); },
  });
  const cleanup = effects.map(fn => fn());
  return { replace, received, microphone, cleanup: () => cleanup.forEach(fn => fn?.()) };
}
const a = client(A_ID, [B_ID, C_ID]);
// Model the real race: B and C receive relayed offers before React has committed
// roster entries for the senders. Every viewer pair must still establish audio.
const b = client(B_ID, [C_ID]);
const c = client(C_ID, []);
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(connections.length, 6, 'three viewer pairs create one audio peer at each end');
assert.ok(connections.every(pc => pc.remoteDescription && pc.signalingState === 'stable'));
assert.equal(connections.filter(pc => pc.initialTrack === a.microphone).length, 2);
assert.equal(connections.filter(pc => pc.initialTrack === b.microphone).length, 2);
assert.equal(connections.filter(pc => pc.initialTrack === c.microphone).length, 2);
connections[0].ontrack({ track: b.microphone });
assert.equal(a.received[0].id, `mesh:${B_ID}`);
await a.replace(null);
assert.ok(connections.filter(pc => pc.initialTrack === a.microphone).every(pc => pc.sender.track === null));
await a.replace(a.microphone);
assert.ok(connections.filter(pc => pc.initialTrack === a.microphone).every(pc => pc.sender.track === a.microphone));
a.cleanup(); b.cleanup(); c.cleanup();
assert.ok(connections.every(pc => pc.closed));
assert.equal(listeners.size, 0);
console.log('PASS: every viewer pair survives roster races, attaches playback, replaces microphones, and cleans up');
