import * as vscode from 'vscode';

/**
 * Typed message channel to one webview. Messages posted before the webview reported `ready` are dropped
 * by VS Code, so callers send full state in response to `ready` and incremental updates afterwards.
 */
export class Messenger<In extends { type: string }, Out extends { type: string }>
  implements vscode.Disposable
{
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;

  constructor(
    private readonly webview: vscode.Webview,
    handler: (message: In) => void | Promise<void>,
    private readonly log?: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      webview.onDidReceiveMessage(async (message: In) => {
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'ready') this.ready = true;
        try {
          await handler(message);
        } catch (error) {
          this.log?.error(
            `Webview message '${message.type}' failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          );
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }),
    );
  }

  /** True once the webview has posted `ready`. */
  get isReady(): boolean {
    return this.ready;
  }

  post(message: Out): void {
    if (!this.ready) return;
    void this.webview.postMessage(message);
  }

  dispose(): void {
    this.ready = false;
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
