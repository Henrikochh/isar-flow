import type { ComponentType } from 'react';
import type { BlockNode, StepType } from '@isar-flow/core';
import { LiveStepProvider } from '../../live/liveStep';
import { SimulationSection } from '../../simulation/SimulationSection';
import { useWorkflowActions, useWorkflowState } from '../../store';
import { IssueBanner } from '../Issues';
import { blockIssues, isRecord, isStepType } from '../model';
import { AgentSettings } from './AgentSettings';
import { type SettingsProps, useStepUpdate } from './common';
import { ConsoleSettings } from './ConsoleSettings';
import { LoopSettings } from './LoopSettings';
import { ApprovalSettings, BreakSettings, IfSettings, StopSettings, UnknownSettings } from './OtherSettings';

const PANELS: Record<StepType, ComponentType<SettingsProps>> = {
  agent: AgentSettings,
  console: ConsoleSettings,
  loop: LoopSettings,
  if: IfSettings,
  break: BreakSettings,
  stop: StopSettings,
  approval: ApprovalSettings,
};

/** Block properties each panel renders; diagnostics on other properties are listed at the top. */
const FIELDS: Record<StepType, string[]> = {
  agent: ['agent', 'model', 'prompt', 'output', 'session', 'context', 'timeout', 'retry', 'continueOnError'],
  console: ['run', 'shell', 'cwd', 'env', 'continueOnError', 'timeout', 'retry'],
  loop: ['until', 'while', 'maxIterations', 'onMaxIterations'],
  if: ['condition'],
  break: [],
  stop: ['outcome', 'message'],
  approval: ['message', 'onReject'],
};

/** Header fields render their own diagnostics. */
export const HEADER_FIELDS = ['id', 'name'];

export function BlockSettings({ block, stepId }: { block: BlockNode; stepId: string }) {
  const diagnostics = useWorkflowState().doc?.diagnostics ?? [];
  const actions = useWorkflowActions();
  const update = useStepUpdate(stepId);
  const step = isRecord(block.step) ? (block.step as unknown as Record<string, unknown>) : {};
  const type = isStepType(step.type) ? step.type : undefined;
  // The unknown-type panel explains the type problem itself.
  const fields = [...HEADER_FIELDS, ...(type ? FIELDS[type] : ['type'])];
  const { byField, general } = blockIssues(diagnostics, block, fields);
  const Panel = type ? PANELS[type] : UnknownSettings;
  return (
    <LiveStepProvider stepId={stepId}>
      <div className="wf-insp-form">
        <IssueBanner issues={general} subject="this block" onShowYaml={() => actions.openYaml(stepId)} />
        <Panel block={block} step={step} stepId={stepId} update={update} issues={byField} />
        <SimulationSection stepId={stepId} step={step} />
      </div>
    </LiveStepProvider>
  );
}
