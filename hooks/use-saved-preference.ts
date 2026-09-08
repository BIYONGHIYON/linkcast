'use client';

import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

// Restore after hydration; never overwrite a saved value with SSR defaults.
export function useSavedPreference<T extends string | number>(
  key: string, value: T, setValue: Dispatch<SetStateAction<T>>,
  valid: (value: unknown) => value is T,
) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        const parsed: unknown = JSON.parse(stored);
        if (valid(parsed)) setValue(parsed);
      }
    } catch { /* Storage may be blocked or contain invalid data. */ }
    // One hydration-time render is required to read browser-only storage safely.
    // oxlint-disable-next-line react/react-compiler
    setLoaded(true);
  }, [key, setValue, valid]);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep session settings working. */ }
  }, [key, value, loaded]);
}

export const validDevice = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024;
export const validVolume = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000;
export const validSensitivity = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
