import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { documentDiagnostics, toVsDiagnostic } from '../../../src/diagnostics';
import { fileKind, fileNameOf, isTrackedScheme } from '../../../src/editors/files';

describe('toVsDiagnostic', () => {
  it('maps range, severity, code and source', () => {
    const d = toVsDiagnostic(
      {
        severity: 'warning',
        code: 'unknown-model',
        message: 'Model is not available.',
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
      },
      10,
    );
    expect(d.range.start).toEqual(new vscode.Position(2, 4));
    expect(d.range.end).toEqual(new vscode.Position(2, 9));
    expect(d.severity).toBe(vscode.DiagnosticSeverity.Warning);
    expect(d.message).toBe('Model is not available.');
    expect(d.code).toBe('unknown-model');
    expect(d.source).toBe('Isar Flow');
  });

  it('maps every severity', () => {
    const severity = (s: 'error' | 'warning' | 'info') =>
      toVsDiagnostic({ severity: s, code: 'x', message: 'm' }, 1).severity;
    expect(severity('error')).toBe(vscode.DiagnosticSeverity.Error);
    expect(severity('warning')).toBe(vscode.DiagnosticSeverity.Warning);
    expect(severity('info')).toBe(vscode.DiagnosticSeverity.Information);
  });

  it('puts diagnostics without a range on the first line', () => {
    const d = toVsDiagnostic({ severity: 'error', code: 'x', message: 'm' }, 5, 12);
    expect(d.range).toEqual(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 12)));
  });

  it('clamps ranges past the end of a shorter document', () => {
    const d = toVsDiagnostic(
      {
        severity: 'error',
        code: 'x',
        message: 'm',
        range: { start: { line: 8, character: 2 }, end: { line: 9, character: 0 } },
      },
      3,
    );
    expect(d.range.start.line).toBe(2);
    expect(d.range.end.line).toBe(2);
  });
});

describe('documentDiagnostics', () => {
  const ctx = { agentIds: [], modelRefs: [] };

  it('validates workflows semantically', () => {
    const text =
      'version: 1\nname: A\nsteps:\n  - id: a\n    type: agent\n    agent: ghost\n    prompt: hi\n';
    expect(documentDiagnostics('workflow', text, ctx).map((d) => d.code)).toEqual(['unknown-agent']);
  });

  it('validates agent files', () => {
    expect(documentDiagnostics('agent', 'name: A\n', ctx).map((d) => d.code)).toContain('missing-property');
  });
});

describe('files', () => {
  it('recognizes workflow and agent files', () => {
    expect(fileKind('/w/.isarflow/workflows/review.workflow.yaml')).toBe('workflow');
    expect(fileKind('C:/w/flows/x.workflow.yml')).toBe('workflow');
    expect(fileKind('/w/.isarflow/agents/coder.agent.yaml')).toBe('agent');
    expect(fileKind('/w/coder.agent.yml')).toBe('agent');
    expect(fileKind('/w/docker-compose.yaml')).toBeUndefined();
    expect(fileKind('/w/workflow.yaml')).toBeUndefined();
  });

  it('takes the file name from the URI path', () => {
    expect(fileNameOf(vscode.Uri.file('C:\\repo\\a\\review.workflow.yaml'))).toBe('review.workflow.yaml');
    expect(fileNameOf(vscode.Uri.parse('file:///repo/x.agent.yaml'))).toBe('x.agent.yaml');
  });

  it('ignores read-only views such as git diffs', () => {
    expect(isTrackedScheme('file')).toBe(true);
    expect(isTrackedScheme('untitled')).toBe(true);
    expect(isTrackedScheme('vscode-remote')).toBe(true);
    expect(isTrackedScheme('git')).toBe(false);
  });
});
