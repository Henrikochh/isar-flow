/**
 * Agent setting `memory`: whether the agent reads `.isarflow/memory.md` of its workspace folder and may add notes
 * to it, plus that file's state (size, first lines) and a button to open or create it.
 */
import './memory.css';
import type { ReactNode } from 'react';
import {
  MEMORY_FILE,
  MEMORY_PROMPT_MAX_BYTES,
  REMEMBER_TOOL,
  type MemoryFileState,
  type MemoryMode,
} from '@isar-flow/core';
import { Button, SegmentedControl, Section, type SegmentOption } from '../../components';
import { formatBytes } from '../../hooks';
import type { UpdateAgent } from './agentForm';

const MODES: SegmentOption<MemoryMode>[] = [
  { value: 'none', label: 'Off' },
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Read and write' },
];

const LIMIT = `${Math.round(MEMORY_PROMPT_MAX_BYTES / 1024)} KB`;

/** Each hint stands on its own: the path and the tool name in the code font. */
const READS = (
  <>
    Adds <code>{MEMORY_FILE}</code> (first {LIMIT}) to the instructions
  </>
);

const HINTS: Record<MemoryMode, ReactNode> = {
  none: 'The agent never sees the memory file.',
  read: <>{READS}.</>,
  write: (
    <>
      {READS} and lets the agent save notes with the <code>{REMEMBER_TOOL.name}</code> tool.
    </>
  ),
};

/** Lines of the file shown under its name. */
const PREVIEW_LINES = 6;

function MemoryFile({ memory, onOpen }: { memory: MemoryFileState; onOpen: () => void }) {
  const preview = memory.exists
    ? memory.preview.replace(/\s+$/, '').split('\n').slice(0, PREVIEW_LINES).join('\n')
    : '';
  return (
    <div className="ag-memory__file">
      <div className="ag-memory__line">
        <i className="codicon codicon-book ag-memory__icon" aria-hidden="true" />
        <code className="ag-memory__path" title={`${memory.folderName}/${memory.path}`}>
          {memory.path}
        </code>
        <span className="ag-memory__size">
          {memory.exists ? formatBytes(memory.bytes) : 'Not created yet'}
        </span>
        <Button
          size="s"
          variant="secondary"
          icon={memory.exists ? 'go-to-file' : 'new-file'}
          onClick={onOpen}
        >
          {memory.exists ? 'Open memory file' : 'Create memory file'}
        </Button>
      </div>
      {memory.overLimit ? (
        <div className="ag-memory__warning">
          <i className="codicon codicon-warning ag-small-icon" aria-hidden="true" />
          <span>{`Agents read only the first ${LIMIT}.`}</span>
        </div>
      ) : null}
      {preview ? <div className="ag-memory__preview">{preview}</div> : null}
    </div>
  );
}

export function MemorySection({
  value,
  error,
  memory,
  userScope,
  update,
  onOpen,
}: {
  /** The `memory` key as written; undefined reads the memory (the default). */
  value: MemoryMode | undefined;
  error?: string;
  /** The memory file the agent reads; null without a workspace folder, undefined until the host sent it. */
  memory: MemoryFileState | null | undefined;
  userScope: boolean;
  update: UpdateAgent;
  onOpen: () => void;
}) {
  const current = value ?? 'read';
  const choose = (next: MemoryMode) => {
    if (next === current && value !== undefined) return;
    if (next === 'read') {
      if (value !== undefined) update({}, ['memory']);
    } else update({ memory: next });
  };
  return (
    <Section title="Memory">
      <div className="ag-memory">
        <div className="ag-memory__mode">
          <SegmentedControl label="Project memory" value={current} options={MODES} onChange={choose} />
          {error ? (
            <span className="ag-permission__error" role="alert">
              <i className="codicon codicon-error ag-small-icon" aria-hidden="true" />
              {error}
            </span>
          ) : (
            <span className="ag-permission__hint">{HINTS[current]}</span>
          )}
        </div>
        {userScope ? (
          <p className="ag-memory__note">Uses the memory of the workspace folder it runs in.</p>
        ) : null}
        {memory ? <MemoryFile memory={memory} onOpen={onOpen} /> : null}
        {memory === null && current !== 'none' ? (
          <p className="ag-memory__note">Open a folder to use project memory.</p>
        ) : null}
      </div>
    </Section>
  );
}
