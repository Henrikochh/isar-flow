import type { ConditionOp, OutputType } from '@isar-flow/core';
import { IconButton, Select, type SelectOption } from '../../../components';
import {
  formatOperand,
  needsOperand,
  parseOperand,
  type Rule,
  singleTemplate,
  TEXT_OPS,
  valueFromText,
  valueKey,
} from './conditionModel';
import { DraftInput } from './fields';

export interface RuleRowProps {
  index: number;
  rule: { value?: unknown; op: ConditionOp; to?: unknown; ignoreCase?: boolean };
  /** A rule the user is adding; it is written to the YAML once a value is chosen. */
  pending?: boolean;
  /** "and" / "or" shown on the rail above this rule. */
  joiner?: string;
  valueOptions: SelectOption[];
  operators: SelectOption<ConditionOp>[];
  valueType?: OutputType;
  canRemove: boolean;
  onChange: (patch: Partial<Rule>) => void;
  onRemove: () => void;
}

const OPERAND_PLACEHOLDER: Partial<Record<OutputType, string>> = {
  number: '0',
  boolean: 'true',
};

function CustomValue({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    const inner = singleTemplate(value);
    if (inner !== null) return <code className="wf-cond-custom">{inner}</code>;
  }
  return <span className="wf-cond-custom">"{formatOperand(value)}"</span>;
}

/** One rule: `[value] [operator] [operand]`, laid out on two lines to fit the 360 px inspector. */
export function RuleRow({
  index,
  rule,
  pending,
  joiner,
  valueOptions,
  operators,
  valueType,
  canRemove,
  onChange,
  onRemove,
}: RuleRowProps) {
  const n = index + 1;
  const hasValue = rule.value !== undefined;
  const operand = needsOperand(rule.op);
  const typed = typeof rule.to === 'number' || typeof rule.to === 'boolean' || valueType === 'number' || valueType === 'boolean';
  const caseToggle = TEXT_OPS.has(rule.op) && !(typed && (rule.op === 'eq' || rule.op === 'neq'));
  return (
    <li className={joiner ? 'wf-cond-item wf-cond-item--joined' : 'wf-cond-item'}>
      {joiner ? (
        <span className="wf-cond-joiner" aria-hidden="true">
          {joiner}
        </span>
      ) : null}
      <div className={pending ? 'wf-cond-rule wf-cond-rule--pending' : 'wf-cond-rule'}>
        <div className="wf-cond-line">
          <div className="wf-cond-value">
            <Select
              ariaLabel={`Rule ${n} value`}
              value={hasValue ? valueKey(rule.value) : undefined}
              options={valueOptions}
              searchable
              allowCustom
              customLabel={(text) => `Use "${text}"`}
              emptyText="No variables match. Type a value or an expression."
              placeholder="Choose a value"
              renderValue={(option) =>
                option ? option.label : hasValue ? <CustomValue value={rule.value} /> : 'Choose a value'
              }
              onChange={(text) => onChange({ value: valueFromText(text) })}
            />
          </div>
          {canRemove ? (
            <IconButton icon="close" label={pending ? 'Discard new rule' : `Remove rule ${n}`} onClick={onRemove} />
          ) : null}
        </div>
        <div className="wf-cond-line">
          <div className={operand ? 'wf-cond-op' : 'wf-cond-op wf-cond-op--wide'}>
            <Select<ConditionOp>
              ariaLabel={`Rule ${n} operator`}
              value={rule.op}
              options={operators}
              onChange={(op) => onChange(needsOperand(op) ? { op } : { op, to: undefined })}
            />
          </div>
          {operand ? (
            <DraftInput
              className="wf-cond-operand"
              code
              aria-label={`Rule ${n} compare with`}
              placeholder={(valueType && OPERAND_PLACEHOLDER[valueType]) ?? 'text'}
              value={formatOperand(rule.to)}
              onCommit={(text) => onChange({ to: parseOperand(text) })}
            />
          ) : null}
          {caseToggle ? (
            <IconButton
              icon="case-sensitive"
              label="Ignore case"
              active={Boolean(rule.ignoreCase)}
              onClick={() => onChange({ ignoreCase: !rule.ignoreCase })}
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}
