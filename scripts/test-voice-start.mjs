import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../hooks/use-voice-chat.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function setup() {
  const state = [];
  const microphone = { enabled: true, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [microphone], getAudioTracks: () => [microphone] };
  const node = () => ({ connect(target) { return target; }, disconnect() {} });
  let destination;
  class AudioContext {
    currentTime = 0;
    audioWorklet = { addModule: async () => {} };
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return node(); }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    createMediaStreamDestination() {
      destination = { ...node(), channelCount: 2 };
      const track = { stop() {}, getSettings: () => ({ channelCount: destination.channelCount }) };
      return Object.assign(destination, { stream: { getAudioTracks: () => [track] } });
    }
  }
  const hooks = { useRef: current => ({ current }), useEffect() {}, useCallback: fn => fn, useState: initial => {
    const index = state.length; state.push(initial);
    return [initial, next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
  } };
  const exports = {};
  runInNewContext(compiled, { exports, require: () => hooks, AudioContext,
    AudioWorkletNode: class { parameters = new Map([['threshold', { value: 0 }]]); port = {}; disconnect() {} connect(target) { return target; } },
    navigator: { mediaDevices: { getUserMedia: async () => stream, enumerateDevices: async () => [] } },
  });
  return { voice: exports.useVoiceChat(), state, microphone };
}
{
  const { voice, state, microphone } = setup();
  let published;
  voice.subscribeTrack(async track => { published = track; assert.equal(track?.getSettings().channelCount, 1); });
  await voice.start();
  assert.ok(published);
  assert.equal(state[0], true, 'show joined only after sender accepts track');
  voice.stop();
  assert.equal(microphone.stopped, true);
}
{
  const { voice, state, microphone } = setup();
  voice.subscribeTrack(async track => { if (track) throw new Error('negotiated channel mismatch'); });
  await voice.start();
  assert.equal(state[0], false, 'failed sender must not be shown as joined');
  assert.ok(state.some(value => typeof value === 'string' && value.includes('마이크 전송')));
  assert.equal(microphone.stopped, true, 'release microphone after failed sender');
}
console.log('PASS: mono sender handoff, successful join, visible sender failure and microphone cleanup');
