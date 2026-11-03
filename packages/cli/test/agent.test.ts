import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StepIO } from '@isar-flow/core';
import { chunk, MockOpenAIServer, reply } from '../../core/test/fakes/mockOpenAIServer';
import type { PreparedRun } from '../src/prepare';
import { runCli } from '../src/run';
import { createRunHost } from '../src/runHost';
import { makeTempDir, removeDir, scriptedInput, testIo, writeFile } from './helpers';

let root: string;
let server: MockOpenAIServer;

beforeEach(async () => {
  root = makeTempDir('isar-cli-agent-');
  server = await MockOpenAIServer.start();
  writeFile(
    root,
    '.isarflow/config.yaml',
    `providers:\n  - id: local\n    baseUrl: ${server.url}/v1\n    apiKeyEnv: LOCAL_KEY\n`,
  );
});
afterEach(async () => {
  await server.close();
  removeDir(root);
});

const FIX =
  'version: 1\nname: Fix\nsteps:\n  - id: fix\n    type: agent\n    agent: coder\n    prompt: Fix the tests\n';

function agentFile(extra = '') {
  writeFile(root, '.isarflow/agents/coder.agent.yaml', `name: Coder\nmodel: local/test-model\n${extra}`);
}

const toolCall = (name: string, args: unknown) =>
  reply.sse([
    chunk.role(),
    chunk.toolCall(0, { id: 'call_1', name, args: JSON.stringify(args) }),
    chunk.finish('tool_calls'),
  ]);
const answer = (text: string) =>
  reply.sse([chunk.role(), chunk.text(text), chunk.finish('stop'), chunk.usage(1200, 34)]);

interface ChatRequest {
  messages: { role: string; content?: string }[];
}
const chatRequests = () => server.requestsTo('/v1/chat/completions').map((r) => r.json as ChatRequest);

describe('runCli agent blocks', () => {
  it('runs an agent with a provider of the config file', async () => {
    writeFile(root, '.isarflow/workflows/fix.workflow.yaml', FIX);
    agentFile('memory: none\n');
    server.on('POST', '/v1/chat/completions', answer('All tests pass now.'));
    const io = testIo(root, { env: { LOCAL_KEY: 'sk-test' } });
    expect(await runCli(['run', 'fix'], io)).toBe(0);
    const out = io.stdout.text();
    expect(out).toContain('▶ fix (Agent)\n    All tests pass now.\n');
    expect(out).toMatch(/✓ fix succeeded in .+ \(1,200 in and 34 out tokens, model local\/test-model\)/);
    expect(out).toContain('Tokens: 1,200 in, 34 out.');
    expect(server.requestsTo('/v1/chat/completions')[0].headers.authorization).toBe('Bearer sk-test');
  });

  it('asks before an agent edits a file and writes it when allowed', async () => {
    writeFile(root, '.isarflow/workflows/fix.workflow.yaml', FIX);
    agentFile('memory: none\ntools: [writeFile]\n');
    server.on(
      'POST',
      '/v1/chat/completions',
      toolCall('writeFile', { path: 'notes.txt', content: 'hi\n' }),
      answer('Wrote it.'),
    );
    const io = testIo(root, { stdin: scriptedInput(['y']) });
    expect(await runCli(['run', 'fix'], io)).toBe(0);
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('hi\n');
    expect(io.stderr.text()).toContain('The agent in fix asks: Create notes.txt');
    expect(io.stderr.text()).toContain('Allow Create notes.txt? [y]es / [a]lways for this run / [n]o ');
  });

  it('denies tool permissions without a terminal and allows them with --yes', async () => {
    writeFile(root, '.isarflow/workflows/fix.workflow.yaml', FIX);
    agentFile('memory: none\ntools: [writeFile]\n');
    server.on(
      'POST',
      '/v1/chat/completions',
      toolCall('writeFile', { path: 'a.txt', content: 'a' }),
      answer('ok'),
    );
    const denied = testIo(root);
    expect(await runCli(['run', 'fix'], denied)).toBe(0);
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
    expect(denied.stderr.text()).toContain('Denied (no terminal): Create a.txt');
    const toolResult = chatRequests()[1].messages.find((m) => m.role === 'tool');
    expect(toolResult?.content).toContain('The user declined this request');

    server.on(
      'POST',
      '/v1/chat/completions',
      toolCall('writeFile', { path: 'a.txt', content: 'a' }),
      answer('ok'),
    );
    const allowed = testIo(root);
    expect(await runCli(['run', 'fix', '--yes'], allowed)).toBe(0);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('a');
  });

  it('gives agents the project memory of the workspace', async () => {
    writeFile(root, '.isarflow/workflows/fix.workflow.yaml', FIX);
    writeFile(root, '.isarflow/memory.md', '# Project memory\n\n- 2026-11-01: Use pnpm.\n');
    agentFile();
    server.on('POST', '/v1/chat/completions', answer('Done.'));
    const io = testIo(root);
    expect(await runCli(['run', 'fix'], io)).toBe(0);
    const system = chatRequests()[0].messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('## Project memory');
    expect(system.content).toContain('- 2026-11-01: Use pnpm.');
    expect(io.stdout.text()).toContain('Read the project memory');
  });

  it('saves notes an agent with memory write remembers', async () => {
    writeFile(root, '.isarflow/memory.md', '# Project memory\n\n- 2026-11-01: Use pnpm.\n');
    server.on(
      'POST',
      '/v1/chat/completions',
      toolCall('remember', { note: 'Tests run with pnpm test.' }),
      answer('Done.'),
    );
    const run: PreparedRun = {
      file: path.join(root, 'fix.workflow.yaml'),
      root,
      workflow: { version: 1, name: 'Fix', steps: [] },
      agents: {},
      secrets: {},
      inputs: {},
      config: { providers: [{ id: 'local', baseUrl: `${server.url}/v1` }] },
      warnings: [],
    };
    const host = createRunHost({ run, runId: 'run-1', io: testIo(root), yes: false });
    const logs: string[] = [];
    const io: StepIO = {
      runId: 'run-1',
      stepId: 'fix',
      signal: new AbortController().signal,
      log: (_s, t) => logs.push(t),
    };
    const result = await host.runAgent(
      {
        stepId: 'fix',
        agent: { name: 'Coder', model: 'local/test-model', memory: 'write' },
        prompt: 'Fix',
        history: [],
        contextFiles: [],
      },
      io,
    );
    expect(result.text).toBe('Done.');
    const memory = fs.readFileSync(path.join(root, '.isarflow', 'memory.md'), 'utf8');
    expect(memory, logs.join('')).toMatch(
      /- 2026-11-01: Use pnpm\.\n- \d{4}-\d{2}-\d{2}: Tests run with pnpm test\.\n$/,
    );
  });

  it('runs a workflow whose agent file sets memory: write and saves its note', async () => {
    writeFile(root, '.isarflow/workflows/fix.workflow.yaml', FIX);
    agentFile('memory: write\n');
    server.on(
      'POST',
      '/v1/chat/completions',
      toolCall('remember', { note: 'Tests run with pnpm test.' }),
      answer('Done.'),
    );
    const io = testIo(root);
    expect(await runCli(['run', 'fix'], io)).toBe(0);
    const offered = server.requestsTo('/v1/chat/completions')[0].json as {
      tools?: { function: { name: string } }[];
    };
    expect(offered.tools?.map((tool) => tool.function.name)).toEqual(['remember']);
    const memory = fs.readFileSync(path.join(root, '.isarflow', 'memory.md'), 'utf8');
    expect(memory, io.stdout.text()).toMatch(
      /^# Project memory\n[\s\S]*\n- \d{4}-\d{2}-\d{2}: Tests run with pnpm test\.\n$/,
    );
  });

  it('fails agent blocks that use VS Code models, and fallback models still apply', async () => {
    writeFile(root, '.isarflow/workflows/fix.workflow.yaml', FIX);
    agentFile('memory: none\n');
    writeFile(
      root,
      '.isarflow/agents/coder.agent.yaml',
      'name: Coder\nmodel: vscode/copilot/gpt-4o\nmemory: none\n',
    );
    const failed = testIo(root);
    expect(await runCli(['run', 'fix'], failed)).toBe(1);
    expect(failed.stdout.text()).toContain("VS Code models (vscode/…) aren't available on the command line.");

    writeFile(
      root,
      '.isarflow/agents/coder.agent.yaml',
      'name: Coder\nmodel: vscode/copilot/gpt-4o\nfallbackModels: [local/test-model]\nmemory: none\n',
    );
    server.on('POST', '/v1/chat/completions', answer('Fallback answered.'));
    const fallback = testIo(root);
    expect(await runCli(['run', 'fix'], fallback)).toBe(0);
    expect(fallback.stdout.text()).toContain('Trying fallback model local/test-model.');
  });

  it('explains unknown providers', async () => {
    writeFile(root, '.isarflow/workflows/fix.workflow.yaml', FIX);
    writeFile(root, '.isarflow/agents/coder.agent.yaml', 'name: Coder\nmodel: my-llm/x\nmemory: none\n');
    const io = testIo(root);
    expect(await runCli(['run', 'fix'], io)).toBe(1);
    expect(io.stdout.text()).toContain(
      "Provider 'my-llm' isn't configured. Add it to .isarflow/config.yaml or set ISARFLOW_MY_LLM_BASE_URL.",
    );
  });

  it('says that user agents of VS Code are not available', async () => {
    writeFile(root, '.isarflow/workflows/fix.workflow.yaml', FIX);
    const io = testIo(root);
    expect(await runCli(['run', 'fix'], io)).toBe(1);
    expect(io.stderr.text()).toContain("Agent 'coder' used by");
    expect(io.stderr.text()).toContain(
      "User agents from VS Code aren't available on the command line. Copy the agent file into .isarflow/agents/.",
    );
  });
});
