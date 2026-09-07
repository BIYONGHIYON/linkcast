import assert from 'node:assert/strict';
import WebSocket from 'ws';

const origin = process.env.LINKCAST_TEST_ORIGIN || 'http://localhost:8799';
const roomId = `test_${crypto.randomUUID().replaceAll('-', '')}`;
const sockets = [];
const wait = (ws, predicate) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('Message timeout')); }, 5000);
  const listener = raw => {
    const text = raw.toString();
    const value = text === 'pong' ? text : JSON.parse(text);
    if (predicate(value)) { clearTimeout(timer); ws.off('message', listener); resolve(value); }
  };
  ws.on('message', listener);
});
function connect(role, peerId = crypto.randomUUID().replaceAll('-', '')) {
  const url = new URL('/api/socket', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams({ role, peerId, roomId }).toString();
  const ws = new WebSocket(url, { origin });
  sockets.push(ws);
  return { ws, peerId, ready: wait(ws, message => message.type === 'ready' || message.type === 'error') };
}
try {
  const host = connect('host');
  assert.equal((await host.ready).type, 'ready');
  const impostor = connect('host');
  assert.equal((await impostor.ready).error, 'room_forbidden');
  const viewers = Array.from({ length: 6 }, () => connect('viewer'));
  const responses = await Promise.all(viewers.map(v => v.ready));
  assert.equal(responses.filter(r => r.type === 'ready').length, 5);
  assert.equal(responses.filter(r => r.error === 'room_full').length, 1);
  const viewer = viewers[responses.findIndex(r => r.type === 'ready')];
  const offer = wait(viewer.ws, m => m.kind === 'offer');
  host.ws.send(JSON.stringify({ recipientId: viewer.peerId, kind: 'offer', payload: { type: 'offer', sdp: 'test' } }));
  assert.equal(JSON.parse((await offer).payload).sdp, 'test');
  const pong = wait(viewer.ws, m => m === 'pong');
  viewer.ws.send('ping');
  await pong;
  const departed = wait(host.ws, m => m.kind === 'leave' && m.senderId === viewer.peerId);
  viewer.ws.terminate();
  await departed;
  const replacement = connect('viewer', viewer.peerId);
  assert.equal((await replacement.ready).type, 'ready');
  host.ws.terminate();
  await new Promise(resolve => host.ws.once('close', resolve));
  const rehost = connect('host', host.peerId);
  assert.equal((await rehost.ready).type, 'ready');
  const ended = wait(replacement.ws, m => m.kind === 'room_closed' && m.senderId === host.peerId);
  rehost.ws.send(JSON.stringify({ type: 'leave' }));
  await ended;
  const offline = connect('viewer');
  assert.equal((await offline.ready).error, 'room_offline');
  assert.equal((await fetch(`${origin}/api/signals`)).status, 410);
  console.log('PASS: admission, host ownership, five-viewer race, offer relay, automatic pong, abnormal exit, slot reuse, host reconnect, room end, retired polling');
} finally {
  sockets.forEach(ws => ws.terminate());
}
