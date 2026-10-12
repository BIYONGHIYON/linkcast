import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../lib/video-quality.ts', import.meta.url), 'utf8');
const exports = {};
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
  exports, require: () => ({ updateSender: (_sender, update) => update() }), DOMException,
});
const { configureVideoQuality } = exports;
let calls = 0;
const parameters = { degradationPreference: 'maintain-framerate', encodings: [
  { rid: 'main', maxBitrate: 12000000, maxFramerate: 30, scaleResolutionDownBy: 2 },
] };
const sender = { track: { kind: 'video', getSettings: () => ({ width: 3840, height: 2160 }) }, getParameters: () => parameters,
  async setParameters(next) { calls++; assert.equal(next, parameters); } };
await configureVideoQuality(sender);
assert.equal(parameters.degradationPreference, 'maintain-resolution');
assert.equal(parameters.encodings[0].maxFramerate, 60);
assert.equal(parameters.encodings[0].scaleResolutionDownBy, 2);
assert.equal('maxBitrate' in parameters.encodings[0], false);
assert.equal(parameters.encodings[0].rid, 'main');
await configureVideoQuality(sender);
assert.equal(calls, 2, 'same policy on renegotiation');
await configureVideoQuality({ ...sender, getParameters: () => ({ encodings: [] }) });
await configureVideoQuality({ ...sender, track: { kind: 'audio' } });
assert.equal(calls, 2, 'skip audio and unnegotiated encodings');
await assert.rejects(configureVideoQuality({ ...sender, setParameters: async () => { throw new Error('closed'); } }));
assert.equal(exports.broadcastScale({ width: 1280, height: 720 }), 1, 'never upscale');
assert.equal(exports.broadcastScale({ width: 2560, height: 1440 }), 4 / 3);
assert.equal(exports.broadcastScale({ width: 3440, height: 1440 }), 3440 / 1920, 'ultrawide preserves aspect ratio');
assert.equal(exports.broadcastScale({ width: 1080, height: 1920 }), 1920 / 1080, 'portrait fits bounding box');
assert.equal(exports.broadcastScale({}), 1);
const settings = { width: 3840, height: 2160 };
sender.track.getSettings = () => settings;
await configureVideoQuality(sender);
settings.width = 1920; settings.height = 1080;
await configureVideoQuality(sender);
assert.equal(parameters.encodings[0].scaleResolutionDownBy, 1, 'recompute after window resize');
let retries = 0;
await configureVideoQuality({ ...sender, async setParameters(next) {
  if (++retries === 1) throw new DOMException('unsupported', 'NotSupportedError');
  assert.equal('degradationPreference' in next, false);
  assert.equal(next.encodings[0].maxFramerate, 60);
}});
assert.equal(retries, 2);
console.log('PASS: 4K preview track preserved, 1080p encoding bound, resize, 60 FPS ceiling, renegotiation and fallback');
