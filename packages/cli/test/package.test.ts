import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('@isar-flow/cli package', () => {
  const pkg = readJson(join(__dirname, '..', 'package.json'));

  it('provides the isar-flow binary built by esbuild', () => {
    expect(pkg.name).toBe('@isar-flow/cli');
    expect(pkg.type).toBe('module');
    expect(pkg.bin).toEqual({ 'isar-flow': 'dist/cli.js' });
    expect(pkg.scripts).toMatchObject({ build: 'node esbuild.mjs', typecheck: 'tsc -p tsconfig.json' });
  });

  it('bundles core instead of depending on anything new', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toEqual({ '@isar-flow/core': '*' });
  });

  it('has no MCP mode (owner exclusion)', () => {
    expect(JSON.stringify(pkg).toLowerCase()).not.toContain('mcp');
  });

  it('is a workspace and a vitest project of the monorepo', () => {
    const root = readJson(join(ROOT, 'package.json'));
    expect(root.workspaces).toContain('packages/cli');
    expect(readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')).toContain("'packages/cli'");
  });
});
