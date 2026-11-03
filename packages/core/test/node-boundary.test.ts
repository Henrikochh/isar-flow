import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const rel = (file: string) => relative(SRC, file).split(sep).join('/');

describe('Node-only code stays behind @isar-flow/core/node', () => {
  it('is published as a separate subpath export', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports).toEqual({ '.': './src/index.ts', './node': './src/node/index.ts' });
  });

  it('keeps Node APIs and src/node out of the main entry (the webviews import it)', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !rel(file).startsWith('node/'))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return (
          /from\s+['"]node:/.test(text) ||
          /\brequire\(/.test(text) ||
          /from\s+['"](?:\.\.?\/)+node(?:\/[^'"]*)?['"]/.test(text) ||
          /\bprocess\.(?:env|cwd|platform|argv)\b/.test(text)
        );
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('is never imported by the webviews (they run in a browser)', () => {
    const webview = join(__dirname, '..', '..', 'webview-ui');
    const files = ['src', 'harness'].flatMap((dir) =>
      readdirSync(join(webview, dir), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
        .map((entry) => join(entry.parentPath, entry.name)),
    );
    const offenders = files.filter((file) => /@isar-flow\/core\/node/.test(readFileSync(file, 'utf8')));
    expect(files.length).toBeGreaterThan(0);
    expect(offenders.map((file) => relative(webview, file))).toEqual([]);
  });
});
