import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOLS,
  checkJsonShape,
  describeToolCall,
  summarizeToolResult,
  TOOL_INFO,
  TOOL_NAMES,
  toolSpecsFor,
} from '../../src/agent';
import type { ToolName } from '../../src/schema/types';

const ALL: ToolName[] = [
  'readFile',
  'listFiles',
  'searchText',
  'gitDiff',
  'editFile',
  'writeFile',
  'runCommand',
];

function params(name: ToolName) {
  return BUILTIN_TOOLS[name].parameters as {
    type: string;
    properties: Record<string, { type: string }>;
    required?: string[];
  };
}

describe('BUILTIN_TOOLS', () => {
  it('covers every tool name with a matching spec', () => {
    expect([...TOOL_NAMES].sort()).toEqual([...ALL].sort());
    for (const name of ALL) {
      expect(BUILTIN_TOOLS[name].name).toBe(name);
      expect(BUILTIN_TOOLS[name].description.length).toBeGreaterThan(40);
      expect(params(name).type).toBe('object');
    }
  });

  it.each([
    ['readFile', { path: 'string', startLine: 'integer', endLine: 'integer' }, ['path']],
    ['listFiles', { glob: 'string' }, []],
    ['searchText', { query: 'string', glob: 'string', isRegex: 'boolean' }, ['query']],
    ['gitDiff', { staged: 'boolean' }, []],
    ['editFile', { path: 'string', oldText: 'string', newText: 'string' }, ['path', 'oldText', 'newText']],
    ['writeFile', { path: 'string', content: 'string' }, ['path', 'content']],
    ['runCommand', { command: 'string', cwd: 'string' }, ['command']],
  ] as const)('%s has the documented parameters', (name, types, required) => {
    const schema = params(name);
    expect(Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, v.type]))).toEqual(types);
    expect(schema.required ?? []).toEqual(required);
  });

  it('mentions workspace-relative paths and limits in descriptions', () => {
    expect(BUILTIN_TOOLS.readFile.description).toMatch(/workspace/i);
    expect(BUILTIN_TOOLS.readFile.description).toMatch(/200 KB/);
    expect(BUILTIN_TOOLS.listFiles.description).toMatch(/500/);
    expect(BUILTIN_TOOLS.searchText.description).toMatch(/200/);
    expect(BUILTIN_TOOLS.editFile.description).toMatch(/exactly once/i);
    expect(BUILTIN_TOOLS.runCommand.description).toMatch(/120 seconds/);
  });

  it('parameter schemas work with checkJsonShape', () => {
    expect(checkJsonShape({ path: 'a.ts', startLine: 1 }, BUILTIN_TOOLS.readFile.parameters)).toEqual([]);
    expect(checkJsonShape({ startLine: 1.5 }, BUILTIN_TOOLS.readFile.parameters)).toEqual([
      'path: missing (expected string)',
      'startLine: expected integer, got number 1.5',
    ]);
  });
});

describe('toolSpecsFor', () => {
  it('returns specs in the given order', () => {
    expect(toolSpecsFor(['gitDiff', 'readFile']).map((s) => s.name)).toEqual(['gitDiff', 'readFile']);
    expect(toolSpecsFor([])).toEqual([]);
  });

  it('drops duplicates and unknown names', () => {
    const names = ['readFile', 'readFile', 'deleteEverything'] as unknown as ToolName[];
    expect(toolSpecsFor(names).map((s) => s.name)).toEqual(['readFile']);
  });
});

describe('TOOL_INFO', () => {
  it('has plain labels and risk levels', () => {
    expect(TOOL_INFO.readFile).toMatchObject({ label: 'Read files', risk: 'read' });
    expect(TOOL_INFO.editFile).toMatchObject({ label: 'Edit files', risk: 'edit' });
    expect(TOOL_INFO.writeFile.risk).toBe('edit');
    expect(TOOL_INFO.runCommand).toMatchObject({ label: 'Run commands', risk: 'command' });
    for (const name of ALL) expect(TOOL_INFO[name].description).toMatch(/\.$/);
  });
});

describe('tool log lines', () => {
  it.each([
    ['readFile', { path: 'src/app.ts' }, 'readFile src/app.ts'],
    ['readFile', { path: 'src/app.ts', startLine: 10, endLine: 40 }, 'readFile src/app.ts:10-40'],
    ['readFile', { path: 'src/app.ts', startLine: 10 }, 'readFile src/app.ts:10-'],
    ['listFiles', {}, 'listFiles'],
    ['listFiles', { glob: 'src/**/*.ts' }, 'listFiles src/**/*.ts'],
    ['searchText', { query: 'TODO', glob: '*.md' }, 'searchText "TODO" in *.md'],
    ['gitDiff', { staged: true }, 'gitDiff --staged'],
    ['editFile', { path: 'a.ts', oldText: 'x', newText: 'y' }, 'editFile a.ts'],
    ['writeFile', { path: 'b.ts', content: '...' }, 'writeFile b.ts'],
    ['runCommand', { command: 'npm test' }, 'runCommand npm test'],
    ['runCommand', { command: 'npm test', cwd: 'packages/core' }, 'runCommand npm test (in packages/core)'],
    ['mystery', { a: 1 }, 'mystery {"a":1}'],
  ])('describes %s %j', (name, args, expected) => {
    expect(describeToolCall(name, args)).toBe(expected);
  });

  it('keeps descriptions on one short line', () => {
    const line = describeToolCall('runCommand', { command: `echo one\necho two ${'x'.repeat(300)}` });
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThanOrEqual(121);
    expect(line.endsWith('…')).toBe(true);
  });

  it('keeps log lines free of carriage returns', () => {
    expect(summarizeToolResult({ content: 'Downloading 50%\r100%' })).toBe('Downloading 50% 100%');
    expect(describeToolCall('runCommand', { command: 'echo a\recho b' })).toBe('runCommand echo a echo b');
  });

  it('summarizes results', () => {
    expect(summarizeToolResult({ content: 'a\nb\nc\n' })).toBe('3 lines');
    expect(summarizeToolResult({ content: 'a\r\nb' })).toBe('2 lines');
    expect(summarizeToolResult({ content: 'Replaced 1 occurrence' })).toBe('Replaced 1 occurrence');
    expect(summarizeToolResult({ content: '' })).toBe('no output');
    expect(summarizeToolResult({ content: 'File not found: x.ts\nmore', isError: true })).toBe(
      'failed: File not found: x.ts',
    );
  });
});
