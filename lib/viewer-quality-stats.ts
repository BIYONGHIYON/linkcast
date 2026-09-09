export type ViewerQualityStats = {
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  lossPercent: number;
  jitterMs: number;
  rttMs: number;
  bufferMs: number;
  codec: string;
  path: string;
};

export type ViewerQualityCounter = {
  bytes: number;
  timestamp: number;
  packetsReceived: number;
  packetsLost: number;
  framesDecoded: number;
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
};

type Stat = Record<string, unknown> & { id: string; type: string };

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function string(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export function summarizeViewerStats(
  reports: Iterable<Stat>,
  previous?: ViewerQualityCounter,
): { stats: ViewerQualityStats; counter: ViewerQualityCounter } | null {
  const all = new Map<string, Stat>();
  for (const report of reports) all.set(report.id, report);
  const inbound = [...all.values()].find(report =>
    report.type === 'inbound-rtp' && report.kind === 'video' && report.isRemote !== true,
  );
  if (!inbound) return null;

  const counter: ViewerQualityCounter = {
    bytes: number(inbound.bytesReceived),
    timestamp: number(inbound.timestamp),
    packetsReceived: number(inbound.packetsReceived),
    packetsLost: number(inbound.packetsLost),
    framesDecoded: number(inbound.framesDecoded),
    jitterBufferDelay: number(inbound.jitterBufferDelay),
    jitterBufferEmittedCount: number(inbound.jitterBufferEmittedCount),
  };
  const elapsed = previous ? (counter.timestamp - previous.timestamp) / 1000 : 0;
  const received = previous ? Math.max(0, counter.packetsReceived - previous.packetsReceived) : 0;
  const lost = previous ? Math.max(0, counter.packetsLost - previous.packetsLost) : 0;
  const packets = received + lost;
  const frameDelta = previous ? Math.max(0, counter.framesDecoded - previous.framesDecoded) : 0;
  const emitted = previous ? Math.max(0, counter.jitterBufferEmittedCount - previous.jitterBufferEmittedCount) : 0;
  const bufferDelay = previous ? Math.max(0, counter.jitterBufferDelay - previous.jitterBufferDelay) : 0;
  const codec = typeof inbound.codecId === 'string' ? all.get(inbound.codecId) : undefined;
  const pair = [...all.values()].find(report => report.type === 'candidate-pair' &&
    report.state === 'succeeded' && (report.nominated === true || report.selected === true));
  const local = pair && typeof pair.localCandidateId === 'string' ? all.get(pair.localCandidateId) : undefined;
  const remote = pair && typeof pair.remoteCandidateId === 'string' ? all.get(pair.remoteCandidateId) : undefined;
  const protocol = string(local?.protocol || remote?.protocol).toUpperCase();
  const candidate = string(remote?.candidateType || local?.candidateType);

  return {
    counter,
    stats: {
      width: number(inbound.frameWidth),
      height: number(inbound.frameHeight),
      fps: number(inbound.framesPerSecond) || (elapsed > 0 ? frameDelta / elapsed : 0),
      bitrateMbps: elapsed > 0 ? Math.max(0, counter.bytes - previous!.bytes) * 8 / elapsed / 1_000_000 : 0,
      lossPercent: packets ? lost / packets * 100 : 0,
      jitterMs: number(inbound.jitter) * 1000,
      rttMs: number(pair?.currentRoundTripTime) * 1000,
      bufferMs: emitted ? bufferDelay / emitted * 1000 : 0,
      codec: string(codec?.mimeType).replace('video/', '').toUpperCase(),
      path: [protocol, candidate].filter(Boolean).join(' · '),
    },
  };
}

export function viewerQualityLabel(stats: ViewerQualityStats) {
  if (!stats.width || !stats.height || !stats.bitrateMbps) return '측정 중';
  if (stats.lossPercent >= 1 || stats.jitterMs >= 30 || stats.rttMs >= 150) return '네트워크 변동 감지';
  if (stats.width < 1600 || stats.height < 900) return '수신 해상도 낮아짐';
  if (stats.fps > 0 && stats.fps < 24) return '프레임 저하';
  return '수신 상태 양호';
}
