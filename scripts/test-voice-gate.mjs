import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
let Processor;
const messages = [];
runInNewContext(await readFile(new URL('../public/voice-gate.js', import.meta.url), 'utf8'), {
  sampleRate: 48000,
  AudioWorkletProcessor: class { port = { postMessage: m => messages.push(m) }; },
  registerProcessor: (_name, value) => { Processor = value; },
});
const processor = new Processor();
const process = (amplitude, threshold = 0.01) => {
  const output = new Float32Array(128);
  assert.equal(processor.process([[new Float32Array(128).fill(amplitude)]], [[output]], { threshold: [threshold] }), true);
  assert.ok(output.every(Number.isFinite));
  return Math.max(...output.map(Math.abs));
};
assert.equal(process(0.001), 0, 'quiet noise is gated');
assert.ok(process(0.2) > 0.1, 'voice starts within the first audio block');
assert.ok(process(0.001) > 0, 'brief word pauses do not chop the voice');
for (let i = 0; i < 400; i++) process(0.001);
assert.ok(process(0.001) < 0.000001, 'the gate closes after the hold and release');
assert.ok(process(0.005, 0.001) > 0.002, 'higher sensitivity admits quieter voice');
assert.equal(process(0), 0, 'muted microphone emits silence');
assert.ok(messages.length > 0 && messages.length < 20, 'meter notifications are throttled');
console.log('PASS: voice attack, pause hold, noise rejection, sensitivity, silent mute and bounded metering');
