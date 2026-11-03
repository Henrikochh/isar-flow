import type { LiveSource } from './LiveDataProvider';

/** How live values name the run they come from; a simulation says so, so mock values never pass for real ones. */
export function liveRunName(source: LiveSource, simulated: boolean | undefined): string {
  if (source === 'shown') return simulated ? 'This simulation' : 'This run';
  return simulated ? 'Last simulation' : 'Last run';
}
