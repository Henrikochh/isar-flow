const MAX_QUERY_LENGTH = 200;

/**
 * A query for `workbench.action.openSettings` from a webview: only Isar Flow settings, trimmed and short.
 * Undefined for anything else.
 */
export function isarFlowSettingsQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const query = value.trim();
  return query.startsWith('isarFlow.') && query.length <= MAX_QUERY_LENGTH ? query : undefined;
}
