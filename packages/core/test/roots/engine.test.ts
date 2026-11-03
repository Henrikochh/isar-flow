import { describe, expect, it } from 'vitest';
import type { EditorContext, GitContext, RunOrigin } from '../../src/engine/types';
import { isCutString, LIVE_VALUE_MAX_CHARS } from '../../src/live/context';
import { eventsOfType, run, workflow } from '../engine/helpers';
import { FakeHost } from '../fakes/fakeHost';

const editor: EditorContext = {
  selection: 'const a = 1;',
  file: 'src/app.ts',
  language: 'typescript',
  line: 12,
};
const git: GitContext = {
  branch: 'feature/login',
  changedFiles: ['src/app.ts', 'README.md'],
  diff: '+added',
};

const echo = (run: string) => workflow([{ id: 'show', type: 'console', run }]);

describe('editor and git roots in expressions', () => {
  it('reads the editor and git values the host captured', async () => {
    const host = new FakeHost();
    await run(
      echo(
        '${{ editor.file }}:${{ editor.line }} ${{ editor.language }} [${{ editor.selection }}] ' +
          '${{ git.branch }} ${{ join(git.changedFiles, ",") }} ${{ git.diff }}',
      ),
      { host, editor, git },
    );
    expect(host.consoleCalls[0].command).toBe(
      'src/app.ts:12 typescript [const a = 1;] feature/login src/app.ts,README.md +added',
    );
  });

  it('reads empty values when the run has no editor or git values', async () => {
    const host = new FakeHost();
    await run(
      echo(
        '[${{ editor.selection }}][${{ editor.file }}][${{ editor.language }}][${{ editor.line }}]' +
          '[${{ git.branch }}][${{ length(git.changedFiles) }}][${{ git.diff }}]',
      ),
      { host },
    );
    expect(host.consoleCalls[0].command).toBe('[][][][0][][0][]');
  });

  it('fills fields a host left out with empty values', async () => {
    const host = new FakeHost();
    const partial = { selection: 'x' } as unknown as EditorContext;
    await run(echo('[${{ editor.selection }}][${{ editor.line }}][${{ git.branch }}]'), {
      host,
      editor: partial,
      git: { branch: 'main' } as unknown as GitContext,
    });
    expect(host.consoleCalls[0].command).toBe('[x][0][main]');
  });

  it('evaluates conditions on git values', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([
        {
          id: 'gate',
          type: 'if',
          condition: "git.branch == 'main' || length(git.changedFiles) == 0",
          then: [{ id: 'skip', type: 'console', run: 'echo nothing to do' }],
          else: [{ id: 'check', type: 'console', run: 'npm test' }],
        },
      ]),
      { host, git },
    );
    expect(r.output('gate')).toMatchObject({ result: false, branch: 'else' });
    expect(host.consoleCalls.map((c) => c.command)).toEqual(['npm test']);
  });

  it('can be read in workflow env', async () => {
    const host = new FakeHost();
    await run(
      workflow([{ id: 'show', type: 'console', run: 'echo' }], {
        env: { TARGET: '${{ editor.file }}', BRANCH: '${{ git.branch }}' },
      }),
      { host, editor, git },
    );
    expect(host.consoleCalls[0].env).toEqual({ TARGET: 'src/app.ts', BRANCH: 'feature/login' });
  });

  it('does not let expressions or hosts change the values the run started with', async () => {
    const host = new FakeHost();
    const captured: GitContext = { branch: 'main', changedFiles: ['a.ts'], diff: '' };
    const r = run(
      workflow([
        { id: 'a', type: 'console', run: 'echo ${{ git.branch }}' },
        { id: 'b', type: 'console', run: 'echo ${{ join(git.changedFiles, ",") }}' },
      ]),
      { host, git: captured },
    );
    captured.branch = 'changed';
    captured.changedFiles.push('b.ts');
    await r;
    expect(host.consoleCalls.map((c) => c.command)).toEqual(['echo main', 'echo a.ts']);
  });
});

describe('run-start: editor and git snapshot', () => {
  const runStart = async (options: Parameters<typeof run>[1]) => {
    const r = await run(echo('echo'), options);
    return { ...r, start: eventsOfType(r.events, 'run-start')[0] };
  };

  it('records the editor and git values the run got', async () => {
    const { start } = await runStart({ editor, git });
    expect(start.context?.editor).toEqual(editor);
    expect(start.context?.git).toEqual(git);
  });

  it('records nothing for runs without them', async () => {
    const { start } = await runStart({});
    expect(start.context).not.toHaveProperty('editor');
    expect(start.context).not.toHaveProperty('git');
    const onlyGit = await runStart({ git });
    expect(onlyGit.start.context).not.toHaveProperty('editor');
    expect(onlyGit.start.context?.git).toEqual(git);
  });

  it('cuts long selections and diffs like live values and keeps the first 200 changed files', async () => {
    const long = 'x'.repeat(LIVE_VALUE_MAX_CHARS + 500);
    const files = Array.from({ length: 250 }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`);
    const host = new FakeHost();
    const { start } = await runStart({
      host,
      editor: { ...editor, selection: long },
      git: { branch: 'main', changedFiles: files, diff: long },
    });
    const snapshot = start.context;
    expect(snapshot?.editor?.selection).toHaveLength(LIVE_VALUE_MAX_CHARS + 1);
    expect(isCutString(snapshot?.editor?.selection)).toBe(true);
    expect(isCutString(snapshot?.git?.diff)).toBe(true);
    expect(snapshot?.git?.changedFiles).toEqual(files.slice(0, 200));
    expect(snapshot?.editor?.file).toBe('src/app.ts');
  });

  it('still gives expressions the whole values', async () => {
    const long = 'y'.repeat(LIVE_VALUE_MAX_CHARS + 10);
    const host = new FakeHost();
    await run(echo('${{ length(editor.selection) }}'), { host, editor: { ...editor, selection: long } });
    expect(host.consoleCalls[0].command).toBe(String(LIVE_VALUE_MAX_CHARS + 10));
  });

  it('masks secrets in every recorded string, also when they sit at the cut', async () => {
    const TOKEN = 'sk-secret-123456';
    const atCut = `${'a'.repeat(LIVE_VALUE_MAX_CHARS - 5)}${TOKEN}`;
    const host = new FakeHost();
    const r = await run(
      echo('echo ${{ editor.selection }} ${{ git.diff }} ${{ git.branch }} ${{ editor.file }}'),
      {
        host,
        secrets: { TOKEN },
        editor: { ...editor, selection: `token = "${TOKEN}"`, file: `${TOKEN}.ts` },
        git: { branch: TOKEN, changedFiles: [`${TOKEN}/a.ts`], diff: atCut },
      },
    );
    const start = eventsOfType(r.events, 'run-start')[0];
    expect(start.context?.editor?.selection).toBe('token = "••••••"');
    expect(start.context?.git?.branch).toBe('••••••');
    expect(start.context?.git?.changedFiles).toEqual(['••••••/a.ts']);
    expect(start.context?.git?.diff.startsWith('a'.repeat(LIVE_VALUE_MAX_CHARS - 5))).toBe(true);
    expect(host.consoleCalls[0].command).toContain(TOKEN);
    expect(JSON.stringify(r.events)).not.toContain(TOKEN);
    expect(JSON.stringify(r.events)).not.toContain(TOKEN.slice(0, 5));
  });
});

describe('run-start: origin', () => {
  const startOf = async (origin: RunOrigin | undefined) => {
    const r = await run(echo('echo'), origin === undefined ? {} : { origin });
    return eventsOfType(r.events, 'run-start')[0];
  };

  it('records how the run was started', async () => {
    const origin: RunOrigin = { kind: 'trigger', trigger: 'save', file: 'src/app.ts' };
    expect((await startOf(origin)).origin).toEqual(origin);
    expect((await startOf({ kind: 'copilot' })).origin).toEqual({ kind: 'copilot' });
  });

  it('leaves manual runs and runs without origin unmarked', async () => {
    expect(await startOf({ kind: 'manual' })).not.toHaveProperty('origin');
    expect(await startOf(undefined)).not.toHaveProperty('origin');
  });

  it('records a copy of the origin', async () => {
    const origin: RunOrigin = { kind: 'trigger', trigger: 'change', file: 'docs/a.md' };
    const start = await startOf(origin);
    expect(start.origin).not.toBe(origin);
  });
});
