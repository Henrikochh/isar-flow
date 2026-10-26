export interface Debounced {
  /** (Re)starts the quiet period; `fn` runs once it passes without another trigger. */
  trigger(): void;
  dispose(): void;
}

export function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  return {
    trigger() {
      if (disposed) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, ms);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
