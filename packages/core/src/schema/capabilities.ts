import { isToolName, TOOL_INFO } from '../agent/tools';
import type { AgentPermissions, PermissionLevel } from './types';

export type AgentCapabilityKind = 'read-only' | 'edits' | 'commands';

/** One capability badge of an agent: sidebar rows, the agent editor header and agent block cards. */
export interface AgentCapability {
  kind: AgentCapabilityKind;
  /** "Read-only", "Edits files" or "Runs commands". */
  label: string;
  /** Effective permission level of edits and commands ('ask' when the file sets none). */
  level?: Exclude<PermissionLevel, 'none'>;
  /** Badge text with the level, e.g. "Edits files (asks)" or "Runs commands (auto)". */
  text: string;
  /** Codicon name. */
  icon: string;
  /** Tooltip: what the agent may do. */
  title: string;
}

/** The tools and permissions of an agent file, inline agent settings or an agent summary (lenient). */
export interface CapabilitySource {
  tools?: readonly unknown[];
  permissions?: AgentPermissions;
}

const LEVEL_TEXT = { ask: 'asks', auto: 'auto' } as const;

const GROUPS = [
  {
    kind: 'edits',
    risk: 'edit',
    setting: 'edits',
    label: 'Edits files',
    icon: 'edit',
    titles: { ask: 'Changes files after you allow it.', auto: 'Changes files without asking.' },
  },
  {
    kind: 'commands',
    risk: 'command',
    setting: 'commands',
    label: 'Runs commands',
    icon: 'terminal',
    titles: {
      ask: 'Runs shell commands after you allow it.',
      auto: 'Runs shell commands without asking.',
    },
  },
] as const;

function effectiveLevel(value: unknown): PermissionLevel {
  return value === 'none' || value === 'auto' ? value : 'ask';
}

/**
 * What an agent may do, as badges: "Edits files" / "Runs commands" with the effective permission level, or a
 * single "Read-only" badge. Tools whose permission is "none" do not count; unknown tool names are ignored.
 */
export function agentCapabilities(source: CapabilitySource | null | undefined): AgentCapability[] {
  const tools = Array.isArray(source?.tools)
    ? source.tools.filter((t): t is string => typeof t === 'string')
    : [];
  const known = tools.filter(isToolName);
  const badges: AgentCapability[] = [];
  for (const group of GROUPS) {
    if (!known.some((tool) => TOOL_INFO[tool].risk === group.risk)) continue;
    const level = effectiveLevel(source?.permissions?.[group.setting]);
    if (level === 'none') continue;
    badges.push({
      kind: group.kind,
      label: group.label,
      level,
      text: `${group.label} (${LEVEL_TEXT[level]})`,
      icon: group.icon,
      title: group.titles[level],
    });
  }
  if (badges.length > 0) return badges;
  const reads = known.some((tool) => TOOL_INFO[tool].risk === 'read');
  return [
    {
      kind: 'read-only',
      label: 'Read-only',
      text: 'Read-only',
      icon: 'eye',
      title: reads
        ? 'Can look at files but not change them or run commands.'
        : 'Only answers: it has no tools to look at files.',
    },
  ];
}
