import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { RunView } from '@isar-flow/core';
import { registerLiveValueHover } from '../../../src/liveValues/hoverProvider';
import { fakeServices } from '../editors/fakes';

// The unit-test stub of vscode has no hover API; these stand in for it.
const api = vi.hoisted(() => {
  class MarkdownString {
    isTrusted: boolean | undefined = undefined;
    supportHtml: boolean | undefined = undefined;
    constructor(readonly value: string) {}
  }
  class Hover {
    constructor(
      readonly contents: MarkdownString,
      readonly range: unknown,
    ) {}
  }
  const providers: { selector: unknown; provider: { provideHover: (...args: unknown[]) => unknown } }[] = [];
  const dispose = vi.fn();
  return { MarkdownString, Hover, providers, dispose };
});

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MarkdownString: api.MarkdownString,
  Hover: api.Hover,
  languages: {
    registerHoverProvider: (selector: unknown, provider: (typeof api.providers)[number]['provider']) => {
      api.providers.push({ selector, provider });
      return { dispose: api.dispose };
    },
  },
}));

const URI = 'file:///w/review.workflow.yaml';
const NOW = Date.UTC(2026, 10, 3, 12, 0);
const TEXT = [
  'version: 1',
  'name: Review',
  'steps:',
  '  - id: tests',
  '    type: console',
  '    run: npm test',
  '  - id: notes',
  '    type: console',
  '    run: echo ${{ steps.tests.output }}',
  '',
].join('\n');
const TEMPLATE_START = TEXT.indexOf('${{');

function textDocument(text: string, uri = vscode.Uri.parse(URI)) {
  const lineStarts = [0, ...[...text.matchAll(/\n/g)].map((match) => (match.index ?? 0) + 1)];
  return {
    uri,
    version: 1,
    getText: () => text,
    offsetAt: (position: vscode.Position) => lineStarts[position.line] + position.character,
    positionAt: (offset: number) => {
      const line = lineStarts.findLastIndex((start) => start <= offset);
      return new vscode.Position(line, offset - lineStarts[line]);
    },
  };
}

const run = (runId: string, output: string, status: RunView['status'] = 'success'): RunView => ({
  runId,
  workflowName: 'Review',
  status,
  startedAt: NOW - 120_000,
  inputs: {},
  usage: { inputTokens: 0, outputTokens: 0 },
  steps: { tests: { status: 'success', executions: 1, logs: [], output: { status: 'success', output } } },
});

const record = (runId: string, status: RunView['status'] = 'success') => ({
  runId,
  workflowUri: URI,
  workflowName: 'Review',
  status,
  startedAt: NOW - 120_000,
});

function setup() {
  api.providers.length = 0;
  const fake = fakeServices();
  const registration = registerLiveValueHover(fake.services, () => NOW);
  const [{ selector, provider }] = api.providers;
  const token = { isCancellationRequested: false };
  const hoverAt = async (offset: number, document = textDocument(TEXT)) =>
    (await provider.provideHover(document, document.positionAt(offset), token)) as
      InstanceType<typeof api.Hover> | undefined;
  return { ...fake, registration, selector, hoverAt, token };
}

describe('registerLiveValueHover', () => {
  beforeEach(() => api.dispose.mockClear());

  it('registers for workflow files and disposes the registration', () => {
    const t = setup();
    expect(t.selector).toEqual({ pattern: '**/*.workflow.{yaml,yml}' });
    t.registration.dispose();
    expect(api.dispose).toHaveBeenCalled();
  });

  it('shows the value from the running run of the workflow first', async () => {
    const t = setup();
    t.state.active = [{ runId: 'live', workflowUri: URI, view: run('live', 'running output', 'running') }];
    t.state.history = [record('old')];
    t.state.views.old = run('old', 'old output');
    const hover = await t.hoverAt(TEMPLATE_START + 5);
    expect(hover?.contents.value).toBe('**Value in the running run**\n\n```text\nrunning output\n```');
    expect(hover?.contents.isTrusted).toBe(false);
    expect(hover?.contents.supportHtml).toBe(false);
    expect(hover?.range).toEqual(
      new vscode.Range(
        new vscode.Position(8, 14),
        new vscode.Position(8, 14 + '${{ steps.tests.output }}'.length),
      ),
    );
  });

  it('follows the running run as its view changes', async () => {
    const t = setup();
    t.state.active = [{ runId: 'live', workflowUri: URI, view: run('live', 'first', 'running') }];
    expect((await t.hoverAt(TEMPLATE_START))?.contents.value).toContain('first');
    t.state.active = [{ runId: 'live', workflowUri: URI, view: run('live', 'second', 'running') }];
    expect((await t.hoverAt(TEMPLATE_START))?.contents.value).toContain('second');
  });

  it('shows the value from the newest saved run and reads it once per run and status', async () => {
    const t = setup();
    t.state.history = [record('r2'), record('r1')];
    t.state.stored.r2 = run('r2', 'newest');
    t.state.stored.r1 = run('r1', 'older');
    expect((await t.hoverAt(TEMPLATE_START))?.contents.value).toBe(
      '**Value in the last run** (succeeded, 2 min ago)\n\n```text\nnewest\n```',
    );
    await t.hoverAt(TEMPLATE_START + 3);
    expect(t.services.runs.history.getAsync).toHaveBeenCalledTimes(1);

    t.state.history = [record('r2', 'failure'), record('r1')];
    t.state.stored.r2 = run('r2', 'newest', 'failure');
    expect((await t.hoverAt(TEMPLATE_START))?.contents.value).toContain('(failed, 2 min ago)');
    expect(t.services.runs.history.getAsync).toHaveBeenCalledTimes(2);
  });

  it('uses a cached saved run without reading storage', async () => {
    const t = setup();
    t.state.history = [record('r1')];
    t.state.views.r1 = run('r1', 'cached');
    expect((await t.hoverAt(TEMPLATE_START))?.contents.value).toContain('cached');
    expect(t.services.runs.history.getAsync).not.toHaveBeenCalled();
  });

  it('shows nothing without a template, a run or a readable run', async () => {
    const t = setup();
    expect(await t.hoverAt(TEMPLATE_START)).toBeUndefined();
    t.state.history = [record('gone')];
    vi.mocked(t.services.runs.history.getAsync).mockRejectedValueOnce(new Error('corrupt'));
    expect(await t.hoverAt(TEMPLATE_START)).toBeUndefined();
    expect(await t.hoverAt(TEMPLATE_START)).toBeUndefined();
    t.state.views.gone = run('gone', 'back');
    vi.mocked(t.services.runs.history.list).mockClear();
    expect(await t.hoverAt(TEXT.indexOf('npm test'))).toBeUndefined();
    expect(t.services.runs.history.list).not.toHaveBeenCalled();
  });

  it('shows nothing in read-only views such as git diffs', async () => {
    const t = setup();
    t.state.history = [record('r1')];
    t.state.views.r1 = run('r1', 'cached');
    const document = textDocument(TEXT, vscode.Uri.parse('git:/w/review.workflow.yaml'));
    expect(await t.hoverAt(TEMPLATE_START, document)).toBeUndefined();
  });

  it('shows nothing when the hover was cancelled or the text changed while the run was read', async () => {
    const t = setup();
    t.state.history = [record('r1')];
    t.state.stored.r1 = run('r1', 'stored');
    const document = textDocument(TEXT);
    vi.mocked(t.services.runs.history.getAsync).mockImplementationOnce(async () => {
      document.version = 2;
      return t.state.stored.r1;
    });
    expect(await t.hoverAt(TEMPLATE_START, document)).toBeUndefined();

    t.token.isCancellationRequested = true;
    expect(await t.hoverAt(TEMPLATE_START)).toBeUndefined();
  });
});
