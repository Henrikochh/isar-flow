/**
 * Lenient view of an agent file for the form. When the YAML breaks the schema the host still sends the
 * raw mapping, so every field is read defensively and wrong types fall back to empty values.
 */
import type { AgentDefinition, Diagnostic, MemoryMode, PermissionLevel } from '@isar-flow/core';

/** Posts `{ type: 'update', set, unset }` for top-level keys of the agent file. */
export type UpdateAgent = (set: Partial<AgentDefinition>, unset?: (keyof AgentDefinition)[]) => void;

export interface AgentForm {
  name: string;
  description: string;
  model: string;
  fallbackModels: string[];
  systemPrompt: string;
  /** Numbers are kept as text so the inputs can show what the file contains, even when it is invalid. */
  temperature: string;
  maxTokens: string;
  maxTurns: string;
  tools: string[];
  /** As written in the file (undefined = automatic); an unknown value is shown as it is, next to its error. */
  toolMode: string | undefined;
  edits: PermissionLevel | undefined;
  commands: PermissionLevel | undefined;
  /** Project memory access as written; undefined reads the memory (the default). */
  memory: MemoryMode | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function level(value: unknown): PermissionLevel | undefined {
  return value === 'none' || value === 'ask' || value === 'auto' ? value : undefined;
}

export function readAgentForm(agent: AgentDefinition | null): AgentForm {
  const raw: Record<string, unknown> = isRecord(agent) ? (agent as unknown as Record<string, unknown>) : {};
  const permissions = isRecord(raw.permissions) ? raw.permissions : {};
  return {
    name: text(raw.name),
    description: text(raw.description),
    model: text(raw.model),
    fallbackModels: strings(raw.fallbackModels),
    systemPrompt: text(raw.systemPrompt),
    temperature: text(raw.temperature),
    maxTokens: text(raw.maxTokens),
    maxTurns: text(raw.maxTurns),
    tools: strings(raw.tools),
    toolMode: typeof raw.toolMode === 'string' ? raw.toolMode : undefined,
    edits: level(permissions.edits),
    commands: level(permissions.commands),
    memory: raw.memory === 'none' || raw.memory === 'read' || raw.memory === 'write' ? raw.memory : undefined,
  };
}

/** Field a diagnostic belongs to: the top-level key, or `permissions.<key>` for permission levels. */
function fieldKey(diagnostic: Diagnostic): string | undefined {
  const [first, second] = diagnostic.path ?? [];
  if (typeof first !== 'string') return undefined;
  if (first === 'permissions' && typeof second === 'string') return `permissions.${second}`;
  return first;
}

export interface FieldIssues {
  /** First error or warning message for a field. */
  message(key: string): { error?: string; warning?: string };
}

export function fieldIssues(diagnostics: readonly Diagnostic[]): FieldIssues {
  const byKey = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const key = fieldKey(diagnostic);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), diagnostic]);
  }
  return {
    message(key) {
      const list = byKey.get(key) ?? [];
      const error = list.find((d) => d.severity === 'error')?.message;
      const warning = error ? undefined : list.find((d) => d.severity !== 'error')?.message;
      return { error, warning };
    },
  };
}

/** Diagnostic shown in the invalid-file banner: the first error, else the first diagnostic. */
export function leadingDiagnostic(diagnostics: readonly Diagnostic[]): Diagnostic | undefined {
  return diagnostics.find((d) => d.severity === 'error') ?? diagnostics[0];
}

/** Parses a number field; '' clears the key, anything unparsable is reported instead of written. */
export function parseNumberInput(
  value: string,
  integer: boolean,
): { ok: true; value: number | undefined } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  const number = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number))) return { ok: false };
  return { ok: true, value: number };
}
