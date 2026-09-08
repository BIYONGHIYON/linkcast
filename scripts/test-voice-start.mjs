import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../hooks/use-voice-chat.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function setup() {
  const state = [];
  const microphone = { enabled: true, readyState: 'live', kind: 'audio', stop() { this.stopped = true; } };
  const stream = { getTracks: () => [microphone], getAudioTracks: () => [microphone] };
  const node = () => ({ connect(target) { return target; }, disconnect() {} });
  let destination;
  class AudioContext {
    state = 'running';
    destination = node();
    currentTime = 0;
    audioWorklet = { addModule: async () => {} };
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return node(); }
    createMediaElementSource(player) {
      assert.equal(player.srcObject, undefined, 'reroute before remote playback starts');
      player.routedThroughWebAudio = true;
      return { ...node(), connect(gain) {
        assert.equal(gain.gain.value, 1.5, 'single path applies full 150 percent gain');
        return gain;
      } };
    }
    createAnalyser() { return { ...node(), fftSize: 1024, getFloatTimeDomainData(buffer) { buffer.fill(0.1); } }; }
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
  const playback = [];
  runInNewContext(compiled, { exports, require: () => hooks, AudioContext,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    document: { body: { appendChild(element) { element.connected = true; } } },
    window: { setInterval: () => 1, clearInterval() {} },
    Audio: class {
      constructor() { playback.push(this); }
      setAttribute() {}
      play() { this.played = true; return Promise.resolve(); }
      pause() { this.paused = true; }
      remove() { this.connected = false; }
      setSinkId(id) { this.sinkId = id; return Promise.resolve(); }
    },
    AudioWorkletNode: class { parameters = new Map([['threshold', { value: 0 }]]); port = {}; disconnect() {} connect(target) { return target; } },
    navigator: { mediaDevices: { getUserMedia: async constraints => {
      assert.equal(constraints.audio.autoGainControl, true, 'normalize quiet microphones');
      return stream;
    }, enumerateDevices: async () => [] } },
  });
  return { voice: exports.useVoiceChat(), state, microphone, playback };
}
{
  const { voice, state, microphone, playback } = setup();
  assert.equal(voice.volume, 150, 'default call volume is boosted');
  voice.bindOutputElement({ sinkId: 'same-as-video-output' });
  let published;
  voice.subscribeTrack(async track => { published = track; if (track) assert.equal(track, microphone); });
  let meterUpdates = 0;
  const unsubscribeMeter = voice.subscribeLevel(() => meterUpdates++);
  await voice.start();
  assert.ok(voice.getLevel() > 0);
  assert.equal(meterUpdates, 1, 'level updates notify the isolated meter');
  assert.ok(published);
  assert.equal(state[0], true, 'show joined only after sender accepts track');
  assert.equal(playback.length, 0, 'voice output does not depend on a detached audio element');
  const incoming = { kind: 'audio', readyState: 'live', enabled: true };
  voice.attach('peer', incoming);
  await voice.resumePlayback();
  assert.equal(playback.length, 1);
  assert.equal(playback[0].srcObject.tracks[0], incoming, 'native player receives original remote track');
  assert.equal(playback[0].connected, true);
  assert.equal(playback[0].played, true);
  assert.equal(playback[0].routedThroughWebAudio, true, 'native output is rerouted, not mixed with a second stream source');
  assert.equal(playback[0].volume, 1);
  assert.equal(playback[0].sinkId, 'same-as-video-output');
  voice.attach('peer', incoming);
  assert.equal(playback.length, 1, 'duplicate ontrack does not interrupt playback');
  voice.remove('peer');
  assert.equal(playback[0].srcObject, null);
  assert.equal(playback[0].connected, false);
  voice.attach('peer', incoming);
  playback[1].play = () => Promise.reject(new Error('NotAllowedError'));
  await voice.resumePlayback();
  assert.equal(state[7], true, 'autoplay rejection exposes the playback unlock control');
  playback[1].play = () => Promise.resolve();
  await voice.resumePlayback();
  assert.equal(state[7], false, 'explicit playback retry clears blocked state');
  voice.stop();
  assert.equal(playback[1].srcObject, null);
  assert.equal(microphone.stopped, true);
  assert.equal(published, null);
  assert.equal(voice.getLevel(), 0);
  assert.equal(meterUpdates, 2, 'stop resets the meter');
  unsubscribeMeter();
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
