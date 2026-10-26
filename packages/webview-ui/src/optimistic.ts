/**
 * Edits the webview shows at once, before the host has written them. The webview edits with the same core
 * functions as the host, so it knows the text each edit produces; a host document with one of those texts
 * confirms that edit and the ones before it. Without this, an edit made before the host answered the previous
 * one is computed from the old document and silently undoes it (e.g. two quick checkbox clicks).
 */

/**
 * Expected texts still waiting for the host after it sent `hostText`. A host that re-sends the text it already
 * had (it re-validates after agents or models change) confirms nothing; any other text means the document
 * changed elsewhere, and the host document wins.
 */
export function reconcilePending(
  pending: readonly string[],
  previousHostText: string | undefined,
  hostText: string,
): string[] {
  const confirmed = pending.indexOf(hostText);
  if (confirmed >= 0) return pending.slice(confirmed + 1);
  if (hostText === previousHostText) return [...pending];
  return [];
}
