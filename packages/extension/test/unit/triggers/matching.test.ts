import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { compileFiles, pathKey, relativeIn } from '../../../src/triggers/matching';

describe('compileFiles', () => {
  it('matches positive patterns', () => {
    const matcher = compileFiles(['src/**/*.ts', 'README.md']);
    expect(matcher.patterns).toEqual(['src/**/*.ts', 'README.md']);
    expect(matcher.matches('src/app.ts')).toBe(true);
    expect(matcher.matches('src/deep/er/x.ts')).toBe(true);
    expect(matcher.matches('README.md')).toBe(true);
    expect(matcher.matches('docs/README.md')).toBe(false);
    expect(matcher.matches('src/app.js')).toBe(false);
  });

  it('excludes files matching ! patterns', () => {
    const matcher = compileFiles(['src/**', '!src/gen/**', '!**/*.snap']);
    expect(matcher.patterns).toEqual(['src/**']);
    expect(matcher.matches('src/a.ts')).toBe(true);
    expect(matcher.matches('src/gen/a.ts')).toBe(false);
    expect(matcher.matches('src/x/a.snap')).toBe(false);
  });

  it('matches nothing with only exclusions', () => {
    const matcher = compileFiles(['!src/gen/**']);
    expect(matcher.patterns).toEqual([]);
    expect(matcher.matches('src/a.ts')).toBe(false);
  });

  it('normalizes ./ prefixes, backslashes and blanks', () => {
    const matcher = compileFiles(['./src/*.ts', ' docs\\*.md ', '', '!', '! ./src/skip.ts']);
    expect(matcher.patterns).toEqual(['src/*.ts', 'docs/*.md']);
    expect(matcher.matches('src/a.ts')).toBe(true);
    expect(matcher.matches('src/skip.ts')).toBe(false);
    expect(matcher.matches('docs/a.md')).toBe(true);
  });

  it('ignores .git, node_modules and .isarflow at any depth', () => {
    const matcher = compileFiles(['**/*']);
    expect(matcher.matches('src/a.ts')).toBe(true);
    expect(matcher.matches('.git/HEAD')).toBe(false);
    expect(matcher.matches('node_modules/x/index.js')).toBe(false);
    expect(matcher.matches('packages/a/node_modules/x/index.js')).toBe(false);
    expect(matcher.matches('.isarflow/memory.md')).toBe(false);
    expect(matcher.matches('.isarflow/workflows/a.workflow.yaml')).toBe(false);
    expect(matcher.matches('.gitignore')).toBe(true);
  });

  it('watches those folders when a pattern names them', () => {
    const matcher = compileFiles(['.isarflow/notes/**', 'packages/*/node_modules/**']);
    expect(matcher.matches('.isarflow/notes/a.md')).toBe(true);
    expect(matcher.matches('packages/a/node_modules/x.js')).toBe(true);
    expect(matcher.matches('.git/HEAD')).toBe(false);
  });
});

describe('relativeIn', () => {
  const folder = vscode.Uri.file('/ws');

  it('is the forward-slash path inside the folder', () => {
    expect(relativeIn(folder, vscode.Uri.file('/ws/src/a.ts'))).toBe('src/a.ts');
    expect(relativeIn(vscode.Uri.file('/ws/'), vscode.Uri.file('/ws/a.ts'))).toBe('a.ts');
  });

  it('is undefined outside the folder or for other schemes', () => {
    expect(relativeIn(folder, vscode.Uri.file('/wsx/a.ts'))).toBeUndefined();
    expect(relativeIn(folder, vscode.Uri.file('/ws'))).toBeUndefined();
    expect(relativeIn(folder, vscode.Uri.parse('untitled:/ws/a.ts'))).toBeUndefined();
  });
});

describe('pathKey', () => {
  it('uses forward slashes', () => {
    expect(pathKey('C:\\ws\\a.ts').replace(/^c/, 'C')).toBe('C:/ws/a.ts');
  });

  it('gives equal keys for an absolute path and the URI of the same file', () => {
    const uri = vscode.Uri.file('/ws/src/a.ts');
    expect(pathKey(uri.fsPath)).toBe(pathKey('/ws/src/a.ts'));
  });
});
