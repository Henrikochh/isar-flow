import { describe, expect, it } from 'vitest';
import type {
  AgentRequest,
  ApprovalRequest,
  ConsoleRequest,
  LogStream,
  StepIO,
} from '../../src/engine/types';
import type { SimulationFile } from '../../src/schema/types';
import { createSimulationHost, SIMULATED_ANSWER } from '../../src/simulation';

interface TestIO extends StepIO {
  logs: [LogStream, string][];
}

function io(stepId: string, signal: AbortSignal = new AbortController().signal): TestIO {
  const logs: [LogStream, string][] = [];
  return { runId: 'run-1', stepId, signal, log: (stream, text) => logs.push([stream, text]), logs };
}

const consoleReq = (stepId: string): ConsoleRequest => ({
  stepId,
  command: 'npm test',
  shell: 'auto',
  cwd: '/ws',
  env: {},
});

const agentReq = (stepId: string, extra: Partial<AgentRequest> = {}): AgentRequest => ({
  stepId,
  agent: { name: 'Reviewer', model: 'litellm/reviewer' },
  prompt: 'Review it',
  history: [],
  contextFiles: [],
  ...extra,
});

const approvalReq = (stepId: string): ApprovalRequest => ({ stepId, message: 'Ship?' });

const REVIEW_SHAPE = { approved: 'boolean', issues: 'string[]' };

describe('createSimulationHost', () => {
  describe('console blocks', () => {
    it('answers with the default result without mocks', async () => {
      const host = createSimulationHost({ file: {} });
      const call = io('tests');
      expect(await host.runConsole(consoleReq('tests'), call)).toEqual({
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
      });
      expect(call.logs).toEqual([['info', 'Simulated with the default result.\n']]);
    });

    it('uses the mocks in order and repeats the last one', async () => {
      const file: SimulationFile = {
        blocks: { tests: [{ exitCode: 1, output: '1 failed\n' }, { output: 'all passed\n' }] },
      };
      const host = createSimulationHost({ file });
      const calls = [io('tests'), io('tests'), io('tests')];
      const results = [];
      for (const call of calls) results.push(await host.runConsole(consoleReq('tests'), call));
      expect(results.map((r) => [r.exitCode, r.stdout, r.output])).toEqual([
        [1, '1 failed\n', '1 failed\n'],
        [0, 'all passed\n', 'all passed\n'],
        [0, 'all passed\n', 'all passed\n'],
      ]);
      expect(calls.map((c) => c.logs)).toEqual([
        [
          ['info', 'Simulated: result 1 of 2.\n'],
          ['stdout', '1 failed\n'],
        ],
        [
          ['info', 'Simulated: result 2 of 2.\n'],
          ['stdout', 'all passed\n'],
        ],
        [
          ['info', 'Simulated: result 2 of 2 (the last result repeats).\n'],
          ['stdout', 'all passed\n'],
        ],
      ]);
      expect(host.calls()).toEqual({ tests: 3 });
    });

    it('treats an empty list like no mocks', async () => {
      const host = createSimulationHost({ file: { blocks: { tests: [] } } });
      const call = io('tests');
      expect((await host.runConsole(consoleReq('tests'), call)).exitCode).toBe(0);
      expect(call.logs[0]).toEqual(['info', 'Simulated with the default result.\n']);
    });
  });

  describe('agent blocks', () => {
    it('answers text agents with the simulated answer and no usage', async () => {
      const host = createSimulationHost({ file: {} });
      const history = [{ role: 'user' as const, content: 'Before' }];
      const call = io('implement');
      expect(await host.runAgent(agentReq('implement', { history }), call)).toEqual({
        text: SIMULATED_ANSWER,
        model: 'litellm/reviewer',
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 1,
        toolCalls: 0,
        messages: [
          { role: 'user', content: 'Before' },
          { role: 'user', content: 'Review it' },
          { role: 'assistant', content: SIMULATED_ANSWER },
        ],
      });
      expect(call.logs).toEqual([
        ['info', 'Simulated with the default result.\n'],
        ['agent', `${SIMULATED_ANSWER}\n`],
      ]);
    });

    it('ignores json for text agents', async () => {
      const host = createSimulationHost({
        file: { blocks: { implement: [{ json: { a: 1 } }, { text: 'Done' }] } },
      });
      const first = await host.runAgent(agentReq('implement'), io('implement'));
      expect(first.text).toBe(SIMULATED_ANSWER);
      expect(first).not.toHaveProperty('json');
      expect((await host.runAgent(agentReq('implement'), io('implement'))).text).toBe('Done');
    });

    it('builds JSON answers from mocks, text or the shape', async () => {
      const file: SimulationFile = {
        blocks: {
          review: [
            { json: { approved: false, issues: ['x'] } },
            { text: 'Verdict: {"approved": true, "issues": []}' },
            { text: 'Not JSON' },
            { json: { approved: true }, text: 'Approved' },
            {},
          ],
        },
      };
      const host = createSimulationHost({ file });
      const output = { format: 'json' as const, schema: REVIEW_SHAPE };
      const answers = [];
      for (let i = 0; i < 5; i++)
        answers.push(await host.runAgent(agentReq('review', { output }), io('review')));
      expect(answers.map((a) => [a.json, a.text])).toEqual([
        [{ approved: false, issues: ['x'] }, '{\n  "approved": false,\n  "issues": [\n    "x"\n  ]\n}'],
        [{ approved: true, issues: [] }, 'Verdict: {"approved": true, "issues": []}'],
        [undefined, 'Not JSON'],
        [{ approved: true }, 'Approved'],
        [{ approved: true, issues: [] }, '{\n  "approved": true,\n  "issues": []\n}'],
      ]);
      expect(answers[2]).not.toHaveProperty('json');
    });

    it('builds an object for JSON agents without a shape', async () => {
      const host = createSimulationHost({ file: {} });
      const answer = await host.runAgent(agentReq('review', { output: { format: 'json' } }), io('review'));
      expect(answer.json).toEqual({});
      expect(answer.text).toBe('{}');
    });
  });

  describe('approval blocks', () => {
    it('approves by default and logs the answer', async () => {
      const host = createSimulationHost({ file: {} });
      const call = io('ship');
      expect(await host.requestApproval(approvalReq('ship'), call)).toEqual({ approved: true });
      expect(call.logs).toEqual([
        ['info', 'Simulated with the default result.\n'],
        ['info', 'Answered automatically: approved.\n'],
      ]);
    });

    it('rejects when the file says so, unless a mock decides', async () => {
      const file: SimulationFile = {
        approvals: 'reject',
        blocks: { ship: [{ comment: 'Too risky' }, { approved: true, comment: 'Fine now' }] },
      };
      const host = createSimulationHost({ file });
      const first = io('ship');
      expect(await host.requestApproval(approvalReq('ship'), first)).toEqual({
        approved: false,
        comment: 'Too risky',
      });
      expect(first.logs.at(-1)).toEqual(['info', 'Answered automatically: rejected.\n']);
      expect(await host.requestApproval(approvalReq('ship'), io('ship'))).toEqual({
        approved: true,
        comment: 'Fine now',
      });
      expect(await host.requestApproval(approvalReq('other'), io('other'))).toEqual({ approved: false });
    });
  });

  describe('failures and cancellation', () => {
    it('fails the call with the mocked error', async () => {
      const host = createSimulationHost({
        file: { blocks: { implement: [{ error: 'The model is not reachable.' }] } },
      });
      const call = io('implement');
      await expect(host.runAgent(agentReq('implement'), call)).rejects.toThrow('The model is not reachable.');
      expect(call.logs).toEqual([['info', 'Simulated: result 1 of 1.\n']]);
      await expect(host.runConsole(consoleReq('implement'), io('implement'))).rejects.toThrow(
        'The model is not reachable.',
      );
      await expect(host.requestApproval(approvalReq('implement'), io('implement'))).rejects.toThrow(
        'The model is not reachable.',
      );
      expect(host.calls()).toEqual({ implement: 3 });
    });

    it('waits delayMs before answering', async () => {
      const host = createSimulationHost({ file: {}, delayMs: 40 });
      const started = Date.now();
      await host.runConsole(consoleReq('tests'), io('tests'));
      expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    });

    it('rejects like a cancelled call when the signal aborts during the delay', async () => {
      const host = createSimulationHost({ file: {}, delayMs: 10_000 });
      const controller = new AbortController();
      const pending = host.runConsole(consoleReq('tests'), io('tests', controller.signal));
      setTimeout(() => controller.abort(), 5);
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects right away when the signal already aborted, with its reason when it is an error', async () => {
      const host = createSimulationHost({ file: {} });
      const controller = new AbortController();
      const reason = new Error('Timed out after 1000 ms');
      controller.abort(reason);
      await expect(host.runAgent(agentReq('a'), io('a', controller.signal))).rejects.toBe(reason);
      expect(host.calls()).toEqual({ a: 1 });
    });

    it('rejects with an AbortError when the abort reason is not an error', async () => {
      const host = createSimulationHost({ file: {}, delayMs: 10_000 });
      const controller = new AbortController();
      const pending = host.requestApproval(approvalReq('ship'), io('ship', controller.signal));
      controller.abort('stopped');
      await expect(pending).rejects.toMatchObject({
        name: 'AbortError',
        message: 'The simulated call was cancelled.',
      });
    });

    it('returns a copy of the call counts', async () => {
      const host = createSimulationHost({ file: {} });
      await host.runConsole(consoleReq('__proto__'), io('__proto__'));
      const calls = host.calls();
      calls.__proto__ = 99;
      expect(Object.hasOwn(host.calls(), '__proto__')).toBe(true);
      expect(host.calls().__proto__).toBe(1);
    });
  });
});
