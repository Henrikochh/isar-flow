import { describe, expect, it } from 'vitest';
import { parseTextToolCalls } from '../../src/agent';
import type { ToolName } from '../../src/schema/types';

const ENABLED: ToolName[] = ['readFile', 'listFiles', 'searchText', 'gitDiff', 'writeFile'];
const parse = (text: string, enabled: readonly ToolName[] = ENABLED) => parseTextToolCalls(text, enabled);
const parseJson = (text: string) => parseTextToolCalls(text, ENABLED, { jsonAnswer: true });
const read = (path: string) => ({ name: 'readFile', args: { path } });

describe('parseTextToolCalls: <tool_call> tags', () => {
  it('reads a call in the documented format', () => {
    expect(parse('<tool_call>{"name": "readFile", "arguments": {"path": "src/app.ts"}}</tool_call>')).toEqual(
      {
        calls: [read('src/app.ts')],
        text: '',
      },
    );
  });

  it('reads several calls and keeps the prose without the markup', () => {
    const text = [
      'Let me look at both files.',
      '<tool_call>',
      '{"name": "readFile", "arguments": {"path": "a.ts"}}',
      '</tool_call>',
      '<tool_call>{"name": "readFile", "arguments": {"path": "b.ts"}}</tool_call>',
      '',
      '',
      'Then I will decide.',
    ].join('\n');
    expect(parse(text)).toEqual({
      calls: [read('a.ts'), read('b.ts')],
      text: 'Let me look at both files.\n\nThen I will decide.',
    });
  });

  it('accepts a missing closing tag at the end of the reply', () => {
    expect(parse('Checking.\n<tool_call>{"name": "gitDiff", "arguments": {}}').calls).toEqual([
      { name: 'gitDiff', args: {} },
    ]);
  });

  it('accepts an unclosed tag followed by another tag', () => {
    const text =
      '<tool_call>{"name": "readFile", "arguments": {"path": "a"}}\n' +
      '<tool_call>{"name": "readFile", "arguments": {"path": "b"}}</tool_call>';
    expect(parse(text).calls).toEqual([read('a'), read('b')]);
  });

  it('accepts a code fence, a list of calls and several objects inside the tag', () => {
    expect(
      parse('<tool_call>\n```json\n{"name": "readFile", "arguments": {"path": "a"}}\n```\n</tool_call>')
        .calls,
    ).toEqual([read('a')]);
    expect(
      parse('<tool_call>[{"name": "readFile", "arguments": {"path": "a"}}, {"name": "gitDiff"}]</tool_call>')
        .calls,
    ).toEqual([read('a'), { name: 'gitDiff', args: {} }]);
    expect(
      parse(
        '<tool_call>\n{"name": "readFile", "arguments": {"path": "a"}}\n{"name": "readFile", "arguments": {"path": "b"}}\n</tool_call>',
      ).calls,
    ).toEqual([read('a'), read('b')]);
  });

  it('allows a missing arguments object and extra keys inside a tag', () => {
    expect(parse('<tool_call>{"name": "gitDiff"}</tool_call>').calls).toEqual([
      { name: 'gitDiff', args: {} },
    ]);
    expect(
      parse('<tool_call>{"name": "readFile", "arguments": {"path": "a"}, "reason": "check"}</tool_call>')
        .calls,
    ).toEqual([read('a')]);
    expect(parse('<tool_call>{"name": "gitDiff", "arguments": null}</tool_call>').calls).toEqual([
      { name: 'gitDiff', args: {} },
    ]);
  });

  it('ignores tags that only name unknown or disabled tools', () => {
    const unknown = '<tool_call>{"name": "deleteRepo", "arguments": {}}</tool_call>';
    expect(parse(unknown)).toEqual({ calls: [], text: unknown });
    const disabled = '<tool_call>{"name": "runCommand", "arguments": {"command": "rm -rf /"}}</tool_call>';
    expect(parse(disabled)).toEqual({ calls: [], text: disabled });
    expect(parse('<tool_call>just text</tool_call>')).toEqual({
      calls: [],
      text: '<tool_call>just text</tool_call>',
    });
  });

  it('keeps the enabled calls of a tag that also names an unknown tool', () => {
    const text =
      '<tool_call>[{"name": "deleteRepo"}, {"name": "readFile", "arguments": {"path": "a"}}]</tool_call>';
    expect(parse(text).calls).toEqual([read('a')]);
  });

  it('ignores calls inside reasoning blocks', () => {
    const text =
      '<think>Maybe <tool_call>{"name": "readFile", "arguments": {"path": "x"}}</tool_call>?</think>\n' +
      '<tool_call>{"name": "readFile", "arguments": {"path": "y"}}</tool_call>';
    const result = parse(text);
    expect(result.calls).toEqual([read('y')]);
    expect(result.text).toContain('<think>Maybe <tool_call>');
  });

  it('does not let an unclosed reasoning tag hide calls', () => {
    const text = 'Models use <think> tags. <tool_call>{"name": "gitDiff"}</tool_call>';
    expect(parse(text).calls).toEqual([{ name: 'gitDiff', args: {} }]);
  });

  it('is case-insensitive about the tag name', () => {
    expect(parse('<TOOL_CALL>{"name": "gitDiff"}</TOOL_CALL>').calls).toEqual([
      { name: 'gitDiff', args: {} },
    ]);
  });
});

describe('parseTextToolCalls: call shapes', () => {
  it.each([
    ['name + arguments object', '{"name": "readFile", "arguments": {"path": "a"}}'],
    ['name + arguments as a JSON string', '{"name": "readFile", "arguments": "{\\"path\\": \\"a\\"}"}'],
    ['tool + args', '{"tool": "readFile", "args": {"path": "a"}}'],
    [
      'function wrapper',
      '{"type": "function", "function": {"name": "readFile", "arguments": "{\\"path\\":\\"a\\"}"}}',
    ],
    [
      'function wrapper with an object',
      '{"id": "x1", "function": {"name": "readFile", "arguments": {"path": "a"}}}',
    ],
    ['name + parameters', '{"name": "readFile", "parameters": {"path": "a"}}'],
  ])('reads %s', (_label, json) => {
    expect(parse(`<tool_call>${json}</tool_call>`).calls).toEqual([read('a')]);
    expect(parse(`I will read it. ${json}`)).toEqual({ calls: [read('a')], text: 'I will read it.' });
  });

  it('keeps nested JSON and braces inside argument strings intact', () => {
    const content = '{"a": {"b": [1, 2]}, "c": "}{"}';
    const json = JSON.stringify({ name: 'writeFile', arguments: { path: 'x.json', content } });
    expect(parse(`Writing it now: ${json} Done.`)).toEqual({
      calls: [{ name: 'writeFile', args: { path: 'x.json', content } }],
      text: 'Writing it now:  Done.',
    });
  });

  it('accepts trailing commas and raw line breaks inside strings', () => {
    const text =
      '<tool_call>{"name": "writeFile", "arguments": {"path": "a.md", "content": "line 1\nline 2\tend",},}</tool_call>';
    expect(parse(text).calls).toEqual([
      { name: 'writeFile', args: { path: 'a.md', content: 'line 1\nline 2\tend' } },
    ]);
  });
});

describe('parseTextToolCalls: fenced blocks and bare JSON', () => {
  it('reads a json fence and a tool_call fence', () => {
    const json = 'I need the file.\n```json\n{"name": "readFile", "arguments": {"path": "a"}}\n```';
    expect(parse(json)).toEqual({ calls: [read('a')], text: 'I need the file.' });
    const labelled = '```tool_call\n{"name": "gitDiff"}\n```';
    expect(parse(labelled).calls).toEqual([{ name: 'gitDiff', args: {} }]);
  });

  it('reads a bare list of calls', () => {
    const text =
      '[{"name": "readFile", "arguments": {"path": "a"}}, {"name": "readFile", "arguments": {"path": "b"}}]';
    expect(parse(text)).toEqual({ calls: [read('a'), read('b')], text: '' });
  });

  it('leaves JSON that is not exactly a call shape alone', () => {
    for (const text of [
      '{"approved": true, "issues": []}',
      'Use {"name": "readFile"} to read files.',
      '{"name": "readFile", "arguments": {"path": "a"}, "reason": "check"}',
      '{"plan": {"name": "readFile", "arguments": {"path": "a"}}}',
      '[{"name": "readFile", "arguments": {"path": "a"}}, {"note": 1}]',
      '```json\n{"name": "Ada", "arguments": {"x": 1}}\n```',
      'Set it to {"name": "deleteRepo", "arguments": {}} later.',
    ]) {
      expect(parse(text)).toEqual({ calls: [], text });
    }
  });

  it('finds nothing when no tools are enabled', () => {
    const text = '<tool_call>{"name": "readFile", "arguments": {"path": "a"}}</tool_call>';
    expect(parse(text, [])).toEqual({ calls: [], text });
  });

  it('does not read the same call twice from a tag and its fence', () => {
    const text = '<tool_call>\n```json\n{"name": "readFile", "arguments": {"path": "a"}}\n```\n</tool_call>';
    expect(parse(text).calls).toHaveLength(1);
  });
});

describe('parseTextToolCalls: malformed calls', () => {
  it('reports single-quoted pseudo JSON for an enabled tool', () => {
    const result = parse("<tool_call>{'name': 'readFile', 'arguments': {'path': 'a.ts'}}</tool_call>");
    expect(result.calls).toEqual([]);
    expect(result.malformed?.name).toBe('readFile');
    expect(result.malformed?.problem).toMatch(/^the call of readFile is not valid JSON \(.+\)$/);
  });

  it('reports arguments that are not a JSON object', () => {
    for (const args of ['"src/a.ts"', '["a"]', '42', '"{\\"path\\": "']) {
      const result = parse(`<tool_call>{"name": "readFile", "arguments": ${args}}</tool_call>`);
      expect(result.malformed).toEqual({
        name: 'readFile',
        problem: 'the arguments of readFile are not a JSON object',
      });
    }
  });

  it('reports a call shape with bad arguments outside tags too', () => {
    expect(parse('{"name": "readFile", "arguments": "a.ts"}').malformed).toEqual({
      name: 'readFile',
      problem: 'the arguments of readFile are not a JSON object',
    });
  });

  it('names the tool when a tag holds broken text that mentions it', () => {
    expect(parse('<tool_call>readFile src/a.ts</tool_call>').malformed?.name).toBe('readFile');
    expect(parse('<tool_call>{"tool": "searchText", "args": {"query": "a"</tool_call>').malformed?.name).toBe(
      'searchText',
    );
  });

  it('ignores broken text in a tag that names no enabled tool', () => {
    expect(parse("<tool_call>{'name': 'deleteRepo'}</tool_call>").malformed).toBeUndefined();
  });
});

describe('parseTextToolCalls: JSON answers', () => {
  it('reads a whole answer that is exactly a call', () => {
    expect(parseJson('{"name": "readFile", "arguments": {"path": "a"}}').calls).toEqual([read('a')]);
    expect(parseJson('```json\n{"name": "readFile", "arguments": {"path": "a"}}\n```').calls).toEqual([
      read('a'),
    ]);
    expect(parseJson(' [{"tool": "readFile", "args": {"path": "a"}}] ').calls).toEqual([read('a')]);
  });

  it('still reads <tool_call> tags', () => {
    expect(parseJson('Checking first. <tool_call>{"name": "gitDiff"}</tool_call>').calls).toEqual([
      { name: 'gitDiff', args: {} },
    ]);
  });

  it('does not read calls from answers that are more than a call', () => {
    for (const text of [
      '{"approved": true, "issues": []}',
      'Here: {"name": "readFile", "arguments": {"path": "a"}}',
      '{"name": "readFile", "arguments": {"path": "a"}, "approved": true}',
      '{"name": "Ada Lovelace", "arguments": {"born": 1815}}',
      '{"name": "readFile"}',
    ]) {
      expect(parseJson(text).calls).toEqual([]);
      expect(parseJson(text).malformed).toBeUndefined();
    }
  });

  it('reports a whole answer that is a call with bad arguments', () => {
    expect(parseJson('{"name": "readFile", "arguments": "a.ts"}').malformed?.name).toBe('readFile');
  });
});
