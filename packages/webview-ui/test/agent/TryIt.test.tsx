import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEditorToHost } from '@isar-flow/core';
import { AgentApp } from '../../src/views/agent/AgentApp';
import type { TryItViewState } from '../../src/views/agent/transcript';
import { TRANSCRIPT_FIXTURE } from '../../harness/transcript';
import { agentDoc, fromHost, REVIEWER_AGENT_TEXT } from './helpers';

// A host stand-in that keeps the webview state, installed before src/vscode.ts first asks for the API.
const host = { posted: [] as AgentEditorToHost[], state: undefined as unknown };
window.acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => host.posted.push(message as AgentEditorToHost),
  getState: () => host.state,
  setState: (state: unknown) => {
    host.state = state;
  },
});

const sent = (type: AgentEditorToHost['type']) => host.posted.filter((m) => m.type === type);
const panel = () => within(screen.getByRole('complementary', { name: 'Try it' }));
const log = () => within(screen.getByRole('log', { name: 'Conversation' }));
const composer = () => screen.getByRole('textbox', { name: 'Message to the agent' });
const transcript = () => (host.state as TryItViewState).tryIt?.messages ?? [];

function renderEditor(text = REVIEWER_AGENT_TEXT) {
  render(<AgentApp />);
  fromHost({ type: 'document', doc: agentDoc(text) });
  host.posted.length = 0;
}

function ask(prompt: string) {
  fireEvent.change(composer(), { target: { value: prompt } });
  fireEvent.keyDown(composer(), { key: 'Enter' });
}

beforeEach(() => {
  host.posted.length = 0;
  host.state = undefined;
});
afterEach(cleanup);

describe('Try it', () => {
  it('shows the empty state until something is asked', () => {
    renderEditor();
    expect(screen.getByText('Ask the agent something to see how it responds with the current settings.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear conversation' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends on Enter and adds a new line on Shift+Enter', () => {
    renderEditor();
    fireEvent.change(composer(), { target: { value: 'Review src/app.ts' } });
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });
    expect(sent('tryIt')).toEqual([]);

    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(sent('tryIt')).toEqual([{ type: 'tryIt', prompt: 'Review src/app.ts', history: [] }]);
    expect(composer()).toHaveValue('');
    expect(screen.getByText('Review src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the model')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('streams text, tool rows and the answer meta into the transcript', () => {
    renderEditor();
    ask('Review the voucher changes');
    fromHost({ type: 'tryItEvent', event: { type: 'tool', name: 'readFile', args: '{"path":"src/checkout.ts"}' } });
    expect(screen.getByRole('status', { name: 'Running readFile' })).toBeInTheDocument();
    fromHost({ type: 'tryItEvent', event: { type: 'tool', name: 'readFile', args: '{"path":"src/checkout.ts"}', result: 'a\nb' } });
    fromHost({ type: 'tryItEvent', event: { type: 'text', text: 'Looks ' } });
    fromHost({ type: 'tryItEvent', event: { type: 'text', text: 'good.' } });

    expect(panel().getByText('readFile')).toBeInTheDocument();
    expect(panel().getByText('src/checkout.ts')).toBeInTheDocument();
    expect(panel().getByText('2 lines')).toBeInTheDocument();
    expect(panel().getByText('Looks good.')).toBeInTheDocument();

    fromHost({
      type: 'tryItEvent',
      event: { type: 'done', model: 'vscode/copilot/gpt-4.1', usage: { inputTokens: 4000, outputTokens: 300 } },
    });
    // Model and tokens are separate spans, not one "A · B" string.
    expect(log().getByText('vscode/copilot/gpt-4.1')).toBeInTheDocument();
    expect(log().getByText('4.3k tokens')).toBeInTheDocument();
    expect(log().queryByText(/·/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(transcript().map((entry) => entry.role)).toEqual(['user', 'tool', 'agent']);
  });

  it('stops streaming, tells the host and ignores late events', () => {
    renderEditor();
    ask('Review the voucher changes');
    fromHost({ type: 'tryItEvent', event: { type: 'text', text: 'Partial' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(sent('cancelTryIt')).toHaveLength(1);
    expect(screen.getByText('Stopped')).toBeInTheDocument();

    fromHost({ type: 'tryItEvent', event: { type: 'text', text: ' late' } });
    expect(screen.getByText('Partial')).toBeInTheDocument();
    expect(screen.queryByText('Partial late')).not.toBeInTheDocument();
  });

  it('shows errors and ends the answer', () => {
    renderEditor();
    ask('Hello');
    fromHost({ type: 'tryItEvent', event: { type: 'error', message: 'Cannot reach http://localhost:4000. Is LiteLLM running?' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach http://localhost:4000. Is LiteLLM running?');
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('restores the saved conversation and sends it as history', () => {
    host.state = { tryIt: { messages: TRANSCRIPT_FIXTURE }, keep: 'me' };
    renderEditor();
    expect(screen.getByText('Review the voucher changes in src/checkout.ts')).toBeInTheDocument();
    expect(log().getAllByText('vscode/copilot/gpt-4.1')).toHaveLength(2);

    ask('And the cart?');
    const [message] = sent('tryIt');
    expect(message).toMatchObject({ prompt: 'And the cart?' });
    expect(message.type === 'tryIt' && message.history).toHaveLength(4);
    expect((host.state as { keep?: string }).keep).toBe('me');
    expect(transcript()).toHaveLength(TRANSCRIPT_FIXTURE.length + 1);
  });

  it('clears the conversation', () => {
    host.state = { tryIt: { messages: TRANSCRIPT_FIXTURE } };
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Clear conversation' }));
    expect(screen.getByText('Ask the agent something to see how it responds with the current settings.')).toBeInTheDocument();
    expect(transcript()).toEqual([]);
  });

  it('lights up Send in the river color only once there is something to send', () => {
    renderEditor();
    const send = () => screen.getByRole('button', { name: 'Send' });
    expect(send()).toBeDisabled();
    expect(send()).not.toHaveClass('if-btn--run');
    fireEvent.change(composer(), { target: { value: '   ' } });
    expect(send()).toBeDisabled();
    fireEvent.change(composer(), { target: { value: 'Review src/app.ts' } });
    expect(send()).toBeEnabled();
    expect(send()).toHaveClass('if-btn--run');
  });

  it('shows a tool call and its result on separate lines', () => {
    renderEditor();
    ask('Review');
    fromHost({ type: 'tryItEvent', event: { type: 'tool', name: 'gitDiff', args: '{}', result: '3 files changed' } });
    const result = panel().getByText('3 files changed');
    expect(result).toHaveClass('ag-tool-row__result');
    expect(result.closest('.ag-tool-row__call')).toBeNull();
  });

  it('keeps the indentation of JSON answers line by line, with the text intact', () => {
    renderEditor();
    ask('Review');
    const json = '{\n  "approved": false,\n\t"issues": []\n}';
    fromHost({ type: 'tryItEvent', event: { type: 'text', text: json } });
    const lines = [...document.querySelectorAll<HTMLElement>('.ag-code-line')];
    expect(lines.map((line) => line.textContent)).toEqual(['{', '  "approved": false,', '\t"issues": []', '}']);
    // Each line hangs two columns past its own indent (tabs count as two).
    expect(lines.map((line) => line.style.getPropertyValue('--ag-hang'))).toEqual(['2ch', '4ch', '4ch', '2ch']);
    expect(lines[3].querySelector('.ag-caret')).not.toBeNull();
  });

  it('cannot be used while the agent file is invalid', () => {
    renderEditor(REVIEWER_AGENT_TEXT.replace('temperature: 0.2', 'temperature: 9'));
    expect(composer()).toBeDisabled();
    expect(screen.getByText('Fix the problems in the agent file to try it.')).toBeInTheDocument();
  });
});
