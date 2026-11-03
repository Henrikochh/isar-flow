import { type RefObject, useEffect, useRef } from 'react';

const TYPING =
  'input:not([type=button]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]';
const POPUPS = '[role=dialog], [role=menu], [role=listbox]';

/** Someone is typing or working in a dialog, menu or list: a new question must not take the focus from them. */
function busy(active: Element | null): boolean {
  if (active === null || active === document.body) return false;
  return active.matches(TYPING) || active.closest(POPUPS) !== null;
}

/**
 * Takes the focus to the first waiting question's default answer when it arrives (so Enter answers with it), to the
 * next question once one is answered, and back to where it was after the last one.
 */
export function useAskFocus(
  containerRef: RefObject<HTMLElement | null>,
  requestId: string | undefined,
): void {
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const active = document.activeElement;
    const container = containerRef.current;
    if (requestId === undefined) {
      const back = returnTo.current;
      returnTo.current = null;
      if (back?.isConnected && (active === null || active === document.body))
        back.focus({ preventScroll: true });
      return;
    }
    if (!container || busy(active)) return;
    const control = container.querySelector<HTMLElement>('[data-ask-primary]');
    if (!control) return;
    if (active instanceof HTMLElement && active !== document.body && !container.contains(active)) {
      returnTo.current = active;
    }
    control.focus({ preventScroll: true });
    if (control instanceof HTMLInputElement) control.select();
  }, [containerRef, requestId]);
}
