/** "Tool calls": how the agent calls its tools (agent setting toolMode; Automatic leaves the key out). */
import type { ToolMode } from '@isar-flow/core';
import { Field, Select, type SelectOption } from '../../components';
import type { UpdateAgent } from './agentForm';

const OPTIONS: SelectOption<ToolMode>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'native', label: 'Native' },
  { value: 'text', label: 'Text in the prompt' },
];

const HINTS: Record<ToolMode, string> = {
  auto: 'Native tool calls when the model has them; otherwise the tools are described in the prompt.',
  native: "Always uses the model's own tool calling.",
  text: 'Describes the tools in the prompt and reads the calls from the answer. For models without tool calling.',
};

export function ToolModeField({
  value,
  error,
  update,
}: {
  /** As written in the file; undefined = automatic. */
  value: string | undefined;
  error?: string;
  update: UpdateAgent;
}) {
  const known = OPTIONS.find((option) => option.value === (value ?? 'auto'))?.value;
  return (
    <Field label="Tool calls" hint={known ? HINTS[known] : undefined} error={error}>
      {({ id, describedBy, invalid }) => (
        <Select<ToolMode>
          id={id}
          describedBy={describedBy}
          invalid={invalid}
          // An unknown value is shown as written until another one is chosen.
          value={(known ?? value) as ToolMode}
          options={OPTIONS}
          onChange={(next) => {
            if (next === 'auto') {
              if (value !== undefined) update({}, ['toolMode']);
            } else if (next !== value) {
              update({ toolMode: next });
            }
          }}
        />
      )}
    </Field>
  );
}
