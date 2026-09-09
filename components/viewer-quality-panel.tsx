'use client';

import { Activity } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  summarizeViewerStats,
  viewerQualityLabel,
  type ViewerQualityCounter,
  type ViewerQualityStats,
} from '@/lib/viewer-quality-stats';

const empty: ViewerQualityStats = {
  width: 0, height: 0, fps: 0, bitrateMbps: 0, lossPercent: 0,
  jitterMs: 0, rttMs: 0, bufferMs: 0, codec: '', path: '',
};

export function ViewerQualityPanel({ getConnection }: { getConnection: () => RTCPeerConnection | null }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState(empty);
  const previous = useRef<ViewerQualityCounter | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let busy = false;
    const sample = async () => {
      if (busy) return;
      const connection = getConnection();
      if (!connection || connection.connectionState !== 'connected') return;
      busy = true;
      try {
        const report = await connection.getStats();
        if (cancelled) return;
        const result = summarizeViewerStats(report as unknown as Iterable<Record<string, unknown> & { id: string; type: string }>, previous.current);
        if (!result) return;
        previous.current = result.counter;
        setStats(result.stats);
      } catch { /* Peer may close while collecting a sample. */ }
      finally { busy = false; }
    };
    void sample();
    const timer = window.setInterval(() => void sample(), 1000);
    return () => { cancelled = true; window.clearInterval(timer); previous.current = undefined; };
  }, [getConnection]);

  const label = viewerQualityLabel(stats);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(current => !current)} aria-expanded={open}
        className="flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-black/35 px-3 text-xs font-medium text-white/80 backdrop-blur-md">
        <Activity className="size-3.5" />
        <span className="hidden sm:inline">
          {stats.width ? `${stats.width}×${stats.height} · ${Math.round(stats.fps)}fps` : '품질 측정'}
        </span>
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-30 w-64 rounded-2xl border border-white/10 bg-black/80 p-4 text-xs text-white shadow-xl backdrop-blur-xl">
          <p className="font-medium">{label}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-white/65">
            <dt>해상도</dt><dd className="text-right text-white">{stats.width ? `${stats.width} × ${stats.height}` : '—'}</dd>
            <dt>프레임</dt><dd className="text-right text-white">{stats.fps ? `${stats.fps.toFixed(1)} fps` : '—'}</dd>
            <dt>비트레이트</dt><dd className="text-right text-white">{stats.bitrateMbps ? `${stats.bitrateMbps.toFixed(2)} Mbps` : '—'}</dd>
            <dt>패킷 손실</dt><dd className="text-right text-white">{stats.lossPercent.toFixed(2)}%</dd>
            <dt>지터</dt><dd className="text-right text-white">{stats.jitterMs.toFixed(0)} ms</dd>
            <dt>왕복 지연</dt><dd className="text-right text-white">{stats.rttMs ? `${stats.rttMs.toFixed(0)} ms` : '—'}</dd>
            <dt>재생 버퍼</dt><dd className="text-right text-white">{stats.bufferMs ? `${stats.bufferMs.toFixed(0)} ms` : '—'}</dd>
            <dt>코덱</dt><dd className="text-right text-white">{stats.codec || '—'}</dd>
            <dt>연결 경로</dt><dd className="truncate text-right text-white">{stats.path || '—'}</dd>
          </dl>
          <p className="mt-3 border-t border-white/10 pt-3 leading-5 text-white/45">화질이 흐려지는 순간의 수치를 확인하세요.</p>
        </div>
      )}
    </div>
  );
}
