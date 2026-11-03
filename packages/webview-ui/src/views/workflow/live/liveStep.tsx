import { createContext, type ReactNode, useContext } from 'react';

const LiveStepContext = createContext<string | null>(null);

/**
 * The block whose settings are shown: template fields inside read live values in its scope (`loop.*`). The
 * settings panels render their fields through shared field components, so the id travels by context.
 */
export function LiveStepProvider({ stepId, children }: { stepId: string; children: ReactNode }) {
  return <LiveStepContext.Provider value={stepId}>{children}</LiveStepContext.Provider>;
}

export function useLiveStepId(): string | null {
  return useContext(LiveStepContext);
}
