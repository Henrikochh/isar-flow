import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMORY_FILE, MEMORY_PROMPT_MAX_BYTES, newMemoryText } from '../src/agent/memory';
import { runWorkflow, workflowUsesRoot } from '../src/engine';
import type { RunEvent } from '../src/engine/types';
import type { AgentDefinition, Workflow } from '../src/schema/types';
import { checkSimulationText, createSimulationHost } from '../src/simulation';
import { validateWorkflow } from '../src/validate';
import { parseProjectConfigText, parseWorkflowText } from '../src/yaml';

// The files in examples/ are documentation people copy; they must stay valid.
const examples = path.resolve(__dirname, '../../../examples');
const simulations = path.join(examples, '.isarflow', 'simulations');
const read = (file: string) => fs.readFileSync(file, 'utf8');

const workflowOf = (file: string): Workflow => {
  const { workflow, valid, diagnostics } = parseWorkflowText(read(file));
  expect(diagnostics, path.basename(file)).toEqual([]);
  expect(valid).toBe(true);
  return workflow as Workflow;
};

const agents: Record<string, AgentDefinition> = {
  coder: { name: 'Coder', model: 'litellm/coder' },
  reviewer: { name: 'Reviewer', model: 'litellm/reviewer' },
};
const agentIds = fs
  .readdirSync(path.join(examples, 'agents'))
  .map((name) => name.replace(/\.agent\.yaml$/, ''));

/** Runs a workflow to its end and returns the final result and the block ends. */
async function runToEnd(run: ReturnType<typeof runWorkflow>) {
  const ends: Extract<RunEvent, { type: 'step-end' }>[] = [];
  let next = await run.next();
  while (!next.done) {
    if (next.value.type === 'step-end') ends.push(next.value);
    next = await run.next();
  }
  return { result: next.value, ends };
}

describe('examples', () => {
  const workflows = fs.readdirSync(examples).filter((name) => name.endsWith('.workflow.yaml'));
  const mocks = fs.readdirSync(simulations).filter((name) => name.endsWith('.sim.yaml'));

  it.each(workflows)('%s parses without problems', (name) => {
    workflowOf(path.join(examples, name));
  });

  it.each(workflows)('%s passes validation with the example agents', (name) => {
    const workflow = workflowOf(path.join(examples, name));
    const problems = validateWorkflow(workflow, { agentIds, secretNames: [] }).filter(
      (d) => d.severity !== 'info',
    );
    expect(problems).toEqual([]);
  });

  it('has an example for each everyday feature: selection, save trigger, ask block and Copilot', () => {
    const all = workflows.map((name) => workflowOf(path.join(examples, name)));
    expect(all.some((w) => workflowUsesRoot(w, 'editor'))).toBe(true);
    expect(all.some((w) => w.on?.save !== undefined)).toBe(true);
    expect(all.some((w) => w.expose === true && w.steps.some((s) => s.type === 'ask'))).toBe(true);
  });

  it('has a valid command line config without API keys', () => {
    const text = read(path.join(examples, '.isarflow', 'config.yaml'));
    const { valid, diagnostics, config } = parseProjectConfigText(text);
    expect(diagnostics).toEqual([]);
    expect(valid).toBe(true);
    expect(config?.providers?.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/apiKey\s*:/);
  });

  it('has a project memory that starts like a new one and fits the prompt', () => {
    const text = read(path.join(examples, ...MEMORY_FILE.split('/')));
    expect(text.startsWith(newMemoryText())).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThan(MEMORY_PROMPT_MAX_BYTES);
    expect(text.trimEnd().split('\n').at(-1)).toMatch(/^- \d{4}-\d{2}-\d{2}: /);
  });

  it('asks which environment to deploy to and deploys the answer', async () => {
    const workflow = workflowOf(path.join(examples, 'deploy.workflow.yaml'));
    const { file } = checkSimulationText(
      'version: 1\nblocks:\n  pick-env:\n    - answer: staging\n',
      workflow,
    );
    const { result, ends } = await runToEnd(
      runWorkflow(workflow, {
        runId: 'deploy',
        inputs: {},
        agents,
        workspaceRoot: '/ws',
        simulated: true,
        host: createSimulationHost({ file }),
      }),
    );
    expect(result.status).toBe('success');
    const answer = ends.find((e) => e.stepId === 'pick-env')?.output.answer;
    expect(answer).toBe('staging');
  });

  it.each(mocks)('%s fits the workflow of the same name', (name) => {
    const workflowFile = path.join(examples, name.replace(/\.sim\.yaml$/, '.workflow.yaml'));
    const { diagnostics } = checkSimulationText(read(path.join(simulations, name)), workflowOf(workflowFile));
    expect(diagnostics).toEqual([]);
  });

  it('simulates the review loop: the tests fail in round 1, round 2 passes and is approved', async () => {
    const workflow = workflowOf(path.join(examples, 'review-loop.workflow.yaml'));
    const { file } = checkSimulationText(read(path.join(simulations, 'review-loop.sim.yaml')), workflow);
    const run = runWorkflow(workflow, {
      runId: 'example',
      inputs: { task: 'Add voucher codes' },
      agents,
      workspaceRoot: '/ws',
      simulated: true,
      host: createSimulationHost({ file }),
    });
    const { result, ends } = await runToEnd(run);
    expect(result.status).toBe('success');
    const of = (id: string) => ends.filter((e) => e.stepId === id);
    expect(of('tests').map((e) => e.output.exitCode)).toEqual([1, 0]);
    expect(of('fix').map((e) => e.status)).toEqual(['success', 'skipped']);
    expect(of('review_loop')[0].output).toMatchObject({ iterations: 2, exitReason: 'condition' });
  });
});
