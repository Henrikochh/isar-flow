import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { abortError, formatTimeLeft, openWorkflowEditor } from '../../../src/run/notices';

describe('formatTimeLeft', () => {
  it.each([
    [200, '1 s'],
    [45_000, '45 s'],
    [119_000, '2 min'],
    [3_600_000, '1 h'],
    [5_400_000, '1 h 30 min'],
  ])('%i ms is %s', (ms, text) => {
    expect(formatTimeLeft(ms)).toBe(text);
  });
});

describe('abortError', () => {
  it('is an AbortError with the message of an Error reason or the fallback', () => {
    expect(abortError(new Error('Timed out'))).toMatchObject({ name: 'AbortError', message: 'Timed out' });
    expect(abortError('stop')).toMatchObject({ name: 'AbortError', message: 'The question was withdrawn.' });
    expect(abortError(undefined, 'Gone.')).toMatchObject({ message: 'Gone.' });
  });
});

describe('openWorkflowEditor', () => {
  it('opens the workflow in the visual editor', async () => {
    const execute = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    await openWorkflowEditor('file:///ws/a.workflow.yaml');
    expect(execute).toHaveBeenCalledWith(
      'vscode.openWith',
      vscode.Uri.parse('file:///ws/a.workflow.yaml'),
      'isarFlow.workflowEditor',
    );
    execute.mockRestore();
  });
});
