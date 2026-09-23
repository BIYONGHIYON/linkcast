import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../hooks/use-call-presence.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function participant(host) {
  const hooks = [];
  const channels = [];
  let index = 0;
  let effects = [];
  const react = {
    useRef(initial) { return hooks[index++] ??= { current: initial }; },
    useState(initial) {
      const slot = index++;
      hooks[slot] ??= { value: initial };
      return [hooks[slot].value, next => { hooks[slot].value = typeof next === 'function' ? next(hooks[slot].value) : next; }];
    },
    useCallback: fn => fn,
    useEffect: fn => effects.push(fn),
  };
  const exports = {};
  runInNewContext(compiled, { exports, require: name => name === 'react' ? react : {
    queueDataChannel: channel => ({ channel, send: message => { channel.send(message); return true; }, close: () => channel.close() }),
  } });
  const connection = () => ({ createDataChannel() {
    const channel = { readyState: 'open', messages: [], send(message) { this.messages.push(JSON.parse(message)); }, close() { this.readyState = 'closed'; } };
    channels.push(channel);
    return channel;
  } });
  const render = enabled => {
    index = 0;
    effects = [];
    const result = exports.useCallPresence({ enabled, muted: false, speaking: false });
    effects[0]();
    return result;
  };
  const call = render(true);
  const selfId = host ? 'host' : 'viewer';
  call.register(host ? 'viewer-a' : 'host', connection(), host, selfId);
  if (host) call.register('viewer-b', connection(), host, selfId);
  render(false);
  render(true);
  return { channels };
}

const host = participant(true);
assert.equal(host.channels.length, 2, 'host call toggle must keep the same two presence channels');
for (const channel of host.channels) {
  const roster = channel.messages.at(-1).roster;
  assert.deepEqual(Array.from(roster, person => person.id), ['host', 'viewer-a', 'viewer-b']);
  assert.equal(roster[0].enabled, true);
  assert.equal(new Set(roster.map(person => person.id)).size, roster.length);
}

const viewer = participant(false);
assert.equal(viewer.channels.length, 1, 'viewer call toggle must keep the host presence channel');
assert.deepEqual(Array.from(viewer.channels[0].messages.slice(-2), message => message.enabled), [false, true]);
console.log('PASS: stopping and restarting a call keeps one roster and the existing presence channels');
