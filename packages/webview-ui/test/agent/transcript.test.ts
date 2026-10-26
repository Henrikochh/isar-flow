import { describe, expect, it } from 'vitest';
import {
  answerMeta,
  applyTryItEvent,
  conversationHistory,
  groupTurns,
  metaParts,
  readTranscript,
  STOPPED_META,
  stopTurn,
  toolCallDetail,
  type TranscriptEntry,
} from '../../src/views/agent/transcript';
import { TRANSCRIPT_FIXTURE } from '../../harness/transcript';

const user = (text: string): TranscriptEntry => ({ role: 'user', text });

describe('applyTryItEvent', () => {
  it('appends streamed text to the open answer', () => {
    let entries = [user('Hi')];
    entries = applyTryItEvent(entries, { type: 'text', text: 'Hel' });
    entries = applyTryItEvent(entries, { type: 'text', text: 'lo' });
    expect(entries).toEqual([user('Hi'), { role: 'agent', text: 'Hello' }]);
  });

  it('starts a new answer after a tool row so the order stays readable', () => {
    let entries = [user('Hi'), { role: 'agent', text: 'Let me look.' } as TranscriptEntry];
    entries = applyTryItEvent(entries, { type: 'tool', name: 'readFile', args: '{"path":"src/app.ts"}', result: 'a\nb\nc' });
    entries = applyTryItEvent(entries, { type: 'text', text: 'Done.' });
    expect(entries.slice(1)).toEqual([
      { role: 'agent', text: 'Let me look.' },
      { role: 'tool', tool: 'readFile', text: 'src/app.ts', meta: '3 lines' },
      { role: 'agent', text: 'Done.' },
    ]);
  });

  it('completes a pending tool row when the result arrives', () => {
    let entries = applyTryItEvent([user('Hi')], { type: 'tool', name: 'gitDiff', args: '{}' });
    expect(entries[1]).toEqual({ role: 'tool', tool: 'gitDiff', text: '', meta: undefined });
    entries = applyTryItEvent(entries, { type: 'tool', name: 'gitDiff', args: '{}', result: '1 file changed' });
    expect(entries).toHaveLength(2);
    expect(entries[1].meta).toBe('1 file changed');
  });

  it('marks failed tool calls as error rows that keep the tool name', () => {
    const entries = applyTryItEvent([user('Hi')], {
      type: 'tool',
      name: 'editFile',
      args: '{"path":"a.ts"}',
      result: 'oldText was not found',
      isError: true,
    });
    expect(entries[1]).toEqual({ role: 'error', tool: 'editFile', text: 'a.ts', meta: 'failed: oldText was not found' });
  });

  it('closes the answer with the model and token count on done', () => {
    let entries = applyTryItEvent([user('Hi')], { type: 'text', text: 'Hello' });
    entries = applyTryItEvent(entries, { type: 'done', model: 'litellm/gpt-4.1', usage: { inputTokens: 4210, outputTokens: 96 } });
    expect(entries[1]).toEqual({ role: 'agent', text: 'Hello', meta: 'litellm/gpt-4.1 · 4.3k tokens' });
    expect(metaParts(entries[1].meta!)).toEqual(['litellm/gpt-4.1', '4.3k tokens']);
  });

  it('adds a meta-only answer when the turn ended without text', () => {
    let entries = applyTryItEvent([user('Hi')], { type: 'tool', name: 'gitDiff', args: '{}', result: 'clean' });
    entries = applyTryItEvent(entries, { type: 'done', model: 'm/x', usage: { inputTokens: 1, outputTokens: 2 } });
    expect(entries[2]).toEqual({ role: 'agent', text: '', meta: 'm/x · 3 tokens' });
  });

  it('adds error rows', () => {
    const entries = applyTryItEvent([user('Hi')], { type: 'error', message: 'Cannot reach the model' });
    expect(entries[1]).toEqual({ role: 'error', text: 'Cannot reach the model' });
  });
});

describe('transcript helpers', () => {
  it('describes tool calls without repeating the tool name', () => {
    expect(toolCallDetail('readFile', '{"path":"src/a.ts","startLine":3,"endLine":9}')).toBe('src/a.ts:3-9');
    expect(toolCallDetail('gitDiff', '{}')).toBe('');
    expect(toolCallDetail('runCommand', 'npm test')).toBe('npm test');
  });

  it('stops the open answer or adds a stopped marker', () => {
    expect(stopTurn([user('Hi'), { role: 'agent', text: 'Par' }])[1]).toEqual({ role: 'agent', text: 'Par', meta: STOPPED_META });
    expect(stopTurn([user('Hi')])[1]).toEqual({ role: 'agent', text: '', meta: STOPPED_META });
  });

  it('builds the history from prompts and answers only', () => {
    expect(conversationHistory(TRANSCRIPT_FIXTURE)).toEqual([
      { role: 'user', content: 'Review the voucher changes in src/checkout.ts' },
      { role: 'assistant', content: TRANSCRIPT_FIXTURE[3].text },
      { role: 'user', content: 'Which file should the expired-voucher test go into?' },
      { role: 'assistant', content: TRANSCRIPT_FIXTURE[6].text },
    ]);
  });

  it('groups agent rows between user messages into turns', () => {
    expect(groupTurns(TRANSCRIPT_FIXTURE).map((t) => [t.kind, t.start, t.entries.length])).toEqual([
      ['user', 0, 1],
      ['agent', 1, 3],
      ['user', 4, 1],
      ['agent', 5, 2],
    ]);
  });

  it('reads persisted transcripts defensively', () => {
    expect(readTranscript(undefined)).toEqual([]);
    expect(readTranscript({ tryIt: { messages: 'nope' } })).toEqual([]);
    expect(
      readTranscript({ tryIt: { messages: [{ role: 'user', text: 'ok' }, { role: 'bot', text: 'x' }, null, { role: 'agent' }] } }),
    ).toEqual([{ role: 'user', text: 'ok' }]);
  });

  it('formats meta with separate parts', () => {
    expect(metaParts(answerMeta('vscode/copilot/gpt-4.1', { inputTokens: 900, outputTokens: 50 }))).toEqual([
      'vscode/copilot/gpt-4.1',
      '950 tokens',
    ]);
  });
});
