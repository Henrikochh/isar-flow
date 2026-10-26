import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findExecutable } from '../../../src/runner/which';
import { resolveShell } from '../../../src/runner/shells';
import { removeTempDir } from './fixtures';

/** A `which` that knows exactly the given paths, keyed by command name or absolute path. */
function whichOf(known: Record<string, string>): (cmd: string) => string | undefined {
  return (cmd) => known[cmd];
}

const WIN_ENV = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

describe('resolveShell on Windows', () => {
  const win = (known: Record<string, string>, env: NodeJS.ProcessEnv = WIN_ENV) => ({
    platform: 'win32' as const,
    env,
    which: whichOf(known),
  });

  it('auto prefers PowerShell 7 when it is on PATH', () => {
    const shell = resolveShell('auto', win({ pwsh: 'C:\\pwsh\\pwsh.exe', powershell: PS51 }));
    expect(shell.file).toBe('C:\\pwsh\\pwsh.exe');
    expect(shell.label).toBe('PowerShell 7');
  });

  it('auto falls back to Windows PowerShell', () => {
    const shell = resolveShell('auto', win({ powershell: PS51 }));
    expect(shell.file).toBe(PS51);
    expect(shell.label).toBe('Windows PowerShell');
  });

  it('finds Windows PowerShell in System32 when PATH lacks it', () => {
    const shell = resolveShell('powershell', win({ [PS51]: PS51 }));
    expect(shell.file).toBe(PS51);
  });

  it('runs PowerShell without profile, forcing UTF-8 and propagating failures', () => {
    const shell = resolveShell('powershell', win({ powershell: PS51 }));
    const args = shell.args('npm test');
    expect(args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive']);
    expect(args).toContain('-Command');
    expect(args).toContain('Bypass');
    const script = args[args.length - 1];
    expect(script).toContain('[Console]::OutputEncoding');
    expect(script).toContain('\nnpm test\n');
    expect(script).toContain('exit $global:LASTEXITCODE');
    expect(script).toContain('exit 1');
    expect(shell.windowsVerbatimArguments).toBe(false);
  });

  it('runs cmd with the UTF-8 code page and verbatim arguments', () => {
    const shell = resolveShell('cmd', win({}));
    expect(shell.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(shell.label).toBe('Command Prompt');
    expect(shell.windowsVerbatimArguments).toBe(true);
    const args = shell.args('echo hi\r\necho there');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(args[3]).toBe('"chcp 65001>nul & C:\\Windows\\system32\\cmd.exe /d /s /c "echo hi& echo there""');
  });

  it('quotes a cmd path with spaces', () => {
    const shell = resolveShell('cmd', win({}, { ComSpec: 'C:\\My Tools\\cmd.exe' }));
    expect(shell.args('ver')[3]).toBe('"chcp 65001>nul & "C:\\My Tools\\cmd.exe" /d /s /c "ver""');
  });

  it('prefers Git Bash over the WSL launcher in System32', () => {
    const shell = resolveShell(
      'bash',
      win({
        bash: 'C:\\Windows\\System32\\bash.exe',
        git: 'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe': 'C:\\Program Files\\Git\\bin\\bash.exe',
      }),
    );
    expect(shell.file).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(shell.args('echo hi')).toEqual(['-c', 'echo hi']);
  });

  it('uses bash from PATH when it is not the WSL launcher', () => {
    const shell = resolveShell('bash', win({ bash: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' }));
    expect(shell.file).toBe('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  });

  it('explains a missing PowerShell 7 and names the setting', () => {
    expect(() => resolveShell('pwsh', win({ powershell: PS51 }))).toThrow(
      /PowerShell 7.*isarFlow\.defaultShell/s,
    );
  });

  it('explains a missing bash', () => {
    expect(() => resolveShell('bash', win({}))).toThrow(/bash.*not found.*isarFlow\.defaultShell/s);
  });
});

describe('resolveShell on Linux and macOS', () => {
  const posix = (known: Record<string, string>, env: NodeJS.ProcessEnv = {}) => ({
    platform: 'linux' as const,
    env,
    which: whichOf(known),
  });

  it('auto uses $SHELL when it is a POSIX shell', () => {
    const shell = resolveShell('auto', posix({ '/usr/bin/zsh': '/usr/bin/zsh' }, { SHELL: '/usr/bin/zsh' }));
    expect(shell.file).toBe('/usr/bin/zsh');
    expect(shell.label).toBe('zsh');
    expect(shell.args('echo hi')).toEqual(['-c', 'echo hi']);
  });

  it('auto ignores a non-POSIX $SHELL and uses /bin/bash', () => {
    const known = { '/usr/bin/fish': '/usr/bin/fish', '/bin/bash': '/bin/bash', '/bin/sh': '/bin/sh' };
    const shell = resolveShell('auto', posix(known, { SHELL: '/usr/bin/fish' }));
    expect(shell.file).toBe('/bin/bash');
  });

  it('auto falls back to /bin/sh', () => {
    const shell = resolveShell('auto', posix({ '/bin/sh': '/bin/sh' }, { SHELL: '/missing/bash' }));
    expect(shell.file).toBe('/bin/sh');
    expect(shell.label).toBe('sh');
  });

  it('normalizes CRLF in commands for POSIX shells', () => {
    const shell = resolveShell('sh', posix({ '/bin/sh': '/bin/sh' }));
    expect(shell.args('a\r\nb')).toEqual(['-c', 'a\nb']);
  });

  it('runs pwsh without the Windows-only execution policy flag', () => {
    const shell = resolveShell('pwsh', posix({ pwsh: '/usr/bin/pwsh' }));
    expect(shell.file).toBe('/usr/bin/pwsh');
    expect(shell.args('Get-Date')).not.toContain('-ExecutionPolicy');
  });

  it('refuses cmd outside Windows and names the setting', () => {
    expect(() => resolveShell('cmd', posix({}))).toThrow(
      /only available on Windows.*isarFlow\.defaultShell/s,
    );
  });

  it('refuses Windows PowerShell outside Windows', () => {
    expect(() => resolveShell('powershell', posix({}))).toThrow(/isarFlow\.defaultShell/);
  });
});

describe('resolveShell on this machine', () => {
  it('resolves auto to an existing executable', () => {
    const shell = resolveShell('auto');
    expect(fs.existsSync(shell.file)).toBe(true);
  });
});

describe('findExecutable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isar-which-'));
  afterAll(() => removeTempDir(dir));

  it('finds a command on PATH', () => {
    const name = process.platform === 'win32' ? 'isar-tool.cmd' : 'isar-tool';
    const file = path.join(dir, name);
    fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    fs.chmodSync(file, 0o755);
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(findExecutable('isar-tool', env)?.toLowerCase()).toBe(file.toLowerCase());
  });

  it('checks absolute paths directly', () => {
    expect(findExecutable(process.execPath, {})).toBe(process.execPath);
    expect(findExecutable(path.join(dir, 'missing-tool'), {})).toBeUndefined();
  });

  it('returns undefined for unknown commands', () => {
    expect(findExecutable('isar-flow-no-such-tool', { PATH: dir })).toBeUndefined();
  });
});
