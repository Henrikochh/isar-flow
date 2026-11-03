import { describe, expect, it } from 'vitest';
import { jsonFailure, jsonResult } from '../src/json';

describe('JSON result', () => {
  it('describes the run with each block status, error and outputs', () => {
    const result = jsonResult(
      {
        runId: 'run-1',
        status: 'failure',
        error: "Block 'test' failed.",
        durationMs: 1500,
        usage: { inputTokens: 10, outputTokens: 2 },
        steps: {
          build: { status: 'success', durationMs: 1000, exitCode: 0, stdout: 'ok\n' },
          test: { status: 'failure', durationMs: 500, error: 'Exit code 1' },
          later: { status: 'skipped' },
        },
      },
      {
        name: 'CI',
        file: '.isarflow/workflows/ci.workflow.yaml',
        inputs: { branch: 'main' },
        simulated: false,
      },
    );
    expect(result).toEqual({
      runId: 'run-1',
      workflow: { name: 'CI', file: '.isarflow/workflows/ci.workflow.yaml' },
      status: 'failure',
      durationMs: 1500,
      error: "Block 'test' failed.",
      usage: { inputTokens: 10, outputTokens: 2 },
      origin: { kind: 'cli' },
      inputs: { branch: 'main' },
      steps: {
        build: { status: 'success', durationMs: 1000, output: { exitCode: 0, stdout: 'ok\n' } },
        test: { status: 'failure', durationMs: 500, error: 'Exit code 1' },
        later: { status: 'skipped' },
      },
    });
  });

  it('marks simulated runs', () => {
    const result = jsonResult(
      { runId: 'r', status: 'success', durationMs: 1, usage: { inputTokens: 0, outputTokens: 0 }, steps: {} },
      { name: 'W', file: 'w.workflow.yaml', inputs: {}, simulated: true },
    );
    expect(result.simulated).toBe(true);
  });

  it('describes a failure before the run', () => {
    expect(jsonFailure("Could not find 'x'.")).toEqual({ status: 'failure', error: "Could not find 'x'." });
    expect(jsonFailure('Bad.', { name: 'W', file: 'w.yaml' }, ['w.yaml:1:1 error Bad.'])).toEqual({
      status: 'failure',
      error: 'Bad.',
      workflow: { name: 'W', file: 'w.yaml' },
      details: ['w.yaml:1:1 error Bad.'],
    });
  });
});
