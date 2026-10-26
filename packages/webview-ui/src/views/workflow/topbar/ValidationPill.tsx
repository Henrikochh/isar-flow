import { useRef, useState } from 'react';
import type { Diagnostic } from '@isar-flow/core';
import { Menu, MenuItem, Popover } from '../../../components';
import { useWorkflowActions } from '../store';

function problemCount(diagnostics: Diagnostic[]): string {
  return `${diagnostics.length} ${diagnostics.length === 1 ? 'problem' : 'problems'}`;
}

/** "Ready" when the workflow validates; otherwise "N problems" that opens a list of the diagnostics. */
export function ValidationPill({ diagnostics, valid }: { diagnostics: Diagnostic[]; valid: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const { select, openYaml } = useWorkflowActions();
  const problems = diagnostics.filter((d) => d.severity !== 'info');

  if (!problems.length && valid) {
    return (
      <span className="wf-validity wf-validity--ok" role="status">
        <i className="codicon codicon-pass-filled wf-validity__icon" aria-hidden="true" />
        Ready
      </span>
    );
  }

  const errors = problems.some((d) => d.severity === 'error') || !valid;
  const label = problems.length ? problemCount(problems) : 'Not valid';

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={
          errors
            ? 'wf-validity wf-validity--button wf-validity--error'
            : 'wf-validity wf-validity--button wf-validity--warning'
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <i
          className={`codicon codicon-${errors ? 'error' : 'warning'} wf-validity__icon`}
          aria-hidden="true"
        />
        {label}
        <i className="codicon codicon-chevron-down wf-validity__chevron" aria-hidden="true" />
      </button>
      <Popover
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        label="Problems"
        role="none"
        width={400}
      >
        <Menu label="Problems">
          {problems.map((d, i) => (
            <MenuItem
              key={`${d.code}-${i}`}
              wrap
              leading={
                <i
                  className={`codicon codicon-${d.severity === 'error' ? 'error' : 'warning'} wf-problem-icon wf-problem-icon--${d.severity}`}
                  aria-hidden="true"
                />
              }
              description={
                d.stepId ? <code>{d.stepId}</code> : d.range ? `Line ${d.range.start.line + 1}` : 'Workflow'
              }
              title={d.stepId ? 'Select the block' : 'Show in YAML'}
              onSelect={() => {
                setOpen(false);
                if (d.stepId) select(d.stepId);
                else openYaml();
              }}
            >
              {d.message}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </>
  );
}
