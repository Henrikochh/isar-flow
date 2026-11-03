/** One mocked result in the Simulation section: its fields per block kind, "Fail this call" and row actions. */
import {
  Chip,
  Field,
  IconButton,
  SegmentedControl,
  Select,
  Switch,
  TextArea,
  TextInput,
} from '../../../components';
import { Group } from '../inspector/settings/common';
import {
  DEFAULT_ERROR,
  type MockKind,
  type MockRow,
  rowProblem,
  setAnswer,
  setApproved,
  setErrorText,
  setExitCode,
  setFailing,
  setJson,
  setText,
} from './mockRows';
import type { CommitMode } from './useMocksDraft';

export interface MockRowEditorProps {
  row: MockRow;
  index: number;
  count: number;
  kind: MockKind;
  /** Decision shown for approval results without one. */
  defaultApproved: boolean;
  /** Ask blocks: the choices the list offers (none for free text) and the answer used without one. */
  ask?: { choices: string[]; fallback: string };
  onChange: (change: (row: MockRow) => MockRow, mode?: CommitMode) => void;
  onFlush: () => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

function KindFields({
  row,
  kind,
  defaultApproved,
  onChange,
  onFlush,
  ask,
}: Pick<MockRowEditorProps, 'row' | 'kind' | 'defaultApproved' | 'ask' | 'onChange' | 'onFlush'>) {
  const problem = rowProblem(row, kind);
  switch (kind) {
    case 'console':
      return (
        <>
          <Field label="Exit code" error={problem}>
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                className="wf-sim-exit"
                inputMode="numeric"
                placeholder="0"
                value={row.exitCode}
                onChange={(event) => onChange((r) => setExitCode(r, event.target.value))}
                onBlur={onFlush}
              />
            )}
          </Field>
          <Field label="Output">
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                code
                autoGrow
                minRows={2}
                maxRows={12}
                placeholder="No output"
                value={row.result.output ?? ''}
                onChange={(event) => onChange((r) => setText(r, 'output', event.target.value))}
                onBlur={onFlush}
              />
            )}
          </Field>
        </>
      );
    case 'text':
      return (
        <Field label="Answer">
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              aria-describedby={describedBy}
              autoGrow
              minRows={2}
              maxRows={12}
              placeholder="(simulated answer)"
              value={row.result.text ?? ''}
              onChange={(event) => onChange((r) => setText(r, 'text', event.target.value))}
              onBlur={onFlush}
            />
          )}
        </Field>
      );
    case 'json':
      return (
        <Field label="Answer (JSON)" error={problem}>
          {({ id, describedBy, invalid }) => (
            <TextArea
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              code
              autoGrow
              minRows={3}
              maxRows={16}
              placeholder="Sample JSON from the JSON fields"
              value={row.json}
              onChange={(event) => onChange((r) => setJson(r, event.target.value))}
              onBlur={onFlush}
            />
          )}
        </Field>
      );
    case 'approval':
      return (
        <>
          <Group label="Decision">
            <SegmentedControl<'approve' | 'reject'>
              label="Decision"
              value={(row.result.approved ?? defaultApproved) ? 'approve' : 'reject'}
              onChange={(value) => onChange((r) => setApproved(r, value === 'approve'), 'now')}
              options={[
                { value: 'approve', label: 'Approve', icon: 'pass' },
                { value: 'reject', label: 'Reject', icon: 'circle-slash' },
              ]}
            />
          </Group>
          <Field label="Comment">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                placeholder="No comment"
                value={row.result.comment ?? ''}
                onChange={(event) => onChange((r) => setText(r, 'comment', event.target.value))}
                onBlur={onFlush}
              />
            )}
          </Field>
        </>
      );
    case 'ask':
      return <AskAnswer row={row} ask={ask} onChange={onChange} onFlush={onFlush} />;
  }
}

const OTHER_ANSWER_HINT = 'Pick a choice, or type another answer to see the block fail.';

/** The answer of an ask block: one of its choices (or typed text) from a list, or free text. */
function AskAnswer({
  row,
  ask = { choices: [], fallback: '' },
  onChange,
  onFlush,
}: Pick<MockRowEditorProps, 'row' | 'ask' | 'onChange' | 'onFlush'>) {
  const answer = row.result.answer;
  if (ask.choices.length === 0) {
    return (
      <Field label="Answer">
        {({ id, describedBy }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            placeholder={ask.fallback}
            value={answer ?? ''}
            onChange={(event) => onChange((r) => setAnswer(r, event.target.value))}
            onBlur={onFlush}
          />
        )}
      </Field>
    );
  }
  const other = answer !== undefined && !ask.choices.includes(answer) ? [answer] : [];
  return (
    <Field label="Answer" hint={OTHER_ANSWER_HINT}>
      {({ id, describedBy }) => (
        <Select
          id={id}
          describedBy={describedBy}
          searchable
          allowCustom
          customLabel={(text) => `Answer "${text}"`}
          placeholder={ask.fallback}
          value={answer}
          options={[
            ...ask.choices.map((choice) => ({ value: choice, label: choice })),
            ...other.map((text) => ({ value: text, label: text, meta: 'Not a choice' })),
          ]}
          onChange={(value) => onChange((r) => setAnswer(r, value), 'now')}
        />
      )}
    </Field>
  );
}

export function MockRowEditor(props: MockRowEditorProps) {
  const { row, index, count, onChange, onFlush, onMove, onRemove } = props;
  const n = index + 1;
  const last = index === count - 1;
  const failing = row.result.error !== undefined;
  return (
    // The item stays a list item; the group inside names the call for assistive tech.
    <li className="wf-sim-item" data-row data-row-key={row.key}>
      <div className="wf-sim-row" role="group" aria-label={`Call ${n}`}>
        <div className="wf-sim-row__head">
          <span className="wf-sim-row__title">{`Call ${n}`}</span>
          {last ? (
            <Chip tone="outline" title="Simulate uses this result again for every later call.">
              Repeats
            </Chip>
          ) : null}
          <span className="wf-sim-row__actions">
            <IconButton
              icon="arrow-up"
              label={`Move call ${n} up`}
              data-action="up"
              disabled={index === 0}
              onClick={() => onMove(-1)}
            />
            <IconButton
              icon="arrow-down"
              label={`Move call ${n} down`}
              data-action="down"
              disabled={last}
              onClick={() => onMove(1)}
            />
            <IconButton icon="trash" label={`Remove call ${n}`} data-action="remove" onClick={onRemove} />
          </span>
        </div>
        <Switch
          checked={failing}
          label="Fail this call"
          onChange={(checked) => onChange((r) => setFailing(r, checked), 'now')}
        />
        {failing ? (
          <Field label="Error message">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                placeholder={DEFAULT_ERROR}
                value={row.error}
                onChange={(event) => onChange((r) => setErrorText(r, event.target.value))}
                onBlur={onFlush}
              />
            )}
          </Field>
        ) : (
          <KindFields {...props} />
        )}
      </div>
    </li>
  );
}
