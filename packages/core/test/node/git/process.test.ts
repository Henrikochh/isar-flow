import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCapped } from '../../../src/node/git/process';

const node = process.execPath;
const options = (overrides: Partial<Parameters<typeof runCapped>[2]> = {}) => ({
  cwd: tmpdir(),
  timeoutMs: 10_000,
  maxBytes: 1024 * 1024,
  ...overrides,
});

describe('runCapped', () => {
  it('returns the output and exit code', async () => {
    const result = await runCapped(node, ['-e', 'process.stdout.write("hello ü")'], options());
    expect(result).toEqual({ ok: true, exitCode: 0, stdout: Buffer.from('hello ü'), truncated: false });
  });

  it('reports a failing exit code', async () => {
    const result = await runCapped(node, ['-e', 'process.stdout.write("x"); process.exit(3)'], options());
    expect(result).toMatchObject({ ok: false, exitCode: 3, truncated: false });
    expect(result.stdout.toString()).toBe('x');
  });

  it('stops reading and stops the process at maxBytes', async () => {
    const script = 'const s = "y".repeat(65536); for (;;) process.stdout.write(s);';
    const started = Date.now();
    const result = await runCapped(node, ['-e', script], options({ maxBytes: 300_000 }));
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(300_000);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('stops a process that takes too long', async () => {
    const started = Date.now();
    const result = await runCapped(node, ['-e', 'setTimeout(() => {}, 20000)'], options({ timeoutMs: 300 }));
    expect(result).toMatchObject({ ok: false, failure: 'timeout', truncated: false });
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runCapped(
      node,
      ['-e', 'setTimeout(() => {}, 20000)'],
      options({ signal: controller.signal }),
    );
    expect(result).toMatchObject({ ok: false, failure: 'aborted' });
  });

  it('does not start with an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCapped(node, ['-e', ''], options({ signal: controller.signal }));
    expect(result).toEqual({
      ok: false,
      exitCode: null,
      stdout: Buffer.alloc(0),
      truncated: false,
      failure: 'aborted',
    });
  });

  it('reports a missing program', async () => {
    const result = await runCapped(join(tmpdir(), 'isarflow-no-such-program'), [], options());
    expect(result).toMatchObject({ ok: false, failure: 'missing' });
  });

  it('reports a missing working folder', async () => {
    const result = await runCapped(
      node,
      ['-e', ''],
      options({ cwd: join(tmpdir(), 'isarflow-no-such-dir') }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure).toBeDefined();
  });

  it('passes the environment', async () => {
    const result = await runCapped(
      node,
      ['-e', 'process.stdout.write(process.env.ISAR_TEST_VALUE ?? "")'],
      options({ env: { ...process.env, ISAR_TEST_VALUE: 'from env' } }),
    );
    expect(result.stdout.toString()).toBe('from env');
  });
});
