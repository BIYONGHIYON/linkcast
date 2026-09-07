'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { LaserPoint, LaserStroke } from '@/hooks/use-linkcast';

export function LaserOverlay({ ratio, stroke, onSend }: { ratio: number; stroke: LaserStroke | null; onSend: (points: LaserPoint[]) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const active = useRef<{ pointerId: number; points: LaserPoint[] } | null>(null);
  const [draft, setDraft] = useState<LaserPoint[]>([]);
  const [expiredId, setExpiredId] = useState<string | null>(null);
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
    const timer = window.setTimeout(() => setExpiredId(stroke?.id || null), 2500);
    return () => window.clearTimeout(timer);
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
      current.points.push(point(sample, event.currentTarget));
    }
    setDraft([...current.points]);
  };
  const draw = (points: LaserPoint[]) => points.length > 0 && <g fill="none" strokeLinecap="round" strokeLinejoin="round">
    <polyline points={points.map(p => `${p.x * size.width},${p.y * size.height}`).join(' ')} stroke="#ed1c2e" strokeWidth="8" />
    <polyline points={points.map(p => `${p.x * size.width},${p.y * size.height}`).join(' ')} stroke="#ffffff" strokeWidth="3.5" />
  </g>;
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
        onSend(active.current.points.slice());
        active.current = null;
        setDraft([]);
      }}
      onPointerCancel={() => { active.current = null; setDraft([]); }}
      onLostPointerCapture={() => { active.current = null; setDraft([]); }}>
      {visible && draw(visible.points)}
      {draw(draft)}
    </svg>
  </div>;
}
