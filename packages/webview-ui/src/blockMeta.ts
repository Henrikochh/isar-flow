import type { StepType } from '@isar-flow/core';

/** Codicon per block type. */
export const BLOCK_ICONS: Record<StepType, string> = {
  agent: 'sparkle',
  console: 'terminal',
  loop: 'sync',
  if: 'repo-forked',
  break: 'debug-step-out',
  stop: 'debug-stop',
  approval: 'verified',
  ask: 'comment-discussion',
};

const AGENT_PALETTE: StepType[] = ['agent', 'loop', 'if', 'approval', 'stop', 'console'];

/** Picks a palette color (expressed as a block type) for an agent avatar, stable per id. */
export function agentColorType(id: string): StepType {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AGENT_PALETTE[Math.abs(hash) % AGENT_PALETTE.length];
}

export function initialsOf(name: string): string {
  const words = name
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
