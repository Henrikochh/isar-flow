import { useMemo, useState } from 'react';
import {
  type Condition,
  CONDITION_OPS,
  type ConditionOp,
  describeCondition,
  type Diagnostic,
  type StepType,
} from '@isar-flow/core';
import { Banner, Button, SegmentedControl, Select, type SelectOption } from '../../../components';
import { useConditionResultText } from '../live/conditionResult';
import { useWorkflowActions } from '../store';
import {
  type Combinator,
  expressionCondition,
  expressionProblem,
  expressionText,
  isNestedCondition,
  readRules,
  type Rule,
  type RuleSet,
  rulesToExpression,
  toTemplate,
  writeRules,
} from './conditionModel';
import { TextField } from './fields';
import { FieldIssues } from './Issues';
import { RuleRow } from './RuleRow';
import { GROUP_ICONS, GROUP_LABELS, TYPE_LABELS, useVariables, variableLabel } from './variables';
import './condition.css';

export interface ConditionBuilderProps {
  /** Block the condition belongs to: decides the variables on offer and what Show in YAML reveals. */
  stepId: string;
  condition: unknown;
  onChange: (condition: Condition) => void;
  /** Lead-in for the live summary, e.g. "Repeat until" or "If". */
  summaryPrefix: string;
  /** Block type whose color tints the rule rail. */
  accent: StepType;
  issues?: readonly Diagnostic[];
}

type Mode = 'rules' | 'expression';

const COMBINATORS: SelectOption<Combinator>[] = [
  { value: 'all', label: 'All rules match' },
  { value: 'any', label: 'Any rule matches' },
];

function initialMode(condition: unknown): Mode {
  if (typeof condition !== 'string') return 'rules';
  const rules = readRules(condition);
  return rules && rules.rules.length === 0 ? 'rules' : 'expression';
}

function summarize(condition: unknown): string {
  if (condition === undefined || condition === null || condition === '') return '';
  try {
    return describeCondition(condition as Condition);
  } catch {
    return '';
  }
}

/** Rules / Expression editor for loop and if conditions. */
export function ConditionBuilder({
  stepId,
  condition,
  onChange,
  summaryPrefix,
  accent,
  issues,
}: ConditionBuilderProps) {
  const actions = useWorkflowActions();
  const lastResult = useConditionResultText(stepId);
  const [mode, setMode] = useState<Mode>(() => initialMode(condition));
  const [startOver, setStartOver] = useState(false);
  const nested = isNestedCondition(condition);
  const ruleSet: RuleSet | null = startOver ? { combinator: 'all', rules: [] } : readRules(condition);
  // In Rules mode an expression is shown converted, so describe the rules the user sees.
  const summary =
    mode === 'rules' && typeof condition === 'string' && ruleSet && ruleSet.rules.length > 0
      ? summarize(writeRules(ruleSet))
      : summarize(condition);

  const expressionValue =
    typeof condition === 'string'
      ? expressionText(condition)
      : ruleSet
        ? (rulesToExpression(ruleSet) ?? '')
        : '';

  return (
    <div className="wf-cond" data-type={accent}>
      <div className="wf-cond-head">
        <span className="wf-cond-label">Condition</span>
        <SegmentedControl<Mode>
          label="Condition mode"
          value={mode}
          onChange={(next) => {
            setMode(next);
            if (next === 'expression') setStartOver(false);
          }}
          options={[
            { value: 'rules', label: 'Rules' },
            { value: 'expression', label: 'Expression' },
          ]}
        />
      </div>

      {mode === 'expression' ? (
        <TextField
          key="expression"
          label="Expression"
          code
          multiline
          minRows={2}
          maxRows={8}
          value={expressionValue}
          variablesFor={stepId}
          bareVariables
          validate={(text) => expressionProblem(text) ?? undefined}
          hint={
            <>
              Written as <code>{'${{ … }}'}</code> in the YAML.
            </>
          }
          onCommit={(text) => {
            if (text.trim() === '') return;
            onChange(expressionCondition(text));
            setStartOver(false);
          }}
        />
      ) : nested ? (
        <Banner
          tone="warning"
          title="This condition has nested groups. Edit it in YAML."
          actions={
            <Button size="s" variant="secondary" icon="go-to-file" onClick={() => actions.openYaml(stepId)}>
              Open YAML
            </Button>
          }
        />
      ) : ruleSet ? (
        <RuleList
          stepId={stepId}
          ruleSet={ruleSet}
          onChange={(set) => {
            onChange(writeRules(set));
            setStartOver(false);
          }}
        />
      ) : (
        <Banner
          tone="info"
          title="This expression can't be shown as rules."
          actions={
            <>
              <Button size="s" variant="secondary" onClick={() => setMode('expression')}>
                Edit the expression
              </Button>
              <Button size="s" variant="ghost" onClick={() => setStartOver(true)}>
                Start over with rules
              </Button>
            </>
          }
        >
          Rules can show comparisons joined by all-and or all-or.
        </Banner>
      )}

      {summary ? (
        <p className="wf-cond-summary" aria-live="polite">
          <span className="wf-cond-summary-lead">{summaryPrefix}</span> {summary}
          {lastResult ? <span className="wf-cond-live">{lastResult}</span> : null}
        </p>
      ) : null}
      <FieldIssues issues={issues} />
    </div>
  );
}

interface PendingRule {
  value?: unknown;
  op: ConditionOp;
  to?: unknown;
  ignoreCase?: boolean;
}

const OPERATORS: SelectOption<ConditionOp>[] = CONDITION_OPS.map((info) => ({
  value: info.op,
  label: info.label,
}));

function RuleList({
  stepId,
  ruleSet,
  onChange,
}: {
  stepId: string;
  ruleSet: RuleSet;
  onChange: (set: RuleSet) => void;
}) {
  const { variables } = useVariables(stepId);
  const [pending, setPending] = useState<PendingRule | null>(null);
  const [preferred, setPreferred] = useState<Combinator>(ruleSet.combinator);
  const combinator = ruleSet.rules.length > 1 ? ruleSet.combinator : preferred;
  const showPending = pending ?? (ruleSet.rules.length === 0 ? { op: 'eq' as ConditionOp } : null);

  const valueOptions = useMemo<SelectOption[]>(
    () =>
      variables.map((v) => ({
        value: toTemplate(v.expression),
        label: variableLabel(v),
        description: v.description,
        group: GROUP_LABELS[v.group],
        meta: TYPE_LABELS[v.type],
        leading: GROUP_ICONS[v.group] ? (
          <i
            className={`codicon codicon-${GROUP_ICONS[v.group]} wf-insp-var-group-icon`}
            aria-hidden="true"
          />
        ) : undefined,
      })),
    [variables],
  );
  const typeOf = (value: unknown) => variables.find((v) => toTemplate(v.expression) === value)?.type;

  const commit = (rules: Rule[], nextCombinator = combinator) =>
    onChange({ combinator: nextCombinator, rules });

  const total = ruleSet.rules.length + (showPending ? 1 : 0);
  const joiner = combinator === 'all' ? 'and' : 'or';

  return (
    <div className="wf-cond-rules-wrap">
      {total > 1 ? (
        <Select<Combinator>
          ariaLabel="How rules combine"
          value={combinator}
          options={COMBINATORS}
          onChange={(next) => {
            setPreferred(next);
            if (ruleSet.rules.length > 1) commit(ruleSet.rules, next);
          }}
        />
      ) : null}
      <ol className="wf-cond-rules" aria-label="Rules">
        {ruleSet.rules.map((rule, index) => (
          <RuleRow
            key={index}
            index={index}
            joiner={index > 0 ? joiner : undefined}
            rule={rule}
            valueOptions={valueOptions}
            operators={OPERATORS}
            valueType={typeOf(rule.value)}
            canRemove={ruleSet.rules.length > 1}
            onChange={(patch) => commit(ruleSet.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)))}
            onRemove={() => commit(ruleSet.rules.filter((_, i) => i !== index))}
          />
        ))}
        {showPending ? (
          <RuleRow
            key="pending"
            index={ruleSet.rules.length}
            pending
            joiner={ruleSet.rules.length > 0 ? joiner : undefined}
            rule={showPending}
            valueOptions={valueOptions}
            operators={OPERATORS}
            valueType={typeOf(showPending.value)}
            canRemove={ruleSet.rules.length > 0}
            onChange={(patch) => {
              const next = { ...showPending, ...patch };
              if (patch.value === undefined) {
                setPending(next);
                return;
              }
              // Booleans read best as "is true"; switch the untouched default operator for them.
              const type = typeOf(patch.value);
              if (type === 'boolean' && next.op === 'eq' && (next.to === undefined || next.to === ''))
                next.op = 'isTrue';
              setPending(null);
              commit([...ruleSet.rules, { ...next, value: patch.value }]);
            }}
            onRemove={() => setPending(null)}
          />
        ) : null}
      </ol>
      {showPending ? null : (
        <div>
          <Button size="s" variant="ghost" icon="add" onClick={() => setPending({ op: 'eq' })}>
            Add rule
          </Button>
        </div>
      )}
    </div>
  );
}
