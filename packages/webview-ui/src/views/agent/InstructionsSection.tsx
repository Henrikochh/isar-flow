import { Field, Section, TextArea } from '../../components';
import { useDraft } from '../../hooks';
import type { UpdateAgent } from './agentForm';

function lineCount(text: string): string {
  if (!text) return '';
  const lines = text.replace(/\n$/, '').split('\n').length;
  return lines === 1 ? '1 line' : `${lines} lines`;
}

export function InstructionsSection({
  value,
  error,
  update,
}: {
  value: string;
  error?: string;
  update: UpdateAgent;
}) {
  const draft = useDraft(value, (next) =>
    next.trim() ? update({ systemPrompt: next }) : update({}, ['systemPrompt']),
  );
  return (
    <Section title="Instructions">
      <Field
        label="System prompt"
        labelExtra={lineCount(draft.value)}
        hint="Sent before every task. Describe the role, the rules and the answer format."
        error={error}
      >
        {({ id, describedBy, invalid }) => (
          <TextArea
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            code
            autoGrow
            minRows={8}
            maxRows={30}
            className="ag-instructions"
            placeholder="You are a careful senior engineer working in this repository…"
            value={draft.value}
            onChange={(event) => draft.change(event.target.value)}
            onBlur={draft.flush}
          />
        )}
      </Field>
    </Section>
  );
}
