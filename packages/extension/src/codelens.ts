import * as vscode from 'vscode';
import type { Services } from './contracts';
import { fileKind, isTrackedScheme } from './editors/files';
import { AGENT_EDITOR_VIEW_TYPE } from './editors/host';

/** Commands shown above line 1 of workflow and agent YAML files. */
export function codeLensCommands(uri: vscode.Uri): vscode.Command[] {
  if (!isTrackedScheme(uri.scheme)) return [];
  switch (fileKind(uri.path)) {
    case 'workflow':
      return [
        { title: '$(play) Run workflow', command: 'isarFlow.runWorkflow', arguments: [uri] },
        { title: '$(beaker) Simulate', command: 'isarFlow.simulateWorkflow', arguments: [uri] },
        { title: '$(type-hierarchy) Open in canvas', command: 'isarFlow.openInCanvas', arguments: [uri] },
      ];
    case 'agent':
      return [
        {
          title: 'Open in agent editor',
          command: 'vscode.openWith',
          arguments: [uri, AGENT_EDITOR_VIEW_TYPE],
        },
      ];
    default:
      return [];
  }
}

export function registerCodeLens(_services: Services): vscode.Disposable {
  const provider: vscode.CodeLensProvider = {
    provideCodeLenses(document) {
      const top = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
      return codeLensCommands(document.uri).map((command) => new vscode.CodeLens(top, command));
    },
  };
  return vscode.languages.registerCodeLensProvider(
    [{ pattern: '**/*.workflow.{yaml,yml}' }, { pattern: '**/*.agent.{yaml,yml}' }],
    provider,
  );
}
