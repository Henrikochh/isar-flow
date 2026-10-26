import { describe, expect, it } from 'vitest';
import { applyAgentUpdate, parseAgentText } from '../../src/yaml';

const lines = (...l: string[]) => l.join('\n') + '\n';

const reviewer = lines(
  '# Strict reviewer used by the review loop.',
  'name: Reviewer',
  'model: litellm/claude-sonnet # fast enough',
  'systemPrompt: |',
  '  You are a strict senior reviewer.',
  '  Answer with JSON only.',
  '',
  'tools: [readFile, gitDiff]',
  'permissions: { edits: none, commands: none } # none | ask | auto',
);

function update(text: string, set: Record<string, unknown>, unset?: string[]): string {
  const result = applyAgentUpdate(text, set, unset);
  if (result.error) throw new Error(result.error);
  return result.text;
}

describe('applyAgentUpdate', () => {
  it('updates scalars in place, keeping comments and untouched formatting', () => {
    const out = update(reviewer, { model: 'vscode/copilot/gpt-4.1' });
    expect(out).toBe(reviewer.replace('litellm/claude-sonnet', 'vscode/copilot/gpt-4.1'));
  });

  it('inserts new keys in canonical order', () => {
    const out = update(reviewer, { maxTurns: 10, description: 'Finds bugs', temperature: 0.2 });
    expect(out).toBe(
      reviewer
        .replace('name: Reviewer\n', 'name: Reviewer\ndescription: Finds bugs\n')
        .replace('  Answer with JSON only.\n', '  Answer with JSON only.\ntemperature: 0.2\nmaxTurns: 10\n'),
    );
  });

  it('keeps the block-literal style when the system prompt changes', () => {
    const out = update(reviewer, { systemPrompt: 'Be strict.\nAnswer with JSON only.\n' });
    expect(out).toContain('systemPrompt: |\n  Be strict.\n  Answer with JSON only.\n');
    expect(parseAgentText(out).agent?.systemPrompt).toBe('Be strict.\nAnswer with JSON only.\n');
  });

  it('updates lists and nested mappings in place', () => {
    const out = update(reviewer, {
      tools: ['readFile', 'listFiles', 'gitDiff'],
      permissions: { edits: 'ask', commands: 'none' },
    });
    expect(out).toContain('tools: [readFile, listFiles, gitDiff]\n');
    expect(out).toContain('permissions: { edits: ask, commands: none } # none | ask | auto\n');
  });

  it('writes new lists and permission maps compactly', () => {
    const out = update('name: A\nmodel: x/y\n', {
      fallbackModels: ['vscode/copilot/gpt-4.1'],
      tools: ['readFile'],
      permissions: { edits: 'auto', commands: 'ask' },
    });
    expect(out).toBe(
      lines(
        'name: A',
        'model: x/y',
        'fallbackModels: [vscode/copilot/gpt-4.1]',
        'tools: [readFile]',
        'permissions: { edits: auto, commands: ask }',
      ),
    );
  });

  it('removes keys listed in unset and keys set to undefined', () => {
    const out = update(reviewer, { tools: undefined }, ['permissions']);
    expect(out).not.toContain('tools:');
    expect(out).not.toContain('permissions:');
    expect(out).toContain('# Strict reviewer used by the review loop.');
  });

  it('creates the mapping for empty or blank files, in canonical order', () => {
    const expected = lines(
      'name: Helper',
      'model: vscode/copilot/gpt-4.1',
      'systemPrompt: |-',
      '  Line one',
      '  Line two',
    );
    const set = { systemPrompt: 'Line one\nLine two', model: 'vscode/copilot/gpt-4.1', name: 'Helper' };
    expect(update('', set)).toBe(expected);
    expect(update('  \n\n', set)).toBe(expected);
    expect(update('# helper agent\n', { name: 'Helper' })).toBe('# helper agent\n\nname: Helper\n');
  });

  it('keeps a byte order mark and CRLF line endings', () => {
    const text = '﻿name: A\r\nmodel: a/b\r\n';
    expect(update(text, { name: 'B' })).toBe('﻿name: B\r\nmodel: a/b\r\n');
  });

  it('leaves empty and comment-only files alone when nothing is set', () => {
    expect(applyAgentUpdate('', {})).toEqual({ text: '' });
    expect(applyAgentUpdate('# helper agent\n', {}, ['tools'])).toEqual({ text: '# helper agent\n' });
  });

  it('refuses broken or non-mapping files and returns them unchanged', () => {
    const broken = 'name: "x\n';
    const result = applyAgentUpdate(broken, { name: 'y' });
    expect(result.text).toBe(broken);
    expect(result.error).toMatch(/^The agent file has YAML errors/);
    expect(applyAgentUpdate('- a\n', { name: 'y' }).error).toMatch(/mapping/);
  });

  it('produces files that still parse as valid agents', () => {
    const out = update(reviewer, { name: 'Strict reviewer', maxTokens: 4000 });
    const parsed = parseAgentText(out);
    expect(parsed.valid).toBe(true);
    expect(parsed.agent).toMatchObject({
      name: 'Strict reviewer',
      maxTokens: 4000,
      tools: ['readFile', 'gitDiff'],
    });
  });
});
