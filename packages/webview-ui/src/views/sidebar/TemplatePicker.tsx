import { Fragment, type KeyboardEvent, useRef } from 'react';
import type { WorkflowTemplateId } from '@isar-flow/core';
import { BLOCK_ICONS } from '../../blockMeta';
import { templateOutline, type OutlineNode } from './model';

interface TemplateOption {
  id: WorkflowTemplateId;
  title: string;
  description: string;
}

export const TEMPLATE_OPTIONS: TemplateOption[] = [
  { id: 'blank', title: 'Blank', description: 'Start empty' },
  { id: 'review-loop', title: 'Review loop', description: 'Implement, test and review until approved' },
  { id: 'test-fix', title: 'Test and fix', description: 'Run tests and fix failures until they pass' },
];

/** Template choice cards (radiogroup); each card previews the template's blocks as small stones. */
export function TemplatePicker({
  value,
  onChange,
  labelledBy,
}: {
  value: WorkflowTemplateId;
  onChange: (value: WorkflowTemplateId) => void;
  labelledBy: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + TEMPLATE_OPTIONS.length) % TEMPLATE_OPTIONS.length;
    onChange(TEMPLATE_OPTIONS[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div className="sb-templates" role="radiogroup" aria-labelledby={labelledBy}>
      {TEMPLATE_OPTIONS.map((option, index) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={selected ? 'sb-template sb-template--selected' : 'sb-template'}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span className={selected ? 'sb-radio sb-radio--on' : 'sb-radio'} aria-hidden="true" />
            <span className="sb-template__text">
              <span className="sb-template__title">{option.title}</span>
              <span className="sb-template__desc">{option.description}</span>
              <TemplateStones outline={templateOutline(option.id)} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The template as a miniature river: stones joined by short stretches of stream, containers as pools. */
function TemplateStones({ outline }: { outline: OutlineNode[] }) {
  return (
    <span className="sb-stones" aria-hidden="true">
      {outline.length === 0 ? <span className="sb-stone-slot" /> : <OutlineFlow nodes={outline} />}
    </span>
  );
}

function OutlineFlow({ nodes }: { nodes: OutlineNode[] }) {
  return nodes.map((node, index) => (
    <Fragment key={index}>
      {index > 0 ? <span className="sb-stream" /> : null}
      <OutlineStone node={node} />
    </Fragment>
  ));
}

function OutlineStone({ node }: { node: OutlineNode }) {
  const stone = (
    <span className="sb-mini" data-type={node.type}>
      <i className={`codicon codicon-${BLOCK_ICONS[node.type] ?? 'circle-large-outline'}`} />
    </span>
  );
  if (node.children.length === 0) return stone;
  return (
    <span className="sb-mini-group" data-type={node.type}>
      {stone}
      <span className="sb-stream" />
      <OutlineFlow nodes={node.children} />
    </span>
  );
}
