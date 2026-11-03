/** Report of "Check setup": endpoints and the models workflows use, each with what was found and a fix. */
import { useEffect, useRef } from 'react';
import type { SetupCheckItem, SetupCheckStatus, SetupReport, SidebarToHost } from '@isar-flow/core';
import { Button, IconButton, Spinner } from '../../components';
import { plural, send, uniqueKeys } from './model';
import './setup.css';

const STATUS: Record<SetupCheckStatus, { icon: string; label: string }> = {
  ok: { icon: 'pass-filled', label: 'OK' },
  warning: { icon: 'warning', label: 'Warning' },
  error: { icon: 'error', label: 'Error' },
  running: { icon: '', label: 'Checking' },
  skipped: { icon: 'circle-slash', label: 'Skipped' },
};

function statusOf(item: SetupCheckItem): SetupCheckStatus {
  return Object.hasOwn(STATUS, item.status) ? item.status : 'skipped';
}

function StatusIcon({ status }: { status: SetupCheckStatus }) {
  const info = STATUS[status];
  return (
    <span className={`sb-setup-status sb-setup-status--${status}`} role="img" aria-label={info.label}>
      {status === 'running' ? (
        <Spinner />
      ) : (
        <i className={`codicon codicon-${info.icon}`} aria-hidden="true" />
      )}
    </span>
  );
}

/** A fix is posted as it is; anything without a message type is not offered. */
function fixMessage(item: SetupCheckItem): SidebarToHost | undefined {
  const message: unknown = item.fix?.message;
  return typeof message === 'object' &&
    message !== null &&
    typeof (message as { type?: unknown }).type === 'string'
    ? (message as SidebarToHost)
    : undefined;
}

function ResultRow({ item }: { item: SetupCheckItem }) {
  const status = statusOf(item);
  const fix = fixMessage(item);
  const usedBy = Array.isArray(item.usedBy) ? item.usedBy.filter((u) => typeof u === 'string') : [];
  return (
    <li className="sb-setup-item">
      <StatusIcon status={status} />
      <div className="sb-setup-item__body">
        {item.kind === 'model' ? (
          <code className="sb-setup-item__label sb-setup-item__label--code">{item.label}</code>
        ) : (
          <span className="sb-setup-item__label">{item.label}</span>
        )}
        {item.message ? <span className="sb-setup-item__message">{item.message}</span> : null}
        {usedBy.length ? (
          <span className="sb-setup-item__used">
            Used by{' '}
            {usedBy.map((user, index) => (
              <span key={`${index}:${user}`}>
                {index > 0 ? ', ' : null}
                <code className="sb-setup-item__user">{user}</code>
              </span>
            ))}
          </span>
        ) : null}
        {fix && item.fix?.label ? (
          <div className="sb-setup-item__fix">
            <Button size="s" onClick={() => send(fix)}>
              {item.fix.label}
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function summary(report: SetupReport, items: SetupCheckItem[]): string {
  if (report.finishedAt === undefined) return 'Checking…';
  const problems = items.filter((item) => item.status === 'warning' || item.status === 'error').length;
  if (problems > 0) return plural(problems, 'problem');
  return items.length ? 'Everything works' : 'Nothing to check yet';
}

export function SetupCheckCard({ report }: { report: SetupReport }) {
  const ref = useRef<HTMLElement>(null);
  const items = Array.isArray(report.items)
    ? report.items.filter((i) => typeof i === 'object' && i !== null)
    : [];
  const running = report.finishedAt === undefined;
  const problems = items.some((item) => item.status === 'error')
    ? 'error'
    : items.some((item) => item.status === 'warning')
      ? 'warning'
      : 'ok';
  const keys = uniqueKeys(items, (item) => item.id);

  // A new check (from the Models section or the command) scrolls the card into view.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [report.startedAt]);

  return (
    <section ref={ref} className="sb-setup" aria-label="Setup check">
      <div className="sb-setup__head">
        <h3 className="sb-setup__title">Setup check</h3>
        <IconButton
          icon="close"
          label="Close setup check"
          onClick={() => send({ type: 'dismissSetupCheck' })}
        />
      </div>
      <div className="sb-setup__summary">
        <span
          className={`sb-setup__result sb-setup__result--${running ? 'running' : problems}`}
          role="status"
        >
          {running ? <Spinner /> : null}
          {summary(report, items)}
        </span>
        <Button
          size="s"
          variant="ghost"
          icon="refresh"
          aria-disabled={running}
          onClick={() => send({ type: 'checkSetup' })}
        >
          Run again
        </Button>
      </div>
      {items.length ? (
        <ul className="sb-setup__list" aria-label="Setup check results">
          {items.map((item, index) => (
            <ResultRow key={keys[index]} item={item} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
