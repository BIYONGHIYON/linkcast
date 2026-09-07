'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { LaserPoint, LaserStroke } from '@/hooks/use-linkcast';

export function LaserOverlay({ ratio, stroke, onSend }: { ratio: number; stroke: LaserStroke | null; onSend: (points: LaserPoint[]) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const active = useRef<{ pointerId: number; points: LaserPoint[] } | null>(null);
  const [draft, setDraft] = useState<LaserPoint[]>([]);
  const [expiredId, setExpiredId] = useState<string | null>(null);
  const fading = useRef<SVGGElement>(null);
  const visible = stroke?.id !== expiredId ? stroke : null;
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.min(width, height * ratio), height: Math.min(height, width / ratio) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ratio]);
  useEffect(() => {
    const animation = fading.current?.animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: 2500, fill: 'forwards' });
    const timer = window.setTimeout(() => setExpiredId(stroke?.id || null), 2500);
    return () => { window.clearTimeout(timer); animation?.cancel(); };
  }, [stroke]);
  const point = (event: { clientX: number; clientY: number }, element: SVGSVGElement): LaserPoint => {
    const rect = element.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const append = (event: PointerEvent<SVGSVGElement>) => {
    const current = active.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const coalesced = (event.nativeEvent as unknown as { getCoalescedEvents?: () => Array<{ clientX: number; clientY: number }> }).getCoalescedEvents?.() || [];
    const samples = [...coalesced, event];
    for (const sample of samples) {
      if (current.points.length >= 512) current.points = current.points.filter((_, i) => i % 2 === 0);
      const next = point(sample, event.currentTarget);
      const last = current.points.at(-1)!;
      if (Math.hypot((next.x - last.x) * size.width, (next.y - last.y) * size.height) >= 1) current.points.push(next);
    }
    setDraft([...current.points]);
  };
  const finish = (pointerId: number) => {
    const current = active.current;
    if (!current || current.pointerId !== pointerId) return;
    // Capture loss often follows pointerup. Clear first so a stroke is sent only once.
    active.current = null;
    onSend(current.points.slice());
    setDraft([]);
  };
  const draw = (points: LaserPoint[]) => {
    if (!points.length) return null;
    const coordinates = points.map(p => `${p.x * size.width},${p.y * size.height}`);
    // A tiny segment renders a tap with the same cap as a line, without a separate head.
    if (points.length === 1) coordinates.push(`${points[0].x * size.width + 0.01},${points[0].y * size.height}`);
    return <g fill="none" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none">
      <polyline points={coordinates.join(' ')} stroke="#ed1c2e" strokeWidth="8" />
      <polyline points={coordinates.join(' ')} stroke="#ffffff" strokeWidth="3.5" />
    </g>;
  };
  return <div ref={root} className="pointer-events-none absolute inset-0 flex items-center justify-center">
    <svg aria-label="누른 채 그린 후 손을 떼면 포인터 공유" className="pointer-events-auto touch-none select-none" style={{ width: size.width, height: size.height, touchAction: 'none', userSelect: 'none' }} viewBox={`0 0 ${size.width} ${size.height}`} 
      onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (active.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { return; }
        active.current = { pointerId: event.pointerId, points: [point(event, event.currentTarget)] };
        setDraft([...active.current.points]);
      }}
      onPointerMove={append}
      onPointerUp={event => {
        if (active.current?.pointerId !== event.pointerId) return;
        append(event);
        finish(event.pointerId);
      }}
      onPointerCancel={event => finish(event.pointerId)}
      onLostPointerCapture={event => finish(event.pointerId)}>
      <rect width="100%" height="100%" fill="transparent" />
      <g key={stroke?.id} ref={fading}>{visible && draw(visible.points)}</g>
      {draw(draft)}
    </svg>
  </div>;
}
