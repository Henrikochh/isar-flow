import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createRunTerminal, formatCommandHeader, formatExitFooter } from '../../../src/runner/runTerminal';
import { formatDuration, toTerminalText } from '../../../src/runner/terminalFormat';

interface FakeTerminal {
  options: vscode.ExtensionTerminalOptions;
  written: string[];
  show: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

let terminals: FakeTerminal[] = [];

beforeEach(() => {
  terminals = [];
  vi.spyOn(vscode.window, 'createTerminal').mockImplementation(((
    options: vscode.ExtensionTerminalOptions,
  ) => {
    const fake: FakeTerminal = { options, written: [], show: vi.fn(), dispose: vi.fn() };
    options.pty.onDidWrite((text) => fake.written.push(text));
    terminals.push(fake);
    return fake as unknown as vscode.Terminal;
  }) as typeof vscode.window.createTerminal);
});

afterEach(() => vi.restoreAllMocks());

describe('createRunTerminal', () => {
  it('buffers output until the terminal is opened and converts newlines', () => {
    const terminal = createRunTerminal('Isar Flow: Build');
    terminal.write('one\ntwo\r\n');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].options.name).toBe('Isar Flow: Build');
    expect(terminals[0].written).toEqual([]);

    terminals[0].options.pty.open(undefined);
    expect(terminals[0].written).toEqual(['one\r\ntwo\r\n']);

    terminal.write('three\n');
    expect(terminals[0].written).toEqual(['one\r\ntwo\r\n', 'three\r\n']);
  });

  it('shows the terminal', () => {
    const terminal = createRunTerminal('Isar Flow: Build');
    terminal.show(true);
    expect(terminals[0].show).toHaveBeenCalledWith(true);
  });

  it('creates a new terminal after the user closed it', () => {
    const terminal = createRunTerminal('Isar Flow: Build');
    terminal.write('first\n');
    terminals[0].options.pty.open(undefined);
    terminals[0].options.pty.close();

    terminal.write('second\n');
    expect(terminals).toHaveLength(2);
    terminals[1].options.pty.open(undefined);
    expect(terminals[1].written).toEqual(['second\r\n']);
  });

  it('starts headers and footers on a new line', () => {
    const terminal = createRunTerminal('Isar Flow: Build');
    terminals.length = 0;
    terminal.write(formatCommandHeader('build', 'npm test'));
    terminals[0].options.pty.open(undefined);
    terminal.write('no newline at the end');
    terminal.write(formatExitFooter(0, 1200));
    const text = terminals[0].written.join('');
    expect(text).toContain('no newline at the end\r\n');
    expect(text.startsWith('\r\n')).toBe(false);
  });

  it('stops writing after dispose', () => {
    const terminal = createRunTerminal('Isar Flow: Build');
    terminal.write('x');
    terminal.dispose();
    expect(terminals[0].dispose).toHaveBeenCalled();
    terminal.write('y');
    terminal.show();
    expect(terminals).toHaveLength(1);
  });
});

describe('terminal formatting', () => {
  it('formats the command header dimmed with continuation lines aligned', () => {
    expect(formatCommandHeader('build', 'npm ci\nnpm test\n')).toBe(
      '\x1b[2m[build] $ npm ci\n          npm test\x1b[0m\n',
    );
  });

  it('formats a successful exit in green and a failure in red', () => {
    expect(formatExitFooter(0, 1234)).toBe('\x1b[32m✓ Exit code 0\x1b[0m\x1b[2m · 1.2 s\x1b[0m\n\n');
    expect(formatExitFooter(2, 80)).toBe('\x1b[31m✗ Exit code 2\x1b[0m\x1b[2m · 80 ms\x1b[0m\n\n');
  });

  it('formats durations', () => {
    expect(formatDuration(999)).toBe('999 ms');
    expect(formatDuration(59_940)).toBe('59.9 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });

  it('turns every newline into CRLF once', () => {
    expect(toTerminalText('a\nb\r\nc')).toBe('a\r\nb\r\nc');
  });
});
