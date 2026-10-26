import type { BlockNode, Condition } from '@isar-flow/core';
import { Banner, Button, SegmentedControl } from '../../../../components';
import { ConditionBuilder } from '../ConditionBuilder';
import { toTemplate } from '../conditionModel';
import { NumberField } from '../fields';
import { asNumber, isRecord } from '../model';
import { Group, type SettingsProps } from './common';

type RepeatMode = 'until' | 'while' | 'fixed';

function repeatMode(step: Record<string, unknown>): RepeatMode {
  if (step.until !== undefined) return 'until';
  if (step.while !== undefined) return 'while';
  return 'fixed';
}

/** Starting condition when a fixed loop becomes conditional: wait for the first block of the body to succeed. */
function starterCondition(block: BlockNode, mode: 'until' | 'while'): Condition {
  const body = isRecord(block.step) ? (block.step as { steps?: unknown }).steps : undefined;
  const first = Array.isArray(body) ? body.find((s) => isRecord(s) && typeof s.id === 'string' && s.id !== '') : undefined;
  if (isRecord(first)) {
    return { value: toTemplate(`steps.${String(first.id)}.status`), op: mode === 'until' ? 'eq' : 'neq', to: 'success' };
  }
  return { value: toTemplate('loop.iteration'), op: mode === 'until' ? 'gte' : 'lt', to: 3 };
}

export function LoopSettings({ block, step, stepId, update, issues }: SettingsProps) {
  const mode = repeatMode(step);
  const maxIterations = asNumber(step.maxIterations);
  const onMax = step.onMaxIterations === 'continue' ? 'continue' : 'fail';

  const switchMode = (next: RepeatMode) => {
    if (next === mode) return;
    if (next === 'fixed') {
      update({ onMaxIterations: 'continue' }, ['until', 'while']);
    } else if (mode === 'fixed') {
      update({ [next]: starterCondition(block, next) }, ['onMaxIterations']);
    } else {
      update({ [next]: step[mode] }, [mode]);
    }
  };

  return (
    <>
      <Group label="Repeat" issues={mode === 'until' ? issues.get('while') : undefined}>
        <SegmentedControl<RepeatMode>
          label="Repeat"
          full
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'until', label: 'Until' },
            { value: 'while', label: 'While' },
            { value: 'fixed', label: 'Fixed times' },
          ]}
        />
      </Group>

      {mode === 'fixed' ? null : (
        <ConditionBuilder
          key={mode}
          stepId={stepId}
          accent="loop"
          condition={step[mode]}
          summaryPrefix={mode === 'until' ? 'Repeat until' : 'Repeat while'}
          issues={issues.get(mode)}
          onChange={(condition) => update({ [mode]: condition })}
        />
      )}

      <NumberField
        label={mode === 'fixed' ? 'Iterations' : 'Maximum iterations'}
        value={maxIterations}
        min={1}
        max={100}
        integer
        required
        hint={mode === 'fixed' ? 'The blocks run this many times unless a Break block leaves the loop earlier.' : undefined}
        issues={issues.get('maxIterations')}
        onCommit={(value) => {
          if (value !== undefined) update({ maxIterations: value });
        }}
      />

      {mode === 'fixed' && onMax === 'fail' ? (
        <Banner
          tone="warning"
          title="This loop fails the run after its last iteration."
          actions={
            <Button size="s" variant="secondary" onClick={() => update({ onMaxIterations: 'continue' })}>
              Continue after the last iteration
            </Button>
          }
        >
          Without a condition the loop always reaches its limit.
        </Banner>
      ) : null}

      {mode === 'fixed' ? null : (
        <Group label="When the limit is reached" issues={issues.get('onMaxIterations')}>
          <SegmentedControl<'fail' | 'continue'>
            label="When the limit is reached"
            value={onMax}
            onChange={(value) => (value === 'continue' ? update({ onMaxIterations: 'continue' }) : update({}, ['onMaxIterations']))}
            options={[
              { value: 'fail', label: 'Fail the run' },
              { value: 'continue', label: 'Continue' },
            ]}
          />
        </Group>
      )}
    </>
  );
}
