import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import WebSocket from 'ws';
const origin = process.env.LINKCAST_TEST_ORIGIN || 'http://localhost:8799';
globalThis.window = { location: { href: origin } };
let failNextConnection = false;
globalThis.WebSocket = class extends WebSocket {
  constructor(url) {
    super(url, { origin });
    if (failNextConnection) {
      failNextConnection = false;
      this.once('open', () => this.terminate());
    }
  }
};
const source = await readFile(new URL('../hooks/signaling-socket.ts', import.meta.url), 'utf8');
const roomInput = await readFile(new URL('../lib/room-input.ts', import.meta.url), 'utf8');
const roomInputModule = ts.transpileModule(roomInput, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const roomInputUrl = `data:text/javascript;base64,${Buffer.from(roomInputModule).toString('base64')}`;
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace("from '@/lib/room-input'", `from '${roomInputUrl}'`);
const { SignalingSocket } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const host = new SignalingSocket();
const viewer = new SignalingSocket();
const roomId = crypto.randomUUID().replaceAll('-', '');
const hostId = crypto.randomUUID().replaceAll('-', '');
const viewerId = crypto.randomUUID().replaceAll('-', '');
const request = (client, role, peerId) => client.request('/api/rooms', { method: 'POST', body: JSON.stringify({ roomId, role, peerId }) });
const send = (client, senderId, recipientId, kind, payload) => client.request('/api/signals', {
  method: 'POST', body: JSON.stringify({ roomId, senderId, recipientId, kind, payload }),
});
const signals = [];
const until = async predicate => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
try {
  await request(host, 'host', hostId);
  await request(viewer, 'viewer', viewerId);
  host.subscribe(signal => signals.push(signal));
  await until(() => signals.some(s => s.kind === 'join'));
  await send(host, hostId, viewerId, 'offer', { sdp: 'buffered' });
  await new Promise(resolve => setTimeout(resolve, 50));
  viewer.subscribe(signal => {
    signals.push(signal);
    if (signal.kind === 'host_restart') void send(viewer, viewerId, hostId, 'join', { reset: true });
  });
  await until(() => signals.some(s => s.kind === 'offer'));
  assert.equal(JSON.parse(signals.find(s => s.kind === 'offer').payload).sdp, 'buffered');
  const count = signals.filter(s => s.kind === 'join').length;
  failNextConnection = true;
  host.socket.terminate();
  await until(() => signals.filter(s => s.kind === 'join').length > count);
  const offers = signals.filter(s => s.kind === 'offer').length;
  viewer.socket.terminate();
  await request(viewer, 'viewer', viewerId);
  await send(host, hostId, viewerId, 'offer', { sdp: 'after-rejoin' });
  await until(() => signals.filter(s => s.kind === 'offer').length > offers);
  host.close();
  await until(() => signals.some(s => s.kind === 'room_closed' && s.senderId === hostId));
  assert.equal(viewer.stopped, true);
  console.log('PASS: client admission, buffered signals, automatic host reconnect, room termination stops retries');
} finally { host.close(); viewer.close(); }
