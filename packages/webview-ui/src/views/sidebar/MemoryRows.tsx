/** Quiet rows for `.isarflow/memory.md` of each workspace folder: its size and a button to open or create it. */
import type { MemoryFileState } from '@isar-flow/core';
import { Button } from '../../components';
import { formatBytes } from '../../hooks';
import { send, uniqueKeys } from './model';
import './memory.css';

/** The entries a lenient host sent that name a folder; anything else is left out. */
export function memoryFiles(memory: unknown): MemoryFileState[] {
  if (!Array.isArray(memory)) return [];
  return memory.filter(
    (entry): entry is MemoryFileState =>
      typeof entry === 'object' && entry !== null && typeof entry.folderUri === 'string',
  );
}

function MemoryRow({ memory, multiRoot }: { memory: MemoryFileState; multiRoot: boolean }) {
  const folder = typeof memory.folderName === 'string' ? memory.folderName : '';
  const path = typeof memory.path === 'string' && memory.path ? memory.path : '.isarflow/memory.md';
  const exists = memory.exists === true;
  const bytes = typeof memory.bytes === 'number' ? memory.bytes : 0;
  const of = multiRoot && folder ? ` of ${folder}` : '';
  return (
    <div className="sb-memory">
      <span className="sb-memory__icon" aria-hidden="true">
        <i className="codicon codicon-book" />
      </span>
      <span className="sb-memory__body">
        <span className="sb-memory__title">Project memory</span>
        <span className="sb-memory__meta" title={folder ? `${folder}/${path}` : path}>
          {multiRoot && folder ? <span className="sb-memory__folder">{folder}</span> : null}
          <span>{exists ? formatBytes(bytes) : 'Not created yet'}</span>
        </span>
      </span>
      <Button
        size="s"
        variant="ghost"
        className="sb-memory__open"
        aria-label={`${exists ? 'Open' : 'Create'} project memory${of}`}
        onClick={() => send({ type: 'openMemory', folderUri: memory.folderUri })}
      >
        {exists ? 'Open' : 'Create'}
      </Button>
    </div>
  );
}

export function MemoryRows({ memory }: { memory: MemoryFileState[] }) {
  if (memory.length === 0) return null;
  const keys = uniqueKeys(memory, (entry) => entry.folderUri);
  return (
    <ul className="sb-list sb-memory-list" aria-label="Project memory">
      {memory.map((entry, index) => (
        <li key={keys[index]}>
          <MemoryRow memory={entry} multiRoot={memory.length > 1} />
        </li>
      ))}
    </ul>
  );
}
