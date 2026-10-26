import { spawn } from 'node:child_process';
import path from 'node:path';

const POSIX_KILL_GRACE_MS = 2000;
const POLL_MS = 50;

/**
 * Stops a process and everything it started. Windows: `taskkill /T /F`. POSIX: SIGTERM to the process
 * group (the runner starts commands detached, so the shell leads its own group), SIGKILL after 2 s.
 * Never rejects; a process that is already gone is fine.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') return taskkill(pid);
  if (!signalGroup(pid, 'SIGTERM')) return;
  const deadline = Date.now() + POSIX_KILL_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (!groupAlive(pid)) return;
  }
  signalGroup(pid, 'SIGKILL');
}

function taskkill(pid: number): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const exe = systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
  return new Promise((resolve) => {
    try {
      const child = spawn(exe, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolve());
      child.once('exit', () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Signals the group led by `pid`, or the process alone when it leads no group. False when neither exists. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function groupAlive(pid: number): boolean {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    }
  }
  return false;
}
