import { minimalTextEdit, offsetToPosition, type Position } from '@isar-flow/core';

export interface ReplaceRange {
  /** Positions in the old text. */
  start: Position;
  end: Position;
  text: string;
}

/** The single smallest replacement (as line/character range of `oldText`) that turns `oldText` into `newText`. */
export function computeReplaceRange(oldText: string, newText: string): ReplaceRange {
  const edit = minimalTextEdit(oldText, newText);
  return {
    start: offsetToPosition(oldText, edit.start),
    end: offsetToPosition(oldText, edit.end),
    text: edit.text,
  };
}
