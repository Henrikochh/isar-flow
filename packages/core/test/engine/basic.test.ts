import { describe, expect, it } from 'vitest';
import { resolveInputs } from '../../src/engine';
import type { Step } from '../../src/schema/types';
import { FakeHost } from '../fakes/fakeHost';
import { eventsOfType, run, workflow } from './helpers';

describe('run lifecycle', () => {
  it('emits run-start, step events and run-end in order and returns a summary', async () => {
    const r = await run(
      workflow([
        { id: 'a', type: 'console', run: 'echo a' },
        { id: 'b', type: 'console', run: 'echo b' },
      ]),
    );
    expect(r.trace).toEqual([
      'run-start',
      'start:a',
      'end:a:success',
      'start:b',
      'end:b:success',
      'run:success',
    ]);
    expect(r.events[0]).toEqual({
      type: 'run-start',
      runId: 'run-1',
      workflowName: 'Test workflow',
      startedAt: 1010,
      inputs: {},
      context: {
        env: [],
        secrets: [],
        workflow: { name: 'Test workflow', file: '' },
        workspace: { root: '/ws' },
      },
      blockHashes: { a: expect.any(String), b: expect.any(String) },
    });
    expect(r.summary).toMatchObject({
      runId: 'run-1',
      status: 'success',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(r.summary.error).toBeUndefined();
    expect(Object.keys(r.summary.steps)).toEqual(['a', 'b']);
    const runEnd = r.events.at(-1);
    expect(runEnd).toMatchObject({ type: 'run-end', status: 'success', durationMs: r.summary.durationMs });
  });

  it('uses the injected clock for timestamps and durations', async () => {
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]));
    const start = eventsOfType(r.events, 'step-start')[0];
    const end = eventsOfType(r.events, 'step-end')[0];
    expect(end.at).toBeGreaterThan(start.at);
    expect(end.durationMs).toBe(end.at - start.at);
    expect(end.output.durationMs).toBe(end.durationMs);
  });

  it('succeeds with an empty workflow', async () => {
    const r = await run(workflow([]));
    expect(r.trace).toEqual(['run-start', 'run:success']);
  });

  it('fails a block of unknown type with a helpful message instead of an engine error', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([
        { id: 'fan', type: 'parallel', steps: [] } as unknown as Step,
        { id: 'after', type: 'console', run: 'never' },
      ]),
      { host },
    );
    expect(r.trace).toEqual(['run-start', 'start:fan', 'end:fan:failure', 'run:failure']);
    expect(r.error('fan')).toBe(
      "Unknown block type 'parallel'. Use one of: agent, console, loop, if, break, stop, approval.",
    );
    expect(r.summary.error).toBe(
      "Block 'fan' failed: Unknown block type 'parallel'. Use one of: agent, console, loop, if, break, stop, approval.",
    );
    expect(host.calls).toHaveLength(0);
  });

  it('defaults to Date.now when no clock is given', async () => {
    const before = Date.now();
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), { now: undefined });
    const start = r.events[0];
    expect(start.type === 'run-start' && start.startedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('console blocks', () => {
  it('sends the rendered request with shell, cwd, env and timeout', async () => {
    const host = new FakeHost();
    await run(
      workflow(
        [
          {
            id: 'build',
            type: 'console',
            run: 'npm run ${{ inputs.script }}',
            cwd: 'packages/${{ inputs.pkg }}',
            env: { MODE: '${{ inputs.script }}-mode' },
            shell: 'bash',
            timeout: 30,
          },
        ],
        { env: { CI: '1', WHO: '${{ env.USER }}' } },
      ),
      { host, inputs: { script: 'test', pkg: 'core' }, env: { USER: 'anna', PATH: '/bin' } },
    );
    expect(host.consoleCalls).toEqual([
      {
        stepId: 'build',
        command: 'npm run test',
        shell: 'bash',
        cwd: 'packages/core',
        env: { CI: '1', WHO: 'anna', MODE: 'test-mode' },
        timeoutMs: 30_000,
      },
    ]);
  });

  it('falls back to the default shell, then auto, and to the workspace root as cwd', async () => {
    const host = new FakeHost();
    await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), { host, defaultShell: 'pwsh' });
    expect(host.consoleCalls[0]).toMatchObject({ shell: 'pwsh', cwd: '/ws', env: {} });
    expect(host.consoleCalls[0].timeoutMs).toBeUndefined();

    const host2 = new FakeHost();
    await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), { host: host2 });
    expect(host2.consoleCalls[0].shell).toBe('auto');
  });

  it('exposes console outputs to later blocks', async () => {
    const host = new FakeHost().console('tests', { exitCode: 0, stdout: '3 passed\n', stderr: 'warn\n' });
    const r = await run(
      workflow([
        { id: 'tests', type: 'console', run: 'npm test' },
        {
          id: 'report',
          type: 'console',
          run: 'echo "${{ steps.tests.exitCode }}: ${{ trim(steps.tests.stdout) }}"',
        },
      ]),
      { host },
    );
    expect(host.consoleCalls[1].command).toBe('echo "0: 3 passed"');
    expect(r.output('tests')).toEqual({
      exitCode: 0,
      stdout: '3 passed\n',
      stderr: 'warn\n',
      output: '3 passed\nwarn\n',
      timedOut: false,
      status: 'success',
      durationMs: expect.any(Number),
    });
    expect(r.summary.steps.tests.status).toBe('success');
  });

  it('fails the block and the run on a non-zero exit code', async () => {
    const host = new FakeHost().console('tests', { exitCode: 2, stderr: 'boom' });
    const r = await run(
      workflow([
        { id: 'tests', type: 'console', run: 'npm test' },
        { id: 'after', type: 'console', run: 'echo never' },
      ]),
      { host },
    );
    expect(r.trace).toEqual(['run-start', 'start:tests', 'end:tests:failure', 'run:failure']);
    expect(r.error('tests')).toBe('Command exited with code 2');
    expect(r.output('tests')).toMatchObject({ exitCode: 2, stderr: 'boom', status: 'failure' });
    expect(r.summary.status).toBe('failure');
    expect(r.summary.error).toBe("Block 'tests' failed: Command exited with code 2");
    expect(host.callOrder).toEqual(['tests']);
  });

  it('reports a host-side timeout as a failure', async () => {
    const host = new FakeHost().console('slow', { exitCode: 1, timedOut: true });
    const r = await run(workflow([{ id: 'slow', type: 'console', run: 'x', timeout: 3 }]), { host });
    expect(r.error('slow')).toBe('Timed out after 3s');
    expect(r.output('slow')).toMatchObject({ timedOut: true, status: 'failure' });
  });

  it('continues after a failure with continueOnError and keeps the failure status', async () => {
    const host = new FakeHost().console('tests', { exitCode: 1 });
    const r = await run(
      workflow([
        { id: 'tests', type: 'console', run: 'npm test', continueOnError: true },
        { id: 'next', type: 'console', run: 'echo ${{ steps.tests.exitCode }} ${{ steps.tests.status }}' },
      ]),
      { host },
    );
    expect(r.summary.status).toBe('success');
    expect(r.output('tests')?.status).toBe('failure');
    expect(host.consoleCalls[1].command).toBe('echo 1 failure');
  });

  it('turns host exceptions into block failures', async () => {
    const host = new FakeHost().console('a', { error: 'Shell "pwsh" was not found' });
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), { host });
    expect(r.error('a')).toBe('Shell "pwsh" was not found');
    expect(r.summary.error).toBe('Block \'a\' failed: Shell "pwsh" was not found');
  });

  it('names a host failure that came without a message', async () => {
    const host = new FakeHost().console('a', { error: new Error('') });
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), { host });
    expect(r.error('a')).toBe('Unknown error');
    expect(r.summary.error).toBe("Block 'a' failed: Unknown error");
  });

  it('keeps the name of an error without a message when it is meaningful', async () => {
    const error = new Error('');
    error.name = 'TimeoutError';
    const host = new FakeHost().console('a', { error });
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), { host });
    expect(r.error('a')).toBe('TimeoutError');
  });

  it('puts the rendered command into step-start detail and the loop iteration when inside a loop', async () => {
    const r = await run(
      workflow([
        { id: 'a', type: 'console', run: 'echo ${{ workflow.name }}' },
        { id: 'l', type: 'loop', maxIterations: 1, steps: [{ id: 'b', type: 'console', run: 'b' }] },
      ]),
    );
    const starts = eventsOfType(r.events, 'step-start');
    expect(starts[0]).toMatchObject({ stepId: 'a', stepType: 'console', detail: 'echo Test workflow' });
    expect(starts[0].iteration).toBeUndefined();
    expect(starts.find((s) => s.stepId === 'b')).toMatchObject({ iteration: 1, detail: 'b' });
  });
});

describe('expression context', () => {
  it('provides inputs, env, workflow, workspace, run and secrets', async () => {
    const host = new FakeHost();
    await run(
      workflow(
        [
          {
            id: 'a',
            type: 'console',
            run: '${{ inputs.task }}|${{ env.HOME }}|${{ env.CI }}|${{ workflow.name }}|${{ workflow.file }}|${{ workspace.root }}|${{ run.id }}|${{ secrets.TOKEN }}|${{ loop.iteration }}',
          },
        ],
        { name: 'Ctx', env: { CI: 'yes' } },
      ),
      {
        host,
        inputs: { task: 'T' },
        env: { HOME: '/home/me', CI: 'overridden' },
        workflowFile: '/ws/.isarflow/workflows/ctx.workflow.yaml',
        secrets: { TOKEN: 's3cret' },
        runId: 'r42',
      },
    );
    expect(host.consoleCalls[0].command).toBe(
      'T|/home/me|yes|Ctx|/ws/.isarflow/workflows/ctx.workflow.yaml|/ws|r42|s3cret|',
    );
  });

  it('applies input defaults and coerces numbers and booleans', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow(
        [
          {
            id: 'a',
            type: 'console',
            run: '${{ inputs.count + 1 }} ${{ inputs.strict ? "on" : "off" }} ${{ inputs.name }}',
          },
        ],
        {
          inputs: {
            count: { type: 'number', default: 2 },
            strict: { type: 'boolean', default: true },
            name: { type: 'string', default: 'world' },
          },
        },
      ),
      { host, inputs: { strict: 'false' } },
    );
    expect(host.consoleCalls[0].command).toBe('3 off world');
    expect(r.events[0]).toMatchObject({ inputs: { count: 2, strict: false, name: 'world' } });
  });

  it('fails the run when a required input is missing', async () => {
    const r = await run(
      workflow([{ id: 'a', type: 'console', run: 'x' }], { inputs: { task: { required: true } } }),
    );
    expect(r.trace).toEqual(['run-start', 'run:failure']);
    expect(r.summary.error).toBe("Input 'task' is required. Provide a value when starting the run.");
  });

  it('fails the run when workflow env cannot be rendered', async () => {
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }], { env: { BAD: '${{ nope( }}' } }));
    expect(r.trace).toEqual(['run-start', 'run:failure']);
    expect(r.summary.error).toMatch(/^Expression error in env\.BAD: /);
  });
});

describe('resolveInputs', () => {
  it('passes through undeclared inputs and keeps provided values', () => {
    expect(resolveInputs({ a: { type: 'string' } }, { a: 'x', extra: 5 })).toEqual({ a: 'x', extra: 5 });
  });

  it('coerces by declared type', () => {
    expect(
      resolveInputs(
        {
          n: { type: 'number' },
          b: { type: 'boolean' },
          s: { type: 'string' },
          d: { type: 'number', default: '7' },
        },
        { n: ' 42 ', b: 'yes', s: 3 },
      ),
    ).toEqual({ n: 42, b: true, s: '3', d: 7 });
  });

  it('treats empty strings as missing so defaults apply', () => {
    expect(
      resolveInputs({ n: { type: 'number', default: 1 }, s: { default: 'd' } }, { n: '', s: '' }),
    ).toEqual({
      n: 1,
      s: 'd',
    });
  });

  it('rejects values that are not numbers for number inputs', () => {
    expect(() => resolveInputs({ n: { type: 'number' } }, { n: 'abc' })).toThrow(
      "Input 'n' must be a number, but got 'abc'.",
    );
  });

  it('leaves optional inputs without default undefined', () => {
    expect(resolveInputs({ opt: { type: 'string' } }, {})).toEqual({});
  });
});

describe('expression errors', () => {
  it('fails the block with the field name and does not call the host', async () => {
    const host = new FakeHost();
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'echo ${{ steps.x.y + }}' }]), { host });
    expect(r.trace).toEqual(['run-start', 'start:a', 'end:a:failure', 'run:failure']);
    expect(r.error('a')).toMatch(/^Expression error in run: /);
    expect(r.summary.error).toMatch(/^Block 'a' failed: Expression error in run: /);
    expect(host.calls).toHaveLength(0);
    expect(eventsOfType(r.events, 'step-start')[0].detail).toBeUndefined();
  });

  it('names env keys and cwd', async () => {
    const r1 = await run(workflow([{ id: 'a', type: 'console', run: 'x', env: { K: '${{ ) }}' } }]));
    expect(r1.error('a')).toMatch(/^Expression error in env\.K: /);
    const r2 = await run(workflow([{ id: 'a', type: 'console', run: 'x', cwd: '${{ ( }}' }]));
    expect(r2.error('a')).toMatch(/^Expression error in cwd: /);
  });

  it('reports unknown functions and invalid regular expressions', async () => {
    const r1 = await run(workflow([{ id: 'a', type: 'console', run: '${{ nope(1) }}' }]));
    expect(r1.error('a')).toMatch(/^Expression error in run: .*nope/);
    const r2 = await run(workflow([{ id: 'a', type: 'console', run: "${{ matches('x', '(') }}" }]));
    expect(r2.error('a')).toMatch(/^Expression error in run: Invalid regular expression/);
  });

  it('is not retried', async () => {
    const r = await run(workflow([{ id: 'a', type: 'console', run: '${{ ( }}', retry: { max: 3 } }]));
    expect(r.trace).toEqual(['run-start', 'start:a', 'end:a:failure', 'run:failure']);
  });

  it('respects continueOnError', async () => {
    const r = await run(
      workflow([
        { id: 'a', type: 'console', run: '${{ ( }}', continueOnError: true },
        { id: 'b', type: 'console', run: 'ok' },
      ]),
    );
    expect(r.summary.status).toBe('success');
    expect(r.output('a')?.status).toBe('failure');
  });
});
