import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { killProcessTree } from '../../../src/runner/killTree';
import { createProcessFixtures, isAlive, waitFor } from './fixtures';

const fixtures = createProcessFixtures();
afterAll(() => fixtures.cleanup());

describe('killProcessTree', () => {
  it('kills a process and its children', { timeout: 30_000 }, async () => {
    const marker = path.join(fixtures.dir, 'kill-marker');
    const started = path.join(fixtures.dir, 'kill-started');
    const child = spawn(process.execPath, [fixtures.parent, marker, started, String(Date.now() + 60_000)], {
      stdio: 'ignore',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(
      await waitFor(() => fs.existsSync(started) && fs.readFileSync(started, 'utf8') !== '', 10_000),
    ).toBe(true);
    const grandchildPid = Number(fs.readFileSync(started, 'utf8'));
    expect(isAlive(grandchildPid)).toBe(true);

    await killProcessTree(child.pid!);
    await exited;
    expect(await waitFor(() => !isAlive(grandchildPid), 5000)).toBe(true);
  });

  it('ignores processes that are already gone', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => child.once('exit', resolve));
    await expect(killProcessTree(child.pid!)).resolves.toBeUndefined();
  });
});
