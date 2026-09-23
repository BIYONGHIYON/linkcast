import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

globalThis.MediaStream = class {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
};

const source = await readFile(new URL('../lib/remote-stream.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { mergeRemoteStream } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const audio = { id: 'capture-audio', kind: 'audio' };
const video = { id: 'capture-video', kind: 'video' };
const audioFirst = mergeRemoteStream(null, audio);
assert.equal(audioFirst.getVideoTracks().length, 0);
const withVideo = mergeRemoteStream(audioFirst, video);
assert.notEqual(withVideo, audioFirst);
assert.deepEqual(withVideo.getTracks(), [audio, video]);
assert.equal(mergeRemoteStream(withVideo, video), withVideo);

const videoFirst = mergeRemoteStream(null, video);
const withAudio = mergeRemoteStream(videoFirst, audio);
assert.notEqual(withAudio, videoFirst);
assert.deepEqual(withAudio.getTracks(), [video, audio]);
console.log('PASS: audio-first and video-first track arrival publish new stream instances without duplicating tracks');
