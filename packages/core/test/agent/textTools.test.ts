import { describe, expect, it } from 'vitest';
import { toolSpecsFor } from '../../src/agent';
import { textToolSection, toTextModeMessages, withToolSection } from '../../src/agent/textTools';
import type { ChatMessage } from '../../src/models/types';

describe('textToolSection', () => {
  it('lists every tool with its description and compact parameter schema', () => {
    const specs = toolSpecsFor(['readFile', 'applyPatch']);
    const section = textToolSection(specs);
    for (const spec of specs) {
      expect(section).toContain(`### ${spec.name}\n${spec.description}\n`);
      expect(section).toContain(`Parameters (JSON Schema): ${JSON.stringify(spec.parameters)}`);
    }
  });

  it('explains the call format with real JSON and how to finish', () => {
    const section = textToolSection(toolSpecsFor(['listFiles', 'readFile']));
    expect(section).toContain(
      '<tool_call>{"name": "readFile", "arguments": {"path": "src/app.ts"}}</tool_call>',
    );
    expect(section).toMatch(/several tool calls in one reply/);
    expect(section).toMatch(/answer without a tool call/);
  });

  it('uses the first enabled tool for the example when readFile is not enabled', () => {
    expect(textToolSection(toolSpecsFor(['runCommand']))).toContain(
      '<tool_call>{"name": "runCommand", "arguments": {"command": "npm test"}}</tool_call>',
    );
    expect(textToolSection(toolSpecsFor(['gitDiff']))).toContain(
      '<tool_call>{"name": "gitDiff", "arguments": {}}</tool_call>',
    );
  });

  it('is appended to the system prompt, or stands alone without one', () => {
    const specs = toolSpecsFor(['readFile']);
    expect(withToolSection('Be brief.', specs)).toBe(`Be brief.\n\n${textToolSection(specs)}`);
    expect(withToolSection(undefined, specs)).toBe(textToolSection(specs));
    expect(withToolSection('  ', specs)).toBe(textToolSection(specs));
  });
});

describe('toTextModeMessages', () => {
  it('writes calls as <tool_call> text and results as user messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Fix the bug.' },
      {
        role: 'assistant',
        content: 'Reading both files.',
        toolCalls: [
          { id: 'call_1', name: 'readFile', arguments: '{"path":"a.ts"}' },
          { id: 'call_2', name: 'readFile', arguments: '{"path":"b.ts"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'readFile', content: 'const a = 1;' },
      {
        role: 'tool',
        toolCallId: 'call_2',
        name: 'readFile',
        content: 'File not found: b.ts',
        isError: true,
      },
      { role: 'assistant', content: 'Done.' },
    ];
    expect(toTextModeMessages(messages)).toEqual([
      { role: 'user', content: 'Fix the bug.' },
      {
        role: 'assistant',
        content:
          'Reading both files.\n\n' +
          '<tool_call>{"name": "readFile", "arguments": {"path": "a.ts"}}</tool_call>\n' +
          '<tool_call>{"name": "readFile", "arguments": {"path": "b.ts"}}</tool_call>',
      },
      {
        role: 'user',
        content:
          'Result of readFile (call_1):\nconst a = 1;\n\nError from readFile (call_2):\nFile not found: b.ts',
      },
      { role: 'assistant', content: 'Done.' },
    ]);
    expect(messages[1]).toHaveProperty('toolCalls');
  });

  it('keeps calls without prose and arguments that are not JSON', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'g', name: 'gitDiff', arguments: '' },
          { id: 'x', name: 'readFile', arguments: '{"path": ' },
        ],
      },
    ];
    expect(toTextModeMessages(messages)[0]).toEqual({
      role: 'assistant',
      content:
        '<tool_call>{"name": "gitDiff", "arguments": {}}</tool_call>\n' +
        '<tool_call>{"name": "readFile", "arguments": "{\\"path\\": "}</tool_call>',
    });
  });

  it('leaves conversations without tools unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello', toolCalls: [] },
    ];
    expect(toTextModeMessages(messages)).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ]);
  });
});
