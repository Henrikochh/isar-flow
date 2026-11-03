import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerCopilot } from '../../../src/copilot/registerCopilot';
import { copilotSetup, fakeStream, fakeToken } from './fakes';

afterEach(() => vi.restoreAllMocks());

describe('registerCopilot', () => {
  it('registers both tools and the @isarflow participant and disposes them', async () => {
    const disposed: string[] = [];
    const tools = new Map<string, unknown>();
    vi.spyOn(vscode.lm, 'registerTool').mockImplementation((name: string, tool: unknown) => {
      tools.set(name, tool);
      return { dispose: () => disposed.push(name) };
    });
    let handler: vscode.ChatRequestHandler | undefined;
    const participant = { iconPath: undefined as unknown, dispose: () => disposed.push('chat') };
    vi.spyOn(vscode.chat, 'createChatParticipant').mockImplementation(((id: string, h: unknown) => {
      expect(id).toBe('isarFlow.chat');
      handler = h as vscode.ChatRequestHandler;
      return participant;
    }) as never);

    const setup = copilotSetup();
    const registration = registerCopilot(setup.services, setup.deps);
    expect([...tools.keys()]).toEqual(['isarflow_listWorkflows', 'isarflow_runWorkflow']);
    expect(tools.get('isarflow_listWorkflows')).toBe(registration.listWorkflows);
    expect(tools.get('isarflow_runWorkflow')).toBe(registration.runWorkflow);
    expect(String(participant.iconPath)).toBe('file:///ext/media/icon.png');

    const out = fakeStream();
    await handler?.(
      { command: 'list', prompt: '' } as vscode.ChatRequest,
      {} as vscode.ChatContext,
      out.stream as unknown as vscode.ChatResponseStream,
      fakeToken().token,
    );
    expect(out.text()).toContain('**Release**');

    registration.dispose();
    expect(disposed).toEqual(['isarflow_listWorkflows', 'isarflow_runWorkflow', 'chat']);
  });

  it('works when VS Code has no language model tools or chat', () => {
    const lm = vscode.lm as { registerTool?: unknown };
    const chat = vscode.chat as { createChatParticipant?: unknown };
    const registerTool = lm.registerTool;
    const createChatParticipant = chat.createChatParticipant;
    delete lm.registerTool;
    delete chat.createChatParticipant;
    try {
      const setup = copilotSetup();
      const registration = registerCopilot(setup.services, setup.deps);
      expect(registration.listWorkflows).toBeDefined();
      expect(setup.services.output.info).toHaveBeenCalledWith(
        'Copilot tools and @isarflow need VS Code with chat support; they are turned off.',
      );
      registration.dispose();
    } finally {
      lm.registerTool = registerTool;
      chat.createChatParticipant = createChatParticipant;
    }
  });
});
