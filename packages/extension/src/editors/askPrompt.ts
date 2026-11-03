import type { AskPrompt } from '@isar-flow/core';

/** The fields of an ask that a webview gets; broker events also carry host fields (workflow URI and name). */
export function askPromptOf(event: AskPrompt): AskPrompt {
  const { requestId, runId, stepId, question } = event;
  const prompt: AskPrompt = { requestId, runId, stepId, question };
  if (event.choices !== undefined) prompt.choices = [...event.choices];
  if (event.default !== undefined) prompt.default = event.default;
  if (event.expiresAt !== undefined) prompt.expiresAt = event.expiresAt;
  return prompt;
}
