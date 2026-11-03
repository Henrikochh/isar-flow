import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWorkflow } from '../src/engine';
import type { RunEvent } from '../src/engine/types';
import type { AgentDefinition, Workflow } from '../src/schema/types';
import { checkSimulationText, createSimulationHost } from '../src/simulation';
import { parseWorkflowText } from '../src/yaml';

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

describe('examples', () => {
  const workflows = fs.readdirSync(examples).filter((name) => name.endsWith('.workflow.yaml'));
  const mocks = fs.readdirSync(simulations).filter((name) => name.endsWith('.sim.yaml'));

  it.each(workflows)('%s parses without problems', (name) => {
    workflowOf(path.join(examples, name));
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
    const ends: Extract<RunEvent, { type: 'step-end' }>[] = [];
    let next = await run.next();
    while (!next.done) {
      if (next.value.type === 'step-end') ends.push(next.value);
      next = await run.next();
    }
    expect(next.value.status).toBe('success');
    const of = (id: string) => ends.filter((e) => e.stepId === id);
    expect(of('tests').map((e) => e.output.exitCode)).toEqual([1, 0]);
    expect(of('fix').map((e) => e.status)).toEqual(['success', 'skipped']);
    expect(of('review_loop')[0].output).toMatchObject({ iterations: 2, exitReason: 'condition' });
  });
});
