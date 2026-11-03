import { MEMORY_FILE, MEMORY_PROMPT_MAX_BYTES, type MemoryFileState } from '@isar-flow/core';
import type * as vscode from 'vscode';

export const MEMORY_PREVIEW_MAX_CHARS = 600;

/** UTF-8 size of a text. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The first whole lines of the file, at most 600 characters; a longer first line is cut with "…". */
export function memoryPreview(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const added = (kept.length > 0 ? 1 : 0) + line.length;
    if (length + added > MEMORY_PREVIEW_MAX_CHARS) break;
    kept.push(line);
    length += added;
  }
  if (kept.length > 0 || lines[0] === undefined) return kept.join('\n');
  return `${lines[0].slice(0, MEMORY_PREVIEW_MAX_CHARS - 1)}…`;
}

/** What the sidebar and the agent editor show about one folder's memory file. */
export function memoryFileState(
  folder: { uri: vscode.Uri; name: string },
  fileUri: vscode.Uri,
  text: string | undefined,
): MemoryFileState {
  const bytes = text === undefined ? 0 : utf8Bytes(text);
  return {
    uri: fileUri.toString(),
    folderUri: folder.uri.toString(),
    folderName: folder.name,
    path: MEMORY_FILE,
    exists: text !== undefined,
    bytes,
    overLimit: bytes > MEMORY_PROMPT_MAX_BYTES,
    preview: text === undefined ? '' : memoryPreview(text),
  };
}
