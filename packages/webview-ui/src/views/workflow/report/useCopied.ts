import { useCallback, useEffect, useRef, useState } from 'react';

/** "Copied" feedback: true for `ms` after `flash()`, then false again. */
export function useCopied(ms = 2000): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), ms);
  }, [ms]);
  return [copied, flash];
}
