import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../lib/capture-source.ts', import.meta.url), 'utf8');
const exports = {};
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
const { acquireInput } = exports;
let cameraOptions, screenOptions, screenCalls = 0;
const stream = { getAudioTracks: () => [], getVideoTracks: () => [{}] };
const devices = {
  getUserMedia(options) { cameraOptions = options; return Promise.resolve(stream); },
  getDisplayMedia(options) { screenCalls++; screenOptions = options; return Promise.resolve(stream); },
};
assert.equal(await acquireInput(devices, 'capture', 'usb-video', 'usb-audio'), stream);
assert.equal(cameraOptions.video.width.ideal, 3840);
assert.equal(cameraOptions.video.height.max, 2160);
assert.equal(cameraOptions.video.frameRate.max, 60);
assert.equal(cameraOptions.video.deviceId.exact, 'usb-video');
assert.equal(cameraOptions.audio.deviceId.exact, 'usb-audio');
const pending = acquireInput(devices, 'screen', 'usb-video', 'usb-audio');
assert.equal(screenCalls, 1, 'opens picker synchronously in the click gesture');
assert.equal(await pending, stream, 'screen with no audio is valid');
assert.equal(screenOptions.audio, true);
assert.equal(screenOptions.video.width.max, 3840);
assert.equal(screenOptions.video.frameRate.max, 60);
assert.equal('deviceId' in screenOptions.video, false);
assert.equal('displaySurface' in screenOptions.video, false, 'allow program, whole screen and tab');
assert.throws(() => acquireInput({}, 'screen'), /screen_capture_unsupported/);
assert.throws(() => acquireInput(undefined, 'capture'), /capture_unsupported/);
const denied = new Error('cancelled');
await assert.rejects(acquireInput({ getDisplayMedia: () => Promise.reject(denied) }, 'screen'), error => error === denied);
console.log('PASS: USB and screen acquisition, 4K preview constraints, click activation, silent sources and cancellation');
