import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createPermissionPrompt } from '../../../src/tools/permissionPrompt';

type ShowWarning = (
  message: string,
  options: vscode.MessageOptions,
  ...items: vscode.MessageItem[]
) => Promise<vscode.MessageItem | undefined>;

function answerWith(pick: (items: vscode.MessageItem[]) => vscode.MessageItem | undefined) {
  const calls: { message: string; options: vscode.MessageOptions; items: vscode.MessageItem[] }[] = [];
  const impl: ShowWarning = async (message, options, ...items) => {
    calls.push({ message, options, items });
    return pick(items);
  };
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(impl as never);
  return calls;
}

const request = {
  runId: 'run-1',
  stepId: 'fix',
  tool: 'runCommand' as const,
  summary: 'Run: npm test',
  detail: 'npm test\n\nFolder: workspace root',
};

afterEach(() => vi.restoreAllMocks());

describe('createPermissionPrompt', () => {
  it('shows a modal warning with the request', async () => {
    const calls = answerWith((items) => items[0]);
    await createPermissionPrompt()(request);
    expect(calls[0].message).toBe('Run: npm test?');
    expect(calls[0].options.modal).toBe(true);
    expect(calls[0].options.detail).toContain('"fix"');
    expect(calls[0].options.detail).toContain('Folder: workspace root');
    expect(calls[0].items.map((i) => i.title)).toEqual(['Allow', 'Allow for this run', 'Deny']);
  });

  it('maps the buttons to answers', async () => {
    answerWith((items) => items[0]);
    expect(await createPermissionPrompt()(request)).toBe('allow');
    vi.restoreAllMocks();
    answerWith((items) => items[1]);
    expect(await createPermissionPrompt()(request)).toBe('allowRun');
    vi.restoreAllMocks();
    answerWith((items) => items[2]);
    expect(await createPermissionPrompt()(request)).toBe('deny');
  });

  it('treats a dismissed dialog as deny', async () => {
    answerWith(() => undefined);
    expect(await createPermissionPrompt()(request)).toBe('deny');
  });
});
