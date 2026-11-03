import * as vscode from 'vscode';
import { templateAt } from '@isar-flow/core';
import type { Services } from '../contracts';
import { isTrackedScheme } from '../editors/files';
import { createLiveContextSource } from './contextSource';
import { liveValueHover } from './hover';

/**
 * Shows what a `${{ … }}` template evaluated to in the running or the newest run when the pointer rests on it
 * in a workflow's YAML. Reads saved runs only, so it works in Restricted Mode too.
 */
export function registerLiveValueHover(
  services: Pick<Services, 'runs'>,
  now: () => number = Date.now,
): vscode.Disposable {
  const contextOf = createLiveContextSource(services.runs);
  const provider: vscode.HoverProvider = {
    async provideHover(document, position, token) {
      if (!isTrackedScheme(document.uri.scheme)) return undefined;
      const text = document.getText();
      const offset = document.offsetAt(position);
      if (!templateAt(text, offset)) return undefined;
      const { version } = document;
      const context = await contextOf(document.uri.toString());
      // Offsets are only valid for the text they were computed on.
      if (!context || token.isCancellationRequested || document.version !== version) return undefined;
      const hover = liveValueHover(text, offset, context, now());
      if (!hover) return undefined;
      const markdown = new vscode.MarkdownString(hover.markdown);
      markdown.isTrusted = false;
      markdown.supportHtml = false;
      const range = new vscode.Range(document.positionAt(hover.start), document.positionAt(hover.end));
      return new vscode.Hover(markdown, range);
    },
  };
  return vscode.languages.registerHoverProvider({ pattern: '**/*.workflow.{yaml,yml}' }, provider);
}
