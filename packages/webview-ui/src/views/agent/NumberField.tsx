import { useRef, useState } from 'react';
import { Field, TextInput } from '../../components';
import { useDraft } from '../../hooks';
import { parseNumberInput } from './agentForm';

function sameNumber(a: string, b: string): boolean {
  const left = parseNumberInput(a, false);
  const right = parseNumberInput(b, false);
  return left.ok && right.ok && left.value === right.value;
}

/** Optional number setting; an empty field removes the key so the default applies. */
export function NumberField({
  label,
  value,
  placeholder,
  hint,
  integer = false,
  error,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  hint: string;
  integer?: boolean;
  error?: string;
  onCommit: (value: number | undefined) => void;
}) {
  const [typo, setTypo] = useState(false);
  // The host echoes "0." back as "0"; keep what was typed while it means the same number.
  const typed = useRef(value);
  const external = sameNumber(typed.current, value) ? typed.current : value;
  const draft = useDraft(external, (next) => {
    const parsed = parseNumberInput(next, integer);
    setTypo(!parsed.ok);
    if (parsed.ok) onCommit(parsed.value);
  });

  return (
    <Field
      label={label}
      hint={hint}
      error={typo ? (integer ? 'Enter a whole number.' : 'Enter a number.') : error}
    >
      {({ id, describedBy, invalid }) => (
        <TextInput
          id={id}
          aria-describedby={describedBy}
          invalid={invalid}
          inputMode={integer ? 'numeric' : 'decimal'}
          placeholder={placeholder}
          value={draft.value}
          onChange={(event) => {
            typed.current = event.target.value;
            setTypo(false);
            draft.change(event.target.value);
          }}
          onBlur={draft.flush}
        />
      )}
    </Field>
  );
}
