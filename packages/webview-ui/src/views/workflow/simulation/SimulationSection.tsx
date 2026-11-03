/**
 * Inspector section "Simulation": what a console, agent or approval block returns when simulated, written to
 * the workflow's simulation file through the host.
 */
import { useEffect, useRef } from 'react';
import type { SimulationResult, SimulationState } from '@isar-flow/core';
import { Banner, Button, Chip } from '../../../components';
import { Disclosure } from '../inspector/settings/common';
import { useLiveData } from '../live/LiveDataProvider';
import { useWorkflowState } from '../store';
import { MockRowEditor } from './MockRowEditor';
import { defaultsText, type MockKind, mockKind, newRow, prettyJson, rowProblem, sampleFor } from './mockRows';
import { useMocksDraft } from './useMocksDraft';
import './simulation.css';

type Raw = Record<string, unknown>;

const NO_RESULTS: SimulationResult[] = [];

/** First field of a new row (after the "Fail this call" switch). */
const FIRST_FIELD = 'input:not([role="switch"]), textarea, [role="radio"][tabindex="0"]';

export interface SimulationSectionProps {
  stepId: string;
  /** The block's YAML mapping (lenient). */
  step: Raw;
}

/** Nothing until the host has sent the simulation state, and nothing for blocks without host calls. */
export function SimulationSection({ stepId, step }: SimulationSectionProps) {
  const { simulation } = useLiveData();
  const kind = mockKind(step);
  if (!simulation || !kind) return null;
  return <SimulationEditor simulation={simulation} stepId={stepId} step={step} kind={kind} />;
}

/** The block's results; while a rename waits for the host, the results under the old id. */
function useBlockResults(simulation: SimulationState, stepId: string): SimulationResult[] {
  const { renamedFrom } = useWorkflowState();
  const blocks = simulation.file.blocks ?? {};
  if (Object.hasOwn(blocks, stepId)) return blocks[stepId];
  const before = renamedFrom?.[stepId];
  return before && Object.hasOwn(blocks, before) ? blocks[before] : NO_RESULTS;
}

function Defaults({ kind, step, simulation }: { kind: MockKind; step: Raw; simulation: SimulationState }) {
  return (
    <div className="wf-sim-defaults">
      <p className="wf-sim-muted">{defaultsText(kind, simulation.file.approvals)}</p>
      {kind === 'json' ? <pre className="wf-sim-sample">{prettyJson(sampleFor(step))}</pre> : null}
    </div>
  );
}

function SimulationEditor({
  simulation,
  stepId,
  step,
  kind,
}: SimulationSectionProps & { simulation: SimulationState; kind: MockKind }) {
  const { setSimulationMocks, openSimulationFile } = useLiveData();
  const results = useBlockResults(simulation, stepId);
  const errors = simulation.diagnostics.filter((d) => d.severity === 'error');
  const warnings = simulation.diagnostics.filter((d) => d.severity !== 'error' && d.stepId === stepId);
  const draft = useMocksDraft(
    results,
    (next) => setSimulationMocks(stepId, next.length ? next : null),
    (rows) => rows.every((row) => rowProblem(row, kind) === undefined),
  );
  const listRef = useRef<HTMLOListElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<{ key: number; action: string } | 'add' | 'new' | null>(null);
  const defaultApproved = simulation.file.approvals !== 'reject';

  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (!target) return;
    if (target === 'add') {
      addRef.current?.focus();
    } else if (target === 'new') {
      const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-row]');
      rows?.[rows.length - 1]?.querySelector<HTMLElement>(FIRST_FIELD)?.focus();
    } else {
      // A moved row keeps the focus on the same action, or on the other move button at the top or bottom.
      const row = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${target.key}"]`);
      const enabled = (action: string) => {
        const button = row?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
        return button && !button.disabled ? button : undefined;
      };
      (enabled(target.action) ?? enabled('up') ?? enabled('down') ?? enabled('remove'))?.focus();
    }
  }, [draft.rows]);

  const fileBroken = errors.length > 0;
  const count = draft.rows.length;
  return (
    <Disclosure
      title="Simulation"
      defaultOpen={results.length > 0 || warnings.length > 0 || fileBroken}
      summary={
        fileBroken ? (
          <Chip tone="error" icon="error">
            File has errors
          </Chip>
        ) : count ? (
          <Chip tone="outline">{count === 1 ? '1 result' : `${count} results`}</Chip>
        ) : undefined
      }
    >
      <p className="wf-sim-hint">
        What this block returns when you simulate, one result per call. The last one repeats.
      </p>
      {fileBroken ? (
        <Banner
          tone="error"
          title="The simulation file has errors, so Simulate won't start."
          actions={
            <Button size="s" variant="secondary" icon="go-to-file" onClick={openSimulationFile}>
              Open simulation file
            </Button>
          }
        >
          {errors[0].message}
        </Banner>
      ) : (
        <>
          {warnings.length ? (
            <Banner tone="warning">
              {warnings.map((warning, index) => (
                <p key={index} className="wf-sim-warning">
                  {warning.message}
                </p>
              ))}
            </Banner>
          ) : null}
          {count ? (
            <ol className="wf-sim-rows" ref={listRef}>
              {draft.rows.map((row, index) => (
                <MockRowEditor
                  key={row.key}
                  row={row}
                  index={index}
                  count={count}
                  kind={kind}
                  defaultApproved={defaultApproved}
                  onChange={(change, mode) => draft.update(index, change, mode)}
                  onFlush={draft.flush}
                  onMove={(delta) => {
                    focusAfter.current = { key: row.key, action: delta < 0 ? 'up' : 'down' };
                    draft.move(index, delta);
                  }}
                  onRemove={() => {
                    const next = draft.rows[index + 1] ?? draft.rows[index - 1];
                    focusAfter.current = next ? { key: next.key, action: 'remove' } : 'add';
                    draft.remove(index);
                  }}
                />
              ))}
            </ol>
          ) : (
            <Defaults kind={kind} step={step} simulation={simulation} />
          )}
          <div className="wf-sim-actions">
            <Button
              ref={addRef}
              size="s"
              variant="ghost"
              icon="add"
              onClick={() => {
                focusAfter.current = 'new';
                draft.add((key) => newRow(kind, step, simulation.file.approvals, key));
              }}
            >
              Add result
            </Button>
          </div>
          <div>
            <Button variant="link" title={simulation.path} onClick={openSimulationFile}>
              Open simulation file
            </Button>
          </div>
        </>
      )}
    </Disclosure>
  );
}
