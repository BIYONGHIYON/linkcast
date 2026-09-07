'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LaserStroke } from './use-linkcast';

export const LASER_DURATION_MS = 2500;
export type VisibleLaserStroke = LaserStroke & { shownAt: number };

export function useLaserStrokes() {
  const [strokes, setStrokes] = useState<VisibleLaserStroke[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const clear = useCallback(() => {
    timers.current.forEach(timer => clearTimeout(timer));
    timers.current.clear();
    setStrokes([]);
  }, []);
  const add = useCallback((stroke: LaserStroke) => {
    if (timers.current.has(stroke.id)) return;
    const shownAt = Date.now();
    setStrokes(current => [...current.filter(s => shownAt - s.shownAt < LASER_DURATION_MS), { ...stroke, shownAt }]);
    timers.current.set(stroke.id, setTimeout(() => {
      timers.current.delete(stroke.id);
      setStrokes(current => current.filter(s => s.id !== stroke.id));
    }, LASER_DURATION_MS));
  }, []);
  useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(timer => clearTimeout(timer)); pending.clear(); };
  }, []);
  return { strokes, add, clear };
}
