import { splitLines } from '../expr';
import type { ToolSpec } from '../models/types';
import type { ToolName } from '../schema/types';
import type { ToolResult } from './types';

export const TOOL_NAMES: readonly ToolName[] = [
  'readFile',
  'listFiles',
  'searchText',
  'gitDiff',
  'editFile',
  'writeFile',
  'runCommand',
];

const PATH_HINT = 'Workspace-relative path with forward slashes, e.g. "src/app.ts".';
const GLOB_HINT = 'Workspace-relative glob, e.g. "src/**/*.ts".';

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

export const BUILTIN_TOOLS: Record<ToolName, ToolSpec> = {
  readFile: {
    name: 'readFile',
    description:
      'Read a text file from the workspace. Paths are relative to the workspace root; files outside it cannot be read. ' +
      'Pass startLine and endLine (1-based, inclusive) to read part of a large file. Output is truncated after 200 KB.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: PATH_HINT },
        startLine: { type: 'integer', minimum: 1, description: 'First line to read (1-based, inclusive).' },
        endLine: { type: 'integer', minimum: 1, description: 'Last line to read (1-based, inclusive).' },
      },
      ['path'],
    ),
  },
  listFiles: {
    name: 'listFiles',
    description:
      'List workspace files whose workspace-relative path matches a glob pattern, e.g. "src/**/*.ts". ' +
      'Without a glob, lists all files. Returns at most 500 paths, so use a narrow glob in large workspaces.',
    parameters: objectSchema({ glob: { type: 'string', description: GLOB_HINT } }, []),
  },
  searchText: {
    name: 'searchText',
    description:
      'Search workspace files for text and return matching lines as "path:line: text" (at most 200 matches). ' +
      'The query is plain text unless isRegex is true (JavaScript regular expression syntax). ' +
      'Use glob to limit the search to some files, e.g. "src/**/*.ts".',
    parameters: objectSchema(
      {
        query: { type: 'string', description: 'Text or regular expression to search for.' },
        glob: { type: 'string', description: GLOB_HINT },
        isRegex: { type: 'boolean', description: 'Treat query as a regular expression (default false).' },
      },
      ['query'],
    ),
  },
  gitDiff: {
    name: 'gitDiff',
    description:
      'Show the uncommitted changes of the workspace repository as unified "git diff" output. ' +
      'Set staged to true to show only staged changes.',
    parameters: objectSchema(
      {
        staged: {
          type: 'boolean',
          description: 'Show staged changes instead of unstaged ones (default false).',
        },
      },
      [],
    ),
  },
  editFile: {
    name: 'editFile',
    description:
      'Edit an existing workspace file by replacing oldText with newText. oldText must match the current file content ' +
      'exactly, including whitespace and indentation, and must occur exactly once; include a few surrounding lines ' +
      'to make it unique. Read the file first. To create a file or replace all of it, use writeFile.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: PATH_HINT },
        oldText: {
          type: 'string',
          description: 'Exact text to replace; must occur exactly once in the file.',
        },
        newText: { type: 'string', description: 'Replacement text.' },
      },
      ['path', 'oldText', 'newText'],
    ),
  },
  writeFile: {
    name: 'writeFile',
    description:
      'Create a workspace file, or overwrite an existing one completely, with the given content. ' +
      'Paths are relative to the workspace root. Prefer editFile for small changes to existing files.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: PATH_HINT },
        content: { type: 'string', description: 'Complete new file content.' },
      },
      ['path', 'content'],
    ),
  },
  runCommand: {
    name: 'runCommand',
    description:
      'Run a shell command in the workspace and return its exit code and output, e.g. "npm test". ' +
      'Commands are stopped after 120 seconds, so do not start servers, watchers or interactive programs.',
    parameters: objectSchema(
      {
        command: { type: 'string', description: 'Command line to run.' },
        cwd: {
          type: 'string',
          description: 'Workspace-relative working folder (default: the workspace root).',
        },
      },
      ['command'],
    ),
  },
};

export interface ToolInfo {
  label: string;
  description: string;
  risk: 'read' | 'edit' | 'command';
}

export const TOOL_INFO: Record<ToolName, ToolInfo> = {
  readFile: { label: 'Read files', description: 'Read the content of files in the workspace.', risk: 'read' },
  listFiles: {
    label: 'List files',
    description: 'Find files in the workspace by name pattern.',
    risk: 'read',
  },
  searchText: {
    label: 'Search text',
    description: 'Search the workspace for text or a regular expression.',
    risk: 'read',
  },
  gitDiff: {
    label: 'View git changes',
    description: 'See uncommitted changes in the git repository.',
    risk: 'read',
  },
  editFile: {
    label: 'Edit files',
    description: 'Change parts of existing files in the workspace.',
    risk: 'edit',
  },
  writeFile: {
    label: 'Write files',
    description: 'Create files or replace their whole content.',
    risk: 'edit',
  },
  runCommand: {
    label: 'Run commands',
    description: 'Run shell commands such as tests or builds.',
    risk: 'command',
  },
};

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(BUILTIN_TOOLS, name);
}

/** Specs for the given tools in their order, without duplicates or unknown names. */
export function toolSpecsFor(names: readonly ToolName[]): ToolSpec[] {
  const unique = [...new Set(names)].filter(isToolName);
  return unique.map((name) => BUILTIN_TOOLS[name]);
}

const MAX_LINE = 120;

function oneLine(text: string, max: number): string {
  // A lone \r (progress output) would let a terminal overwrite the line, so it counts as a break too.
  const flat = text.replace(/\s*[\r\n]\s*/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** One-line description of a tool call for logs, e.g. `readFile src/app.ts:10-40`. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  let detail: string;
  switch (name) {
    case 'readFile': {
      const start = typeof args.startLine === 'number' ? args.startLine : undefined;
      const end = typeof args.endLine === 'number' ? args.endLine : undefined;
      const range = start !== undefined || end !== undefined ? `:${start ?? 1}-${end ?? ''}` : '';
      detail = str(args.path) ? `${str(args.path)}${range}` : '';
      break;
    }
    case 'listFiles':
      detail = str(args.glob) ?? '';
      break;
    case 'searchText':
      detail = str(args.query)
        ? `${JSON.stringify(args.query)}${str(args.glob) ? ` in ${str(args.glob)}` : ''}`
        : '';
      break;
    case 'gitDiff':
      detail = args.staged === true ? '--staged' : '';
      break;
    case 'editFile':
    case 'writeFile':
      detail = str(args.path) ?? '';
      break;
    case 'runCommand':
      detail = str(args.command)
        ? `${str(args.command)}${str(args.cwd) ? ` (in ${str(args.cwd)})` : ''}`
        : '';
      break;
    default:
      detail = Object.keys(args).length > 0 ? JSON.stringify(args) : '';
  }
  return oneLine(detail ? `${name} ${detail}` : name, MAX_LINE);
}

/** Short outcome of a tool call for logs: `120 lines`, the single output line, or `failed: …`. */
export function summarizeToolResult(result: ToolResult): string {
  const lines = splitLines(result.content);
  if (result.isError) return `failed: ${oneLine(lines.find((l) => l.trim() !== '') ?? 'unknown error', 100)}`;
  if (lines.length === 0) return 'no output';
  if (lines.length === 1) return oneLine(lines[0], 80);
  return `${lines.length} lines`;
}
