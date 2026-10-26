import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { codeLensCommands } from '../../../src/codelens';

describe('codeLensCommands', () => {
  it('offers run and canvas for workflow files', () => {
    const uri = vscode.Uri.file('/w/.isarflow/workflows/review.workflow.yaml');
    expect(codeLensCommands(uri)).toEqual([
      { title: '$(play) Run workflow', command: 'isarFlow.runWorkflow', arguments: [uri] },
      { title: '$(type-hierarchy) Open in canvas', command: 'isarFlow.openInCanvas', arguments: [uri] },
    ]);
  });

  it('offers the agent editor for agent files', () => {
    const uri = vscode.Uri.file('/w/.isarflow/agents/coder.agent.yml');
    expect(codeLensCommands(uri)).toEqual([
      { title: 'Open in agent editor', command: 'vscode.openWith', arguments: [uri, 'isarFlow.agentEditor'] },
    ]);
  });

  it('offers nothing for other files and read-only views', () => {
    expect(codeLensCommands(vscode.Uri.file('/w/docker-compose.yaml'))).toEqual([]);
    expect(codeLensCommands(vscode.Uri.parse('git:/w/review.workflow.yaml'))).toEqual([]);
  });
});
