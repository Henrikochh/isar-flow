/**
 * If container: a header card, then the river forks into two equal lanes (Then / Else) around a gravel bank
 * and merges again below.
 */
import type { StepSlot } from '@isar-flow/core';
import { useCanvas } from './canvasContext';
import { CardHead, stateClasses } from './BlockCard';
import { BreakableCode } from './BreakableCode';
import type { BlockEntry } from './model';
import { cx } from '../cx';
import { LastRunConditionChip } from '../live/conditionResult';
import { RiverList } from './River';
import { type LaneState, laneState } from './runOverlay';
import { describeSafely } from './summaries';
import { useBlockHandle } from './useBlockHandle';

const LANES: { slot: StepSlot; label: string }[] = [
  { slot: 'then', label: 'Then' },
  { slot: 'else', label: 'Else' },
];

function armState(state: LaneState): string {
  return state === 'untaken' ? 'pending' : state;
}

/**
 * One arm of the fork or merge: a bend at the center line, a straight run and a turn into the lane, both with the
 * same radius whatever the lanes' width.
 */
function Arm({ part, slot, state }: { part: 'fork' | 'merge'; slot: StepSlot; state: string }) {
  const variant = `${part}-${slot === 'else' ? 'else' : 'then'}`;
  return (
    <span className={cx('wf-arm', `wf-arm--${variant}`, `wf-arm--${state}`)}>
      <span className={`wf-bend wf-bend--${variant}`} />
      <span className={`wf-turn wf-turn--${variant}`} />
    </span>
  );
}

/**
 * Both arms of the fork or merge. They overlap where they leave the center line, so when both are dimmed the
 * group is dimmed once instead of each arm (two translucent layers would show a brighter spot).
 */
function Arms({ part, arms }: { part: 'fork' | 'merge'; arms: { slot: StepSlot; state: string }[] }) {
  const dim = arms.every((arm) => arm.state === 'pending');
  return (
    <span className={cx('wf-arms', dim && 'wf-arms--pending')}>
      {arms.map((arm) => (
        <Arm key={arm.slot} part={part} slot={arm.slot} state={dim ? 'idle' : arm.state} />
      ))}
    </span>
  );
}

/** Pointed island outline in a 32 × 100 box, stretched to the height of the lanes. */
const BANK_PATH = 'M16 0 C25 15 32 32 32 50 C32 68 25 85 16 100 C7 85 0 68 0 50 C0 32 7 15 16 0 Z';

/** The gravel bank between the two arms: a long pebbly island, as on the Isar. */
function GravelBank() {
  return (
    <span className="wf-bank" aria-hidden="true">
      <svg className="wf-bank__shape" viewBox="0 0 32 100" preserveAspectRatio="none" focusable="false">
        <path d={BANK_PATH} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="wf-bank__gravel" />
    </span>
  );
}

export function IfBlock({ entry }: { entry: BlockEntry }) {
  const handle = useBlockHandle(entry);
  const { run, awaitingApproval } = useCanvas();
  const condition = describeSafely((entry.step as unknown as Record<string, unknown>).condition);
  const status = handle.status;
  const running = run?.status === 'running' && status === 'running';
  const lanes = LANES.map((lane) => ({ ...lane, state: laneState(run, entry, lane.slot) }));
  const stem = !run ? 'idle' : status === 'pending' || status === 'skipped' ? 'pending' : 'passed';
  const merged = !run ? 'idle' : status === 'success' ? 'passed' : 'pending';
  const awaiting = entry.id !== undefined && awaitingApproval.has(entry.id);

  return (
    <div
      className={cx('wf-if', handle.dragging && 'wf-if--dragging', status === 'skipped' && 'wf-if--skipped')}
      data-type="if"
    >
      <div
        {...handle.props}
        className={stateClasses('wf-card', entry, handle, running, awaiting)}
        data-type="if"
      >
        <CardHead entry={entry} handle={handle} />
        <div className="wf-card__body">
          <div className="wf-ifcond">
            <span className="wf-ifcond__kw">If</span>{' '}
            {condition ? (
              <BreakableCode className="wf-ifcond__text" title={condition} text={condition} />
            ) : (
              <span className="wf-card__placeholder">No condition yet</span>
            )}
          </div>
          <LastRunConditionChip step={entry.step} className="wf-live-cond" />
        </div>
      </div>
      <div className="wf-split">
        <GravelBank />
        <div className="wf-fork" aria-hidden="true">
          <span className={`wf-fork__stem wf-line wf-line--${stem}`} />
          <Arms part="fork" arms={lanes.map((lane) => ({ slot: lane.slot, state: armState(lane.state) }))} />
          {lanes.map((lane) => (
            <span
              key={`label-${lane.slot}`}
              className={cx(
                'wf-lane-label',
                `wf-lane-label--${lane.slot}`,
                lane.state === 'passed' && 'wf-lane-label--taken',
              )}
            >
              {lane.label}
            </span>
          ))}
        </div>
        <div className="wf-lanes">
          {lanes.map((lane) => {
            const list = entry.children.find((c) => c.info.slot === lane.slot);
            return (
              <div key={lane.slot} className="wf-lane" role="group" aria-label={lane.label}>
                {list ? <RiverList list={list} owner={entry} grow /> : null}
              </div>
            );
          })}
        </div>
        <div className="wf-merge" aria-hidden="true">
          <Arms
            part="merge"
            arms={lanes.map((lane) => ({
              slot: lane.slot,
              state: lane.state === 'passed' ? merged : armState(lane.state),
            }))}
          />
          <span className={`wf-merge__stem wf-line wf-line--${merged}`} />
        </div>
      </div>
    </div>
  );
}
