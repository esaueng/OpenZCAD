import { useEffect, useState } from 'react';

/**
 * True once `flag` has stayed true for `delayMs`, and false the moment it
 * clears. For a busy state that usually resolves within a frame or two:
 * showing it at once flashed the text in and straight back out, which reads
 * as the panel flickering rather than as work being done.
 */
export function useSettledFlag(flag: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!flag) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [flag, delayMs]);

  return flag && settled;
}
