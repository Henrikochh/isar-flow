import * as vscode from 'vscode';
import type { RunTerminal } from '../contracts';
import { startsOnNewLine, toTerminalText } from './terminalFormat';

export { formatCommandHeader, formatExitFooter } from './terminalFormat';

/** Output written before VS Code opened the terminal is kept up to this many characters (the tail). */
const MAX_PENDING_CHARS = 1024 * 1024;

interface Session {
  terminal: vscode.Terminal;
  emitter: vscode.EventEmitter<string>;
  opened: boolean;
  pending: string;
}

/**
 * A read-only terminal tab that mirrors run output. It is created on first use, buffers output until
 * VS Code opens it, and comes back on the next write when the user closed it.
 */
export function createRunTerminal(name: string): RunTerminal {
  return new MirrorTerminal(name);
}

class MirrorTerminal implements RunTerminal {
  private session: Session | undefined;
  private atLineStart = true;
  private disposed = false;

  constructor(private readonly name: string) {}

  write(text: string): void {
    if (this.disposed || text === '') return;
    const session = this.ensureSession();
    let out = toTerminalText(text);
    if (!this.atLineStart && startsOnNewLine(text)) out = `\r\n${out}`;
    this.atLineStart = text.endsWith('\n');
    if (session.opened) {
      session.emitter.fire(out);
    } else {
      session.pending = (session.pending + out).slice(-MAX_PENDING_CHARS);
    }
  }

  show(preserveFocus?: boolean): void {
    if (this.disposed) return;
    this.ensureSession().terminal.show(preserveFocus);
  }

  dispose(): void {
    this.disposed = true;
    const session = this.session;
    this.session = undefined;
    session?.terminal.dispose();
    session?.emitter.dispose();
  }

  private ensureSession(): Session {
    if (this.session) return this.session;
    const emitter = new vscode.EventEmitter<string>();
    const pty: vscode.Pseudoterminal = {
      onDidWrite: emitter.event,
      open: () => {
        session.opened = true;
        if (session.pending !== '') emitter.fire(session.pending);
        session.pending = '';
      },
      // Called when the user closes the tab (or we dispose it); the next write opens a new one.
      close: () => {
        if (this.session === session) this.session = undefined;
        emitter.dispose();
      },
    };
    const session: Session = {
      emitter,
      opened: false,
      pending: '',
      terminal: vscode.window.createTerminal({ name: this.name, pty, isTransient: true }),
    };
    this.session = session;
    this.atLineStart = true;
    return session;
  }
}
