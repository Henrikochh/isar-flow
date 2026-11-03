import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerWorkflowEditor } from '../../../src/editors/workflowEditor';
import { isRelativePath, parseSnapshotUri, snapshotUri } from '../../../src/safety/snapshotUri';
import { fakeReviews, fakeServices } from '../editors/fakes';

describe('isarflow-snapshot documents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(vscode.workspace, { isTrusted: true });
  });

  it('are served by the review service, and not in Restricted Mode', async () => {
    Object.assign(vscode.window, { registerCustomEditorProvider: () => ({ dispose: () => undefined }) });
    const register = vi.spyOn(vscode.workspace, 'registerTextDocumentContentProvider');
    const { services } = fakeServices();
    const reviews = fakeReviews();
    reviews.service.contentProvider.provideTextDocumentContent = () => 'before the run';
    Object.assign(services.runs, { reviews: reviews.service });

    const registration = registerWorkflowEditor(services);
    const [scheme, provider] = register.mock.calls[0] as [string, vscode.TextDocumentContentProvider];
    expect(scheme).toBe('isarflow-snapshot');
    const uri = snapshotUri('run-1', 'before', 'src/app.ts');
    const token = new vscode.CancellationTokenSource().token;
    expect(await provider.provideTextDocumentContent(uri, token)).toBe('before the run');
    Object.assign(vscode.workspace, { isTrusted: false });
    expect(await provider.provideTextDocumentContent(uri, token)).toBe('');
    registration.dispose();
  });

  it('have URIs with the run, the side and the path', () => {
    const uri = snapshotUri('run-1', 'after', 'src/my file.ts');
    expect([uri.scheme, uri.path]).toEqual(['isarflow-snapshot', '/run-1/after/src/my file.ts']);
    expect(parseSnapshotUri(uri)).toEqual({ runId: 'run-1', side: 'after', path: 'src/my file.ts' });
    expect(parseSnapshotUri({ path: '/run-1/sideways/a.ts' })).toBeUndefined();
    expect(parseSnapshotUri({ path: '/run 1/before/a.ts' })).toBeUndefined();
    expect(['a/b.ts', '.github/x.yml'].every(isRelativePath)).toBe(true);
    expect(['', '../a', 'a/../b', 'a//b', 'C:/x', 'a\\b', '/abs', 42].some(isRelativePath)).toBe(false);
  });
});
