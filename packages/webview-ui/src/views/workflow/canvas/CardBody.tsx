/** Second and following rows of a block card: the real prompt, command or message of each block type. */
import type { ReactNode } from 'react';
import { AgentStone, CapabilityChips, Chip } from '../../../components';
import type { CapabilitySource, Step } from '@isar-flow/core';
import { useCanvas } from './canvasContext';
import { type BlockEntry, textOf } from './model';
import { TemplateText } from './TemplateText';

type Raw = Record<string, unknown>;

const SHELL_LABELS: Record<string, string> = {
  pwsh: 'pwsh',
  powershell: 'Windows PowerShell',
  cmd: 'cmd',
  bash: 'bash',
  sh: 'sh',
};

function Chips({ children }: { children: ReactNode[] }) {
  const items = children.filter(Boolean);
  return items.length ? <div className="wf-card__chips">{items}</div> : null;
}

function Clamped({ text, placeholder }: { text: string; placeholder: string }) {
  return text.trim() ? (
    <TemplateText className="wf-card__text" text={text.trim()} />
  ) : (
    <span className="wf-card__placeholder">{placeholder}</span>
  );
}

function AgentBody({ step }: { step: Raw }) {
  const { agents } = useCanvas();
  const ref = step.agent;
  const override = textOf(step.model);
  let who: ReactNode;
  let model = override;
  // What the agent may do; unknown agents get no badges rather than a guess.
  let capabilities: CapabilitySource | undefined;
  if (typeof ref === 'string' && ref.trim()) {
    const agent = agents.get(ref);
    model ||= agent?.model ?? '';
    capabilities = agent;
    who = (
      <>
        <AgentStone id={ref} name={agent?.name ?? ref} size="s" />
        <span className="wf-card__agent">{agent?.name ?? ref}</span>
      </>
    );
  } else if (typeof ref === 'object' && ref !== null) {
    model ||= textOf((ref as Raw).model);
    capabilities = ref as CapabilitySource;
    who = <span className="wf-card__agent">Inline agent</span>;
  } else {
    who = <span className="wf-card__agent wf-card__agent--none">No agent</span>;
  }
  const output = step.output as Raw | undefined;
  return (
    <>
      <div className="wf-card__who">
        {who}
        {model ? <code className="wf-card__model">{model}</code> : null}
      </div>
      <Clamped text={textOf(step.prompt)} placeholder="No task yet" />
      <Chips>
        {[
          capabilities ? <CapabilityChips key="can" source={capabilities} /> : null,
          output?.format === 'json' ? (
            <Chip key="json" icon="json">
              JSON answer
            </Chip>
          ) : null,
          step.continueOnError === true ? <Chip key="coe">Continues on error</Chip> : null,
        ]}
      </Chips>
    </>
  );
}

function ConsoleBody({ step }: { step: Raw }) {
  const lines = textOf(step.run)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const shell = textOf(step.shell);
  return (
    <>
      <div className="wf-cmd" title={textOf(step.run)}>
        <span className="wf-cmd__prompt" aria-hidden="true">
          &gt;
        </span>
        {lines.length ? (
          <code className="wf-cmd__text">{lines[0]}</code>
        ) : (
          <span className="wf-card__placeholder">No command yet</span>
        )}
        {lines.length > 1 ? (
          <span className="wf-cmd__more">
            +{lines.length - 1} {lines.length === 2 ? 'line' : 'lines'}
          </span>
        ) : null}
      </div>
      <Chips>
        {[
          shell && shell !== 'auto' ? (
            <Chip key="shell" code>
              {SHELL_LABELS[shell] ?? shell}
            </Chip>
          ) : null,
          step.continueOnError === true ? <Chip key="coe">Continues on error</Chip> : null,
        ]}
      </Chips>
    </>
  );
}

function StopBody({ step }: { step: Raw }) {
  const success = step.outcome === 'success';
  const message = textOf(step.message).trim();
  return (
    <>
      <div className="wf-card__line">End run as {success ? 'succeeded' : 'failed'}</div>
      {message ? <TemplateText className="wf-card__text" text={message} /> : null}
    </>
  );
}

function ApprovalBody({ step }: { step: Raw }) {
  return (
    <>
      <div className="wf-card__line">Ask for approval</div>
      <Clamped text={textOf(step.message)} placeholder="No message yet" />
    </>
  );
}

export function CardBody({ entry }: { entry: BlockEntry }) {
  const step = entry.step as Step & Raw;
  switch (entry.type) {
    case 'agent':
      return <AgentBody step={step} />;
    case 'console':
      return <ConsoleBody step={step} />;
    case 'stop':
      return <StopBody step={step} />;
    case 'approval':
      return <ApprovalBody step={step} />;
    case undefined:
      return (
        <div className="wf-card__text">
          {typeof step.type === 'string' && step.type
            ? `“${step.type}” is not a block type. Fix it in the YAML.`
            : 'This block has no type. Add one in the YAML.'}
        </div>
      );
    default:
      return null;
  }
}
