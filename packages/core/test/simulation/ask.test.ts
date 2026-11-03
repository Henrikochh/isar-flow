import { describe, expect, it } from 'vitest';
import { runWorkflow } from '../../src/engine';
import type { AskRequest, LogStream, RunEvent, StepIO, StepOutput } from '../../src/engine/types';
import type { AskStep, SimulationFile, Workflow } from '../../src/schema/types';
import {
  checkSimulationText,
  createSimulationHost,
  defaultSimulationResult,
  newSimulationText,
  parseSimulationText,
  setSimulationResults,
  SIMULATED_ANSWER,
  validateSimulation,
} from '../../src/simulation';
import { fakeClock } from '../engine/helpers';

interface TestIO extends StepIO {
  logs: [LogStream, string][];
}

function io(stepId: string, signal: AbortSignal = new AbortController().signal): TestIO {
  const logs: [LogStream, string][] = [];
  return { runId: 'sim-1', stepId, signal, log: (stream, text) => logs.push([stream, text]), logs };
}

const askReq = (extra: Partial<AskRequest> = {}): AskRequest => ({
  stepId: 'pick',
  question: 'Where?',
  ...extra,
});

const askStep = (extra: Partial<AskStep> = {}): AskStep => ({
  id: 'pick',
  type: 'ask',
  question: 'Where?',
  ...extra,
});

describe('simulation host: ask blocks', () => {
  it('answers with the mocks in order and repeats the last one', async () => {
    const host = createSimulationHost({
      file: { blocks: { pick: [{ answer: 'dev' }, { answer: 'prod' }] } },
    });
    const first = io('pick');
    expect(await host.askUser?.(askReq(), first)).toEqual({ answer: 'dev' });
    expect(first.logs).toEqual([
      ['info', 'Simulated: result 1 of 2.\n'],
      ['info', "Answered automatically: 'dev'.\n"],
    ]);
    expect(await host.askUser?.(askReq(), io('pick'))).toEqual({ answer: 'prod' });
    expect(await host.askUser?.(askReq(), io('pick'))).toEqual({ answer: 'prod' });
    expect(host.calls()).toEqual({ pick: 3 });
  });

  it('answers with the default, else the first choice, else the simulated answer', async () => {
    const host = createSimulationHost({ file: {} });
    expect(await host.askUser?.(askReq({ choices: ['a', 'b'], default: 'b' }), io('pick'))).toEqual({
      answer: 'b',
    });
    expect(await host.askUser?.(askReq({ choices: ['a', 'b'] }), io('pick'))).toEqual({ answer: 'a' });
    expect(await host.askUser?.(askReq(), io('pick'))).toEqual({ answer: SIMULATED_ANSWER });
    expect(await host.askUser?.(askReq({ default: 'x' }), io('pick'))).toEqual({ answer: 'x' });
    const empty = createSimulationHost({ file: { blocks: { pick: [{ comment: 'no answer' }] } } });
    expect(await empty.askUser?.(askReq({ default: 'y' }), io('pick'))).toEqual({ answer: 'y' });
  });

  it('fails the call when the mock says so', async () => {
    const host = createSimulationHost({ file: { blocks: { pick: [{ error: 'Nobody is there.' }] } } });
    await expect(host.askUser?.(askReq(), io('pick'))).rejects.toThrow('Nobody is there.');
  });

  it('waits the delay and stops waiting when the call is cancelled', async () => {
    const host = createSimulationHost({ file: {}, delayMs: 10_000 });
    const controller = new AbortController();
    const pending = host.askUser?.(askReq(), io('pick', controller.signal));
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('defaultSimulationResult: ask blocks', () => {
  it('uses the literal default, else the first choice, else the simulated answer', () => {
    expect(defaultSimulationResult(askStep({ choices: ['dev', 'prod'], default: 'prod' }))).toEqual({
      answer: 'prod',
    });
    expect(defaultSimulationResult(askStep({ choices: ['dev', 'prod'] }))).toEqual({ answer: 'dev' });
    expect(defaultSimulationResult(askStep())).toEqual({ answer: SIMULATED_ANSWER });
    expect(defaultSimulationResult(askStep({ default: '${{ inputs.env }}' }))).toEqual({
      answer: '${{ inputs.env }}',
    });
  });
});

describe('validateSimulation: ask blocks', () => {
  const workflow: Workflow = {
    version: 1,
    name: 'Ask',
    steps: [
      askStep({ choices: ['dev', 'prod'] }),
      { id: 'free', type: 'ask', question: 'Why?' },
      { id: 'dynamic', type: 'ask', question: 'Which?', choices: ['main', '${{ inputs.branch }}'] },
      { id: 'tests', type: 'console', run: 'npm test' },
      { id: 'end', type: 'stop' },
    ],
  };

  it('accepts answers that fit the block', () => {
    const file: SimulationFile = {
      blocks: {
        pick: [{ answer: 'dev' }, { answer: 'PROD' }, { error: 'x' }],
        free: [{ answer: 'anything' }],
        dynamic: [{ answer: 'feature' }],
      },
    };
    expect(validateSimulation(file, workflow)).toEqual([]);
  });

  it('warns about answers that are not one of the literal choices', () => {
    const file: SimulationFile = { blocks: { pick: [{ answer: 'dev' }, { answer: 'staging' }] } };
    expect(validateSimulation(file, workflow)).toEqual([
      {
        severity: 'warning',
        code: 'sim-ask-choice',
        message:
          "Result 2 of \"pick\": 'staging' isn't one of the choices (dev, prod), so the block fails in the simulation.",
        path: ['blocks', 'pick', 1, 'answer'],
        stepId: 'pick',
      },
    ]);
  });

  it('warns about fields of other block types and answers on other blocks', () => {
    const file: SimulationFile = { blocks: { pick: [{ approved: true }], tests: [{ answer: 'x' }] } };
    expect(validateSimulation(file, workflow).map((d) => [d.code, d.message])).toEqual([
      ['sim-field-mismatch', 'Result 1 of "pick": approved doesn\'t apply to ask blocks. Use answer.'],
      [
        'sim-field-mismatch',
        'Result 1 of "tests": answer doesn\'t apply to console blocks. Use exitCode and output.',
      ],
    ]);
  });

  it('lists ask blocks among the blocks that use mocks', () => {
    const file: SimulationFile = { blocks: { end: [{ answer: 'x' }] } };
    expect(validateSimulation(file, workflow)[0].message).toBe(
      '"end" is a stop block; only console, agent, approval and ask blocks use mocks.',
    );
  });

  it('checks parsed files with ranges', () => {
    const text = 'version: 1\nblocks:\n  pick:\n    - answer: staging\n';
    const { diagnostics } = checkSimulationText(text, workflow);
    expect(diagnostics).toMatchObject([{ code: 'sim-ask-choice', range: { start: { line: 2 } } }]);
  });
});

describe('simulation files: answer', () => {
  it('parses answers and names them in the result field hint', () => {
    expect(parseSimulationText('blocks:\n  pick:\n    - answer: dev\n').file).toEqual({
      blocks: { pick: [{ answer: 'dev' }] },
    });
    const { diagnostics } = parseSimulationText('blocks:\n  pick:\n    - Answer: dev\n');
    expect(diagnostics[0].message).toBe("Unknown property 'Answer'. Did you mean 'answer'?");
    const other = parseSimulationText('blocks:\n  pick:\n    - reply: dev\n');
    expect(other.diagnostics[0].message).toBe(
      "Unknown property 'reply'. A result has exitCode, output, text, json, approved, comment, answer or error.",
    );
  });

  it('writes answer before error', () => {
    const text = setSimulationResults('version: 1\nblocks: {}\n', 'pick', [{ error: 'x', answer: 'dev' }]);
    expect(text).toBe('version: 1\nblocks:\n  pick:\n    - answer: dev\n      error: x\n');
  });

  it('has a commented ask example in new files', () => {
    const text = newSimulationText('x');
    const example = text
      .split('\n')
      .filter((line) => line.startsWith('#   ') || line === '# blocks:')
      .map((line) => line.slice(2))
      .join('\n');
    const blocks = parseSimulationText(example).file?.blocks ?? {};
    expect(Object.values(blocks).some((list) => list.some((r) => r.answer !== undefined))).toBe(true);
  });
});

describe('simulated runs: ask blocks', () => {
  async function simulate(workflow: Workflow, file: SimulationFile) {
    const host = createSimulationHost({ file });
    const run = runWorkflow(workflow, {
      runId: 'sim-1',
      inputs: {},
      agents: {},
      workspaceRoot: '/ws',
      now: fakeClock(),
      simulated: true,
      host,
    });
    const events: RunEvent[] = [];
    let next = await run.next();
    while (!next.done) {
      events.push(next.value);
      next = await run.next();
    }
    const output = (id: string): StepOutput | undefined =>
      events.flatMap((e) => (e.type === 'step-end' && e.stepId === id ? [e.output] : [])).at(-1);
    return { summary: next.value, output, host };
  }

  const flow: Workflow = {
    version: 1,
    name: 'Deploy',
    steps: [
      askStep({ choices: ['dev', 'prod'], default: 'dev' }),
      { id: 'deploy', type: 'console', run: 'deploy ${{ steps.pick.answer }}' },
    ],
  };

  it('answers from the mocks and the defaults without asking anyone', async () => {
    const mocked = await simulate(flow, { blocks: { pick: [{ answer: 'prod' }] } });
    expect(mocked.output('pick')).toMatchObject({ status: 'success', answer: 'prod', timedOut: false });
    const fallback = await simulate(flow, {});
    expect(fallback.output('pick')).toMatchObject({ status: 'success', answer: 'dev' });
  });

  it('fails the block like a real run when the mocked answer is not a choice', async () => {
    const r = await simulate(flow, { blocks: { pick: [{ answer: 'staging' }] } });
    expect(r.output('pick')).toMatchObject({
      status: 'failure',
      error: "Answer 'staging' isn't one of the choices of 'pick': dev, prod.",
    });
    expect(r.summary.status).toBe('failure');
  });
});
