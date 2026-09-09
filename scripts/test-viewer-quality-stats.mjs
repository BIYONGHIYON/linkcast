import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../lib/viewer-quality-stats.ts', import.meta.url), 'utf8');
const exports = {};
runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports });
const { summarizeViewerStats, viewerQualityLabel } = exports;
const base = [
  { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 1000, bytesReceived: 1_000_000, packetsReceived: 1000, packetsLost: 2, framesDecoded: 60, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60, jitter: 0.005, jitterBufferDelay: 1, jitterBufferEmittedCount: 60, codecId: 'codec' },
  { id: 'codec', type: 'codec', mimeType: 'video/VP9' },
  { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.04, localCandidateId: 'local', remoteCandidateId: 'remote' },
  { id: 'local', type: 'local-candidate', protocol: 'udp', candidateType: 'host' },
  { id: 'remote', type: 'remote-candidate', protocol: 'udp', candidateType: 'srflx' },
];
const first = summarizeViewerStats(base);
assert.ok(first);
const nextReports = base.map(report => report.id === 'video' ? { ...report, timestamp: 2000, bytesReceived: 2_000_000, packetsReceived: 1998, packetsLost: 4, framesDecoded: 120, jitterBufferDelay: 2.2, jitterBufferEmittedCount: 120 } : report);
const next = summarizeViewerStats(nextReports, first.counter);
assert.ok(next);
assert.equal(next.stats.bitrateMbps, 8);
assert.equal(next.stats.width, 1920);
assert.equal(next.stats.fps, 60);
assert.equal(next.stats.lossPercent, 0.2);
assert.equal(next.stats.jitterMs, 5);
assert.equal(next.stats.rttMs, 40);
assert.ok(Math.abs(next.stats.bufferMs - 20) < 0.001);
assert.equal(next.stats.codec, 'VP9');
assert.equal(next.stats.path, 'UDP · srflx');
assert.equal(viewerQualityLabel(next.stats), '수신 상태 양호');
assert.equal(viewerQualityLabel({ ...next.stats, width: 1280, height: 720 }), '수신 해상도 낮아짐');
assert.equal(viewerQualityLabel({ ...next.stats, lossPercent: 2 }), '네트워크 변동 감지');
assert.equal(summarizeViewerStats([{ id: 'audio', type: 'inbound-rtp', kind: 'audio' }]), null);
console.log('PASS: viewer bitrate, resolution, FPS, loss, jitter, RTT, buffer, codec and route diagnostics');
