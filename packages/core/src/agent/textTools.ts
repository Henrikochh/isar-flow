import type { ChatMessage, ToolSpec } from '../models/types';
import type { ToolName } from '../schema/types';
import { BUILTIN_TOOLS, isToolName } from './tools';

const EXAMPLE_ARGS: Record<ToolName, Record<string, unknown>> = {
  readFile: { path: 'src/app.ts' },
  listFiles: { glob: 'src/**/*.ts' },
  searchText: { query: 'TODO' },
  gitDiff: {},
  editFile: { path: 'src/app.ts', oldText: 'old lines', newText: 'new lines' },
  applyPatch: { patch: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n…' },
  writeFile: { path: 'notes.md', content: '# Notes' },
  runCommand: { command: 'npm test' },
};

/**
 * The system-prompt section of text tool mode: how to write a call and every tool with its description and
 * parameter schema. Used for models without native tool calling.
 */
export function textToolSection(specs: readonly ToolSpec[]): string {
  const example = specs.find((spec) => spec.name === 'readFile') ?? specs[0];
  if (!example) return '';
  const exampleArgs = isToolName(example.name) ? EXAMPLE_ARGS[example.name] : {};
  const lines = [
    '## Tools',
    '',
    'You can call the tools below. To call a tool, write the call in exactly this format, with the arguments as ' +
      'a JSON object:',
    formatTextCall(example.name, exampleArgs),
    '',
    'You can make several tool calls in one reply. The results come back in the next message. ' +
      'When you have everything you need, answer without a tool call.',
  ];
  for (const spec of specs) {
    lines.push(
      '',
      `### ${spec.name}`,
      spec.description,
      `Parameters (JSON Schema): ${JSON.stringify(spec.parameters)}`,
    );
  }
  return lines.join('\n');
}

/** The system prompt of text tool mode: the agent's prompt followed by the tool section. */
export function withToolSection(systemPrompt: string | undefined, specs: readonly ToolSpec[]): string {
  const section = textToolSection(specs);
  const prompt = systemPrompt?.trimEnd() ?? '';
  return prompt.trim() === '' ? section : `${prompt}\n\n${section}`;
}

/**
 * The copy of a canonical conversation sent to a model in text tool mode: assistant tool calls become
 * `<tool_call>` text and tool results become user messages. The conversation itself stays canonical, so a
 * fallback model with native tool calling can continue it.
 */
export function toTextModeMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let results: string[] = [];
  const flushResults = () => {
    // Results of one turn go into one message, because some chat templates require alternating roles.
    if (results.length > 0) result.push({ role: 'user', content: results.join('\n\n') });
    results = [];
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      const label = message.isError ? 'Error from' : 'Result of';
      results.push(`${label} ${message.name} (${message.toolCallId}):\n${message.content}`);
      continue;
    }
    flushResults();
    if (message.role !== 'assistant') {
      result.push(message);
      continue;
    }
    const calls = (message.toolCalls ?? []).map((call) =>
      formatTextCall(call.name, rawArguments(call.arguments)),
    );
    const content = [message.content.trim(), calls.join('\n')].filter((part) => part !== '').join('\n\n');
    result.push({ role: 'assistant', content: calls.length > 0 ? content : message.content });
  }
  flushResults();
  return result;
}

/**
 * The user message that asks for a corrected call after an unreadable one. The example shows the tool's required
 * parameters.
 */
export function correctivePrompt(name: ToolName, problem: string): string {
  const required = BUILTIN_TOOLS[name].parameters.required;
  const keys = Array.isArray(required)
    ? required.filter((key): key is string => typeof key === 'string')
    : [];
  const example = formatTextCall(name, Object.fromEntries(keys.map((key) => [key, '…'])));
  return `Your tool call could not be read: ${problem}. Reply with only the tool call, as ${example}.`;
}

/** `<tool_call>{"name": "readFile", "arguments": {"path": "a.ts"}}</tool_call>` */
export function formatTextCall(name: string, args: unknown): string {
  return `<tool_call>{"name": ${JSON.stringify(name)}, "arguments": ${formatArguments(args)}}</tool_call>`;
}

function formatArguments(args: unknown): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return JSON.stringify(args);
  const entries = Object.entries(args).map(
    ([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return `{${entries.join(', ')}}`;
}

/** Arguments of a canonical call: the parsed object, or the raw text when it is not JSON. */
function rawArguments(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
