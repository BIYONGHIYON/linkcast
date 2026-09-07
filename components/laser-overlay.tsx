'use client';

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { LaserPoint } from '@/hooks/use-linkcast';
import { LASER_DURATION_MS, type VisibleLaserStroke } from '@/hooks/use-laser-strokes';

function FadingStroke({ stroke, children }: { stroke: VisibleLaserStroke; children: ReactNode }) {
  const element = useRef<SVGGElement>(null);
  useEffect(() => {
    const animation = element.current?.animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: LASER_DURATION_MS, fill: 'forwards' });
    if (animation) animation.currentTime = Math.max(0, Date.now() - stroke.shownAt);
    return () => animation?.cancel();
  }, [stroke.id, stroke.shownAt]);
  return <g ref={element} pointerEvents="none">{children}</g>;
}

export function LaserOverlay({ ratio, strokes, onSend }: { ratio: number; strokes: VisibleLaserStroke[]; onSend: (points: LaserPoint[]) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const active = useRef<{ pointerId: number; points: LaserPoint[] } | null>(null);
  const releaseListeners = useRef<(() => void) | null>(null);
  const [draft, setDraft] = useState<LaserPoint[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => () => { releaseListeners.current?.(); active.current = null; }, []);
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
  const point = (event: { clientX: number; clientY: number }, element: SVGSVGElement): LaserPoint => {
    const rect = element.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const appendPoint = (sample: { clientX: number; clientY: number }, element: SVGSVGElement, force = false) => {
    const current = active.current;
    if (!current) return;
    const next = point(sample, element);
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return;
    const last = current.points.at(-1)!;
    if (next.x === last.x && next.y === last.y) return;
    if (!force && Math.hypot((next.x - last.x) * size.width, (next.y - last.y) * size.height) < 1) return;
    if (current.points.length >= 512) current.points = current.points.filter((_, i) => i % 2 === 0);
    current.points.push(next);
  };
  const append = (event: PointerEvent<SVGSVGElement>, force = false) => {
    const current = active.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const coalesced = (event.nativeEvent as unknown as { getCoalescedEvents?: () => Array<{ clientX: number; clientY: number }> }).getCoalescedEvents?.() || [];
    const samples = [...coalesced, event];
    for (const sample of samples) appendPoint(sample, event.currentTarget, force);
    setDraft([...current.points]);
  };
  const finish = (pointerId: number) => {
    const current = active.current;
    if (!current || current.pointerId !== pointerId) return;
    // Capture loss often follows pointerup. Clear first so a stroke is sent only once.
    active.current = null;
    releaseListeners.current?.();
    releaseListeners.current = null;
    onSend(current.points.slice());
    setDraft([]);
  };
  const draw = (points: LaserPoint[]) => {
    if (!points.length) return null;
    const coordinates = points.map(p => `${p.x * size.width},${p.y * size.height}`);
    // A tiny segment renders a tap with the same cap as a line, without a separate head.
    if (points.every(p => p.x === points[0].x && p.y === points[0].y)) coordinates.push(`${points[0].x * size.width + 0.01},${points[0].y * size.height}`);
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
        const element = event.currentTarget;
        const pointerId = event.pointerId;
        active.current = { pointerId: event.pointerId, points: [point(event, event.currentTarget)] };
        setDraft([...active.current.points]);
        // Capture may fail or be released before pointerup, especially on quick gestures.
        // Window listeners keep the release/end point, even outside the video.
        const release = (native: globalThis.PointerEvent) => {
          if (native.pointerId !== pointerId || active.current?.pointerId !== pointerId) return;
          appendPoint(native, element, true);
          finish(pointerId);
        };
        const cancel = (native: globalThis.PointerEvent) => {
          if (native.pointerId === pointerId) finish(pointerId);
        };
        const blur = () => finish(pointerId);
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', cancel);
        window.addEventListener('blur', blur);
        releaseListeners.current = () => {
          window.removeEventListener('pointerup', release);
          window.removeEventListener('pointercancel', cancel);
          window.removeEventListener('blur', blur);
        };
        try { element.setPointerCapture(pointerId); } catch { /* Window release listener remains active. */ }
      }}
      onPointerMove={append}
      onPointerUp={event => {
        if (active.current?.pointerId !== event.pointerId) return;
        append(event, true);
        finish(event.pointerId);
      }}
      onPointerCancel={event => finish(event.pointerId)}
      >
      <rect width="100%" height="100%" fill="transparent" />
      {strokes.map(stroke => <FadingStroke key={stroke.id} stroke={stroke}>{draw(stroke.points)}</FadingStroke>)}
      {draw(draft)}
    </svg>
  </div>;
}
