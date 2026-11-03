import { type ReactNode, useId } from 'react';
import type { StepStatus, StepType } from '@isar-flow/core';
import { BLOCK_ICONS, initialsOf } from '../blockMeta';

export function Spinner({ label }: { label?: string }) {
  return <span className="if-spinner" role={label ? 'status' : undefined} aria-label={label} />;
}

/** `simulated`: a simulated run, in the enzian tone. */
export type ChipTone = 'neutral' | 'isar' | 'simulated' | 'success' | 'warning' | 'error' | 'outline';

export function Chip({
  children,
  tone = 'neutral',
  icon,
  code,
  title,
}: {
  children: ReactNode;
  tone?: ChipTone;
  icon?: string;
  code?: boolean;
  title?: string;
}) {
  const classes = ['if-chip', tone !== 'neutral' && `if-chip--${tone}`, code && 'if-chip--code']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} title={title}>
      {icon ? <i className={`codicon codicon-${icon}`} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Colored tile with the block type's icon. */
export function Stone({
  type,
  size = 'm',
  title,
}: {
  type: StepType;
  size?: 's' | 'm' | 'l';
  title?: string;
}) {
  return (
    <span
      className={`if-stone if-stone--${size}`}
      data-type={type}
      title={title}
      aria-hidden={title ? undefined : true}
    >
      <i className={`codicon codicon-${BLOCK_ICONS[type]}`} />
    </span>
  );
}

/** Avatar colors, named by the block type that carries them. Alpenrose is left out: a red avatar reads as an error. */
const AVATAR_COLORS: StepType[] = ['agent', 'loop', 'if', 'approval', 'console'];

function avatarColor(id: string): StepType {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** Agent avatar: initials on a tile colored deterministically from the agent id. */
export function AgentStone({ id, name, size = 'm' }: { id: string; name: string; size?: 's' | 'm' | 'l' }) {
  return (
    <span className={`if-stone if-stone--${size}`} data-type={avatarColor(id)} aria-hidden="true">
      <span className="if-stone__initials">{initialsOf(name || id)}</span>
    </span>
  );
}

/** `simulated`: a simulated run is shown. */
export type BannerTone = 'info' | 'warning' | 'error' | 'success' | 'simulated';

const BANNER_ICONS: Record<BannerTone, string> = {
  info: 'info',
  warning: 'warning',
  error: 'error',
  success: 'pass',
  simulated: 'beaker',
};

/** A banner with a title is named by it, so assistive tech can tell several banners apart. */
export function Banner({
  tone = 'info',
  title,
  children,
  actions,
  icon,
}: {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Codicon instead of the tone's own, e.g. `comment-discussion` for a question. */
  icon?: string;
}) {
  const titleId = useId();
  return (
    <div
      className={`if-banner if-banner--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-labelledby={title ? titleId : undefined}
    >
      <i className={`codicon codicon-${icon ?? BANNER_ICONS[tone]}`} aria-hidden="true" />
      <div className="if-banner__body">
        {title ? (
          <div id={titleId} className="if-banner__title">
            {title}
          </div>
        ) : null}
        {children ? <div>{children}</div> : null}
        {actions ? <div className="if-banner__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({
  art,
  title,
  children,
  actions,
}: {
  art?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="if-empty">
      {art ? <div className="if-empty__art">{art}</div> : null}
      <div className="if-empty__title">{title}</div>
      {children ? <div className="if-empty__body">{children}</div> : null}
      {actions ? <div className="if-empty__actions">{actions}</div> : null}
    </div>
  );
}

const STATUS_ICONS: Record<StepStatus, string> = {
  pending: 'circle-large-outline',
  running: 'loading',
  success: 'pass-filled',
  failure: 'error',
  skipped: 'circle-slash',
  // A circled stop keeps the status glyphs one round family and never reads as an empty checkbox.
  cancelled: 'stop-circle',
};

const STATUS_LABELS: Record<StepStatus, string> = {
  pending: 'Waiting',
  running: 'Running',
  success: 'Succeeded',
  failure: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

export function statusLabel(status: StepStatus): string {
  return STATUS_LABELS[status];
}

export function StatusGlyph({ status }: { status: StepStatus }) {
  return (
    <span
      className={`if-status if-status--${status}`}
      title={STATUS_LABELS[status]}
      role="img"
      aria-label={STATUS_LABELS[status]}
    >
      {status === 'running' ? (
        <Spinner />
      ) : (
        <i className={`codicon codicon-${STATUS_ICONS[status]}`} aria-hidden="true" />
      )}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="if-kbd">{children}</kbd>;
}

export function Section({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="if-section">
      <div className="if-section__header">
        <h3 className="if-section__title">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
