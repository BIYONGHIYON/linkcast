import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../lib/data-channel.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const compiledModule = { exports: {} };
runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports, setTimeout, clearTimeout });
const { queueDataChannel } = compiledModule.exports;

class Channel extends EventTarget {
  readyState = 'connecting';
  bufferedAmount = 0;
  sent = [];
  send(message) { this.sent.push(message); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}
const channel = new Channel();
const transport = queueDataChannel(channel, 2);
assert.equal(transport.send('offer'), true);
assert.equal(transport.send('old state', 'state'), true);
assert.equal(transport.send('new state', 'state'), true);
assert.equal(transport.send('candidate'), false, 'a full queue must not silently displace an offer');
channel.readyState = 'open';
channel.dispatchEvent(new Event('open'));
assert.deepEqual(channel.sent, ['offer', 'new state']);
assert.equal(transport.send('candidate'), true);
assert.deepEqual(channel.sent, ['offer', 'new state', 'candidate']);

const congested = new Channel();
congested.readyState = 'open';
congested.bufferedAmount = 65536;
const delayed = queueDataChannel(congested);
assert.equal(delayed.send('stroke'), true);
assert.deepEqual(congested.sent, []);
congested.bufferedAmount = 32768;
congested.dispatchEvent(new Event('bufferedamountlow'));
assert.deepEqual(congested.sent, ['stroke']);
delayed.close();
assert.equal(delayed.send('stale stroke'), false);
assert.deepEqual(congested.sent, ['stroke']);
transport.close();
console.log('PASS: queued offers and pointers drain on open/buffer relief, latest state coalesces, closed channels reject stale data');
