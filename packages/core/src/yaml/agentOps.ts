import { EditError, loadForEdit, stringifyDocument } from './document';
import { AGENT_KEY_ORDER, deleteMapKey, setMapValue } from './nodes';
import type { ApplyOpsResult } from './types';

/**
 * Sets and removes top-level keys of an agent file, preserving comments and formatting of everything else.
 * New keys go to their canonical position; an empty file becomes a fresh mapping.
 */
export function applyAgentUpdate(
  text: string,
  set: Record<string, unknown>,
  unset: readonly string[] = [],
): ApplyOpsResult {
  try {
    const edit = loadForEdit(text, 'agent');
    const { doc, root } = edit;
    for (const [key, value] of Object.entries(set)) {
      if (value === undefined) deleteMapKey(root, key);
      else setMapValue(doc, root, key, value, 'agent', AGENT_KEY_ORDER);
    }
    for (const key of unset) deleteMapKey(root, key);
    return { text: stringifyDocument(edit, text) };
  } catch (err) {
    if (err instanceof EditError) return { text, error: err.message };
    return { text, error: `Could not update the agent: ${err instanceof Error ? err.message : String(err)}` };
  }
}
