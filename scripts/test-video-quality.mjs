import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../lib/video-quality.ts', import.meta.url), 'utf8');
const exports = {};
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
const { configureVideoQuality } = exports;
let calls = 0;
const parameters = { degradationPreference: 'maintain-framerate', encodings: [
  { rid: 'main', maxBitrate: 12000000, maxFramerate: 30, scaleResolutionDownBy: 2 },
] };
const sender = { track: { kind: 'video' }, getParameters: () => parameters,
  async setParameters(next) { calls++; assert.equal(next, parameters); } };
await configureVideoQuality(sender);
assert.equal(parameters.degradationPreference, 'maintain-resolution');
assert.equal(parameters.encodings[0].maxFramerate, 60);
assert.equal(parameters.encodings[0].scaleResolutionDownBy, 1);
assert.equal('maxBitrate' in parameters.encodings[0], false);
assert.equal(parameters.encodings[0].rid, 'main');
await configureVideoQuality(sender);
assert.equal(calls, 2, 'same policy on renegotiation');
await configureVideoQuality({ ...sender, getParameters: () => ({ encodings: [] }) });
await configureVideoQuality({ ...sender, track: { kind: 'audio' } });
assert.equal(calls, 2, 'skip audio and unnegotiated encodings');
await assert.rejects(configureVideoQuality({ ...sender, setParameters: async () => { throw new Error('closed'); } }));
console.log('PASS: quality-first policy, uncapped bitrate, original scale, 60 FPS ceiling, renegotiation');
