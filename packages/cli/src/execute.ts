import { createSimulationHost, type RunSummary, runWorkflow, workflowUsesRoot } from '@isar-flow/core';
import { captureGitContext } from '@isar-flow/core/node';
import { displayPath, workspacePath } from './diagnostics';
import { createStyle } from './format';
import type { CliIo } from './io';
import { jsonResult } from './json';
import { createLineReader } from './lineReader';
import { createHumanReporter, useColor } from './output';
import type { PreparedRun, RunCommand } from './prepare';
import { createRunHost } from './runHost';
import { processEnv } from './secrets';

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CANCELLED = 130;

const EXIT_CODES: Record<RunSummary['status'], number> = {
  success: EXIT_SUCCESS,
  failure: EXIT_FAILURE,
  cancelled: EXIT_CANCELLED,
};

/** Runs a prepared workflow, printing progress, and resolves with the exit code. */
export async function executeRun(run: PreparedRun, command: RunCommand, io: CliIo): Promise<number> {
  const human = command.json ? io.stderr : io.stdout;
  const write = (text: string) => void human.write(text);
  for (const warning of run.warnings) io.stderr.write(`${warning}\n`);

  const controller = new AbortController();
  const stop = () => controller.abort(io.signal?.reason);
  if (io.signal?.aborted) stop();
  io.signal?.addEventListener('abort', stop, { once: true });
  const now = io.now ?? Date.now;
  const runId = `run-${now().toString(36)}`;
  const reader = !command.simulate && io.stdin.isTTY ? createLineReader(io.stdin, io.stderr) : undefined;

  try {
    const host = run.simulation
      ? createSimulationHost({ file: run.simulation.file, delayMs: 0 })
      : createRunHost({ run, runId, io, yes: command.yes, ...(reader && { reader }) });
    const file = workspacePath(run.file, run.root);
    const usesGit = workflowUsesRoot(run.workflow, 'git');
    write(`Running ${run.workflow.name} (${file})\n`);
    if (run.simulation) {
      const source = run.simulation.path
        ? `results come from ${displayPath(run.simulation.path, io.cwd)}`
        : 'every block gets its default result';
      write(`Simulated run: nothing is executed; ${source}.\n`);
      if (usesGit) write("git.* is empty: simulated runs don't run git.\n");
    }
    write('\n');

    // git can start programs the repository configures (core.fsmonitor), so a simulation never runs it.
    const git =
      usesGit && !run.simulation
        ? await (io.captureGit ?? captureGitContext)(run.root, { signal: controller.signal })
        : undefined;
    const report = createHumanReporter(write, createStyle(useColor(human, io.env)));
    const events = runWorkflow(run.workflow, {
      runId,
      inputs: run.inputs,
      host,
      agents: run.agents,
      signal: controller.signal,
      env: processEnv(io.env),
      secrets: run.secrets,
      workflowFile: run.file,
      workspaceRoot: run.root,
      defaultShell: 'auto',
      origin: { kind: 'cli' },
      ...(run.simulation && { simulated: true }),
      ...(git && { git }),
      ...(io.now && { now: io.now }),
    });

    let inputs = run.inputs;
    let next = await events.next();
    while (!next.done) {
      if (next.value.type === 'run-start') inputs = next.value.inputs;
      report(next.value);
      next = await events.next();
    }
    const summary = next.value;
    if (command.json) {
      const result = jsonResult(summary, {
        name: run.workflow.name,
        file,
        inputs,
        simulated: run.simulation !== undefined,
      });
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return EXIT_CODES[summary.status];
  } finally {
    reader?.close();
    io.signal?.removeEventListener('abort', stop);
  }
}
