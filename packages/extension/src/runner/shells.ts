import path from 'node:path';
import type { ShellName } from '@isar-flow/core';
import type { ResolvedShell } from '../contracts';
import { envValue } from './env';
import { findExecutable } from './which';

export interface ResolveShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Full path of a command name or absolute path, or undefined when it does not exist. */
  which?: (cmd: string) => string | undefined;
}

/** A resolved shell plus how Node must pass its arguments (cmd.exe needs them unquoted). */
export interface ShellCommand extends ResolvedShell {
  windowsVerbatimArguments: boolean;
}

const OTHER_SHELL = 'choose another shell for the block or change the isarFlow.defaultShell setting';
const OTHER_SHELL_SENTENCE =
  'Choose another shell for the block or change the isarFlow.defaultShell setting.';
const POSIX_SHELL_NAME = /^(ba|z|k|mk|da|a|ya)?sh$/;

interface Context {
  win: boolean;
  p: typeof path.posix;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  which: (cmd: string) => string | undefined;
}

/** Finds the executable for a shell setting and how to hand it a command line. Throws when it is missing. */
export function resolveShell(shell: ShellName, opts: ResolveShellOptions = {}): ShellCommand {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const win = platform === 'win32';
  const ctx: Context = {
    win,
    p: win ? path.win32 : path.posix,
    env,
    platform,
    which: opts.which ?? ((cmd) => findExecutable(cmd, env, platform)),
  };
  switch (shell) {
    case 'auto':
      if (!win) return posixAuto(ctx);
      return pwshShell(
        ctx,
        findPwsh(ctx) ?? required(findWindowsPowerShell(ctx), 'Windows PowerShell', 'powershell'),
      );
    case 'pwsh':
      return pwshShell(ctx, findPwsh(ctx) ?? missingPwsh());
    case 'powershell':
      if (!win) throw onlyOnWindows('Windows PowerShell (powershell)', 'Use pwsh, or');
      return pwshShell(ctx, required(findWindowsPowerShell(ctx), 'Windows PowerShell', 'powershell'));
    case 'cmd':
      if (!win) throw onlyOnWindows('Command Prompt (cmd)');
      return cmdShell(required(findCmd(ctx), 'Command Prompt', 'cmd'));
    case 'bash':
      return posixShell(
        ctx,
        required(win ? findWindowsBash(ctx) : (ctx.which('bash') ?? ctx.which('/bin/bash')), 'bash'),
      );
    case 'sh':
      return posixShell(
        ctx,
        required(win ? findWindowsSh(ctx) : (ctx.which('/bin/sh') ?? ctx.which('sh')), 'sh'),
      );
  }
}

function onlyOnWindows(name: string, alternative?: string): Error {
  const fix = alternative ? `${alternative} ${OTHER_SHELL}.` : OTHER_SHELL_SENTENCE;
  return new Error(`${name} is only available on Windows. ${fix}`);
}

function required(file: string | undefined, label: string, command = label): string {
  if (file) return file;
  const name = label === command ? label : `${label} (${command})`;
  throw new Error(`${name} was not found. Install it, or ${OTHER_SHELL}.`);
}

function missingPwsh(): never {
  throw new Error(`PowerShell 7 (pwsh) was not found. Install PowerShell 7, or ${OTHER_SHELL}.`);
}

/* ---------- finding executables ---------- */

function findPwsh(ctx: Context): string | undefined {
  const fromPath = ctx.which('pwsh');
  if (fromPath || !ctx.win) return fromPath;
  const programFiles = envValue(ctx.env, 'ProgramFiles', ctx.platform);
  return programFiles ? ctx.which(ctx.p.join(programFiles, 'PowerShell', '7', 'pwsh.exe')) : undefined;
}

function findWindowsPowerShell(ctx: Context): string | undefined {
  return (
    ctx.which('powershell') ??
    ctx.which(ctx.p.join(systemRoot(ctx), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  );
}

function findCmd(ctx: Context): string | undefined {
  return (
    envValue(ctx.env, 'ComSpec', ctx.platform) ??
    ctx.which('cmd') ??
    ctx.which(ctx.p.join(systemRoot(ctx), 'System32', 'cmd.exe'))
  );
}

/** Git Bash; the bash.exe in System32 or WindowsApps starts WSL, which is only a last resort. */
function findWindowsBash(ctx: Context): string | undefined {
  const fromPath = ctx.which('bash');
  if (fromPath && !isWslLauncher(ctx, fromPath)) return fromPath;
  return firstFound(ctx, gitBinCandidates(ctx, 'bash.exe')) ?? fromPath;
}

function findWindowsSh(ctx: Context): string | undefined {
  return ctx.which('sh') ?? firstFound(ctx, gitBinCandidates(ctx, 'sh.exe'));
}

function isWslLauncher(ctx: Context, file: string): boolean {
  const lower = file.toLowerCase();
  const system32 = `${ctx.p.join(systemRoot(ctx), 'System32').toLowerCase()}\\`;
  return lower.startsWith(system32) || lower.includes('\\windowsapps\\');
}

/** `<git root>\bin\<exe>` for the git on PATH (in `cmd\` or `mingw64\bin\`) and the default install. */
function gitBinCandidates(ctx: Context, exe: string): string[] {
  const { p } = ctx;
  const roots: string[] = [];
  const git = ctx.which('git');
  if (git) {
    const dir = p.dirname(git);
    roots.push(p.dirname(dir), p.dirname(p.dirname(dir)));
  }
  const programFiles = envValue(ctx.env, 'ProgramFiles', ctx.platform);
  if (programFiles) roots.push(p.join(programFiles, 'Git'));
  return roots.map((root) => p.join(root, 'bin', exe));
}

function firstFound(ctx: Context, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const found = ctx.which(candidate);
    if (found) return found;
  }
  return undefined;
}

function systemRoot(ctx: Context): string {
  return envValue(ctx.env, 'SystemRoot', ctx.platform) ?? 'C:\\Windows';
}

function posixAuto(ctx: Context): ShellCommand {
  const login = envValue(ctx.env, 'SHELL', ctx.platform);
  if (login && POSIX_SHELL_NAME.test(ctx.p.basename(login))) {
    const found = ctx.which(login);
    if (found) return posixShell(ctx, found);
  }
  const fallback = ctx.which('/bin/bash') ?? ctx.which('/bin/sh') ?? ctx.which('sh');
  return posixShell(ctx, required(fallback, 'A POSIX shell', 'sh'));
}

/* ---------- command lines ---------- */

function normalizeNewlines(command: string): string {
  return command.replace(/\r\n?/g, '\n');
}

function posixShell(ctx: Context, file: string): ShellCommand {
  return {
    file,
    label: ctx.p.basename(file).replace(/\.exe$/i, ''),
    windowsVerbatimArguments: false,
    args: (command) => ['-c', normalizeNewlines(command)],
  };
}

function pwshShell(ctx: Context, file: string): ShellCommand {
  const windowsPowerShell = /^powershell(\.exe)?$/i.test(ctx.p.basename(file));
  // npm, npx and friends ship .ps1 shims that the default "Restricted" policy refuses to load.
  const policy = ctx.win ? ['-ExecutionPolicy', 'Bypass'] : [];
  return {
    file,
    label: windowsPowerShell ? 'Windows PowerShell' : 'PowerShell 7',
    windowsVerbatimArguments: false,
    args: (command) => [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      ...policy,
      '-Command',
      powershellScript(command),
    ],
  };
}

/**
 * Runs the command inside a function so `$?` can be read right after its last statement (a failed
 * cmdlet exits with 1) and errors name the function instead of echoing this wrapper. A non-zero
 * `$LASTEXITCODE` from the last native program wins. Output is forced to UTF-8 without BOM.
 */
function powershellScript(command: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'; " +
      'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; ' +
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
      '$global:LASTEXITCODE = 0; $script:isarFlowOk = $true',
    'function IsarFlowCommand {',
    normalizeNewlines(command),
    '$script:isarFlowOk = $?',
    '}',
    'IsarFlowCommand',
    'if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE }; if (-not $script:isarFlowOk) { exit 1 }; exit 0',
  ].join('\n');
}

/**
 * cmd.exe caches the code page when it starts, so `chcp 65001` only affects programs started after it:
 * the command runs in a nested cmd.exe that sees UTF-8. cmd /c reads one line only, so lines are chained
 * with `&` (a trailing `^` still continues a line).
 */
function cmdShell(file: string): ShellCommand {
  const exe = file.includes(' ') ? `"${file}"` : file;
  return {
    file,
    label: 'Command Prompt',
    windowsVerbatimArguments: true,
    args: (command) => {
      const line = command
        .replace(/\^\r?\n/g, '')
        .split(/\r?\n/)
        .filter((part) => part.trim() !== '')
        .join('& ');
      return ['/d', '/s', '/c', `"chcp 65001>nul & ${exe} /d /s /c "${line}""`];
    },
  };
}
