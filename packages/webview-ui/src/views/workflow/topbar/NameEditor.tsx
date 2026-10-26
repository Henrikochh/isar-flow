import { useRef, useState } from 'react';
import { TextInput } from '../../../components';

/** Workflow name in display type; click to rename inline (Enter or blur saves, Escape cancels). */
export function NameEditor({
  name,
  editable,
  onRename,
}: {
  name: string;
  editable: boolean;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  /** Guards against the blur that follows Enter/Escape committing a second time. */
  const done = useRef(false);

  if (draft === null) {
    return (
      <button
        type="button"
        className="wf-name"
        title={editable ? `${name} (click to rename)` : name}
        disabled={!editable}
        onClick={() => {
          done.current = false;
          setDraft(name);
        }}
      >
        <span className="wf-name__text">{name}</span>
        {editable ? <i className="codicon codicon-edit wf-name__icon" aria-hidden="true" /> : null}
      </button>
    );
  }

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = draft.trim();
    setDraft(null);
    if (save && value && value !== name) onRename(value);
  };

  return (
    <TextInput
      className="wf-name-input"
      aria-label="Workflow name"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
    />
  );
}
