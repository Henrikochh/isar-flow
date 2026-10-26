import * as vscode from 'vscode';
import type { Diagnostic } from '@isar-flow/core';
import type { Services } from './contracts';
import {
  buildAgentDocumentState,
  buildWorkflowDocumentState,
  type ValidationContext,
  validationContext,
} from './editors/documentState';
import { fileKind, type IsarFileKind, isTrackedScheme } from './editors/files';

const CHANGE_DELAY_MS = 250;

const SEVERITY: Record<Diagnostic['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** Converts a core diagnostic; diagnostics without a range mark the first line. */
export function toVsDiagnostic(d: Diagnostic, lineCount: number, firstLineLength = 0): vscode.Diagnostic {
  const lastLine = Math.max(0, lineCount - 1);
  const position = (p: { line: number; character: number }) =>
    new vscode.Position(Math.min(Math.max(0, p.line), lastLine), Math.max(0, p.character));
  const range = d.range
    ? new vscode.Range(position(d.range.start), position(d.range.end))
    : new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, firstLineLength));
  const diagnostic = new vscode.Diagnostic(range, d.message, SEVERITY[d.severity]);
  diagnostic.source = 'Isar Flow';
  diagnostic.code = d.code;
  return diagnostic;
}

/** Parse, schema and semantic diagnostics of a workflow or agent file. */
export function documentDiagnostics(kind: IsarFileKind, text: string, ctx: ValidationContext): Diagnostic[] {
  if (kind === 'workflow') return buildWorkflowDocumentState(text, '', '', ctx).diagnostics;
  return buildAgentDocumentState(text, '', '', 'workspace', '', [], { modelRefs: ctx.modelRefs }).diagnostics;
}

function trackedKind(document: vscode.TextDocument): IsarFileKind | undefined {
  return isTrackedScheme(document.uri.scheme) ? fileKind(document.uri.path) : undefined;
}

/** Publishes diagnostics for open workflow and agent files to the Problems view. */
export function registerDiagnostics(services: Services): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('isar-flow');
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const cancel = (key: string) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
  };

  const validate = (document: vscode.TextDocument) => {
    const kind = trackedKind(document);
    if (!kind || document.isClosed) return;
    const ctx = validationContext(services.agents.list(), services.models.catalog());
    const firstLineLength = document.lineCount > 0 ? document.lineAt(0).text.length : 0;
    const diagnostics = documentDiagnostics(kind, document.getText(), ctx).map((d) =>
      toVsDiagnostic(d, document.lineCount, firstLineLength),
    );
    collection.set(document.uri, diagnostics);
  };

  const schedule = (document: vscode.TextDocument) => {
    if (!trackedKind(document)) return;
    const key = document.uri.toString();
    cancel(key);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        validate(document);
      }, CHANGE_DELAY_MS),
    );
  };

  const revalidate = (kinds: IsarFileKind[]) => {
    for (const document of vscode.workspace.textDocuments) {
      const kind = trackedKind(document);
      if (kind && kinds.includes(kind)) validate(document);
    }
  };

  vscode.workspace.textDocuments.forEach(validate);

  return vscode.Disposable.from(
    collection,
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0) schedule(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cancel(document.uri.toString());
      collection.delete(document.uri);
    }),
    services.agents.onDidChange(() => revalidate(['workflow'])),
    services.models.onDidChange(() => revalidate(['workflow', 'agent'])),
    { dispose: () => [...timers.keys()].forEach(cancel) },
  );
}
