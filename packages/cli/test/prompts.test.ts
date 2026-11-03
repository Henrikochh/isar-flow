import { afterEach, describe, expect, it } from 'vitest';
import { createLineReader, type LineReader } from '../src/lineReader';
import { createTerminalPrompts, NO_TERMINAL } from '../src/prompts';
import { captureStream, scriptedInput } from './helpers';

const readers: LineReader[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
});

function setup(lines: string[], options: { yes?: boolean; terminal?: boolean } = {}) {
  const input = scriptedInput(lines);
  const output = captureStream();
  const reader = createLineReader(input, output);
  readers.push(reader);
  const prompts = createTerminalPrompts({
    output,
    yes: options.yes ?? false,
    ...((options.terminal ?? true) && { reader }),
  });
  return { prompts, output, input };
}

const signal = () => new AbortController().signal;

describe('line reader', () => {
  it('keeps lines typed ahead and rejects when the input ends', async () => {
    const input = scriptedInput(['one', 'two']);
    const output = captureStream();
    const reader = createLineReader(input, output);
    readers.push(reader);
    expect(await reader.read('a? ')).toBe('one');
    expect(await reader.read('b? ')).toBe('two');
    const third = reader.read('c? ');
    input.end();
    await expect(third).rejects.toThrow('The input ended before an answer was typed.');
    await expect(reader.read('d? ')).rejects.toThrow('The input ended before an answer was typed.');
    expect(output.text()).toBe('a? b? c? \nd? \n');
  });

  it('stops waiting when the signal aborts, with its reason', async () => {
    const output = captureStream();
    const reader = createLineReader(scriptedInput(), output);
    readers.push(reader);
    const controller = new AbortController();
    const pending = reader.read('> ', controller.signal);
    controller.abort(new Error('Timed out after 5s.'));
    await expect(pending).rejects.toThrow('Timed out after 5s.');
    await expect(reader.read('> ', controller.signal)).rejects.toThrow('Timed out after 5s.');
  });

  it('rejects waiting reads when it is closed', async () => {
    const reader = createLineReader(scriptedInput(), captureStream());
    const pending = reader.read('> ');
    reader.close();
    await expect(pending).rejects.toThrow('The input ended before an answer was typed.');
  });
});

describe('approvals', () => {
  it('asks y/n and an optional comment', async () => {
    const { prompts, output } = setup(['maybe', 'Y', 'Looks good']);
    expect(await prompts.approve({ stepId: 'review', message: 'Deploy to prod?' }, signal())).toEqual({
      approved: true,
      comment: 'Looks good',
    });
    expect(output.text()).toContain('Approval needed in review: Deploy to prod?\nApprove? [y/n] ');
    expect(output.text()).toContain('Type y or n.');
    expect(output.text()).toContain('Comment (optional): ');
  });

  it('rejects without a comment', async () => {
    const { prompts } = setup(['no', '']);
    expect(await prompts.approve({ stepId: 'review', message: 'Go?' }, signal())).toEqual({
      approved: false,
    });
  });

  it('approves with --yes without reading', async () => {
    const { prompts, output } = setup([], { yes: true });
    expect(await prompts.approve({ stepId: 'review', message: 'Go?' }, signal())).toEqual({ approved: true });
    expect(output.text()).toContain('Approved (--yes)');
  });

  it('rejects without a terminal and says how to approve', async () => {
    const { prompts } = setup([], { terminal: false });
    expect(await prompts.approve({ stepId: 'review', message: 'Go?' }, signal())).toEqual({
      approved: false,
      comment: NO_TERMINAL,
    });
  });
});

describe('ask', () => {
  const pick = { stepId: 'pick', question: 'Which environment?', choices: ['dev', 'prod', 'qa'] };

  it('lists the choices and takes a number or the text', async () => {
    const { prompts, output } = setup(['2', 'QA', '7', 'stage', 'dev']);
    expect(await prompts.ask(pick, signal())).toEqual({ answer: 'prod' });
    expect(await prompts.ask(pick, signal())).toEqual({ answer: 'qa' });
    expect(await prompts.ask(pick, signal())).toEqual({ answer: 'dev' });
    const text = output.text();
    expect(text).toContain('Question from pick: Which environment?\n  1) dev\n  2) prod\n  3) qa\n');
    expect(text).toContain("'7' isn't one of the choices. Type a number from 1 to 3 or a choice.");
    expect(text).toContain("'stage' isn't one of the choices. Type a number from 1 to 3 or a choice.");
  });

  it('marks the default and uses it for Enter', async () => {
    const { prompts, output } = setup(['']);
    expect(await prompts.ask({ ...pick, default: 'prod' }, signal())).toEqual({ answer: 'prod' });
    expect(output.text()).toContain('  2) prod (default)\n');
    expect(output.text()).toContain('Enter picks the default.');
  });

  it('reads free text and asks again on Enter without a default', async () => {
    const { prompts, output } = setup(['', '  release 1.2  ']);
    expect(await prompts.ask({ stepId: 'name', question: 'Name?' }, signal())).toEqual({
      answer: 'release 1.2',
    });
    expect(output.text()).toContain('> ');
    expect(output.text()).toContain('Type an answer.');
    const withDefault = setup(['']);
    expect(
      await withDefault.prompts.ask({ stepId: 'name', question: 'Name?', default: 'v1' }, signal()),
    ).toEqual({
      answer: 'v1',
    });
  });

  it('answers with the default, else the first choice, with --yes', async () => {
    const { prompts, output } = setup([], { yes: true });
    expect(await prompts.ask({ ...pick, default: 'qa' }, signal())).toEqual({ answer: 'qa' });
    expect(await prompts.ask(pick, signal())).toEqual({ answer: 'dev' });
    expect(output.text()).toContain("Answered 'dev' (--yes)");
    await expect(prompts.ask({ stepId: 'name', question: 'Name?' }, signal())).rejects.toThrow(
      "'name' needs an answer, but --yes gives none. Give it a default or run without --yes.",
    );
  });

  it('fails without a terminal', async () => {
    const { prompts } = setup([], { terminal: false });
    await expect(prompts.ask(pick, signal())).rejects.toThrow(NO_TERMINAL);
  });

  it('gives up when the block times out', async () => {
    const { prompts } = setup([]);
    const controller = new AbortController();
    const pending = prompts.ask(pick, controller.signal);
    controller.abort(new Error('timeout'));
    await expect(pending).rejects.toThrow('timeout');
  });
});

describe('tool permissions', () => {
  const request = {
    runId: 'r',
    stepId: 'fix',
    tool: 'editFile' as const,
    summary: 'Edit src/app.ts',
    detail: 'Replace:\na\n\nWith:\nb',
  };

  it('asks yes, always for this run or no', async () => {
    const { prompts, output } = setup(['x', 'y', 'a', 'n', '']);
    expect(await prompts.permission(request)).toBe('allow');
    expect(await prompts.permission(request)).toBe('allowRun');
    expect(await prompts.permission(request)).toBe('deny');
    expect(await prompts.permission(request)).toBe('deny');
    const text = output.text();
    expect(text).toContain('The agent in fix asks: Edit src/app.ts\n  Replace:\n  a\n\n  With:\n  b\n');
    expect(text).toContain('Allow Edit src/app.ts? [y]es / [a]lways for this run / [n]o ');
    expect(text).toContain('Type y, a or n.');
  });

  it('allows with --yes and denies without a terminal', async () => {
    const yes = setup([], { yes: true });
    expect(await yes.prompts.permission(request)).toBe('allow');
    expect(yes.output.text()).toContain('Allowed (--yes): Edit src/app.ts');
    const none = setup([], { terminal: false });
    expect(await none.prompts.permission(request)).toBe('deny');
    expect(none.output.text()).toContain('Denied (no terminal): Edit src/app.ts');
  });

  it('asks one question at a time', async () => {
    const { prompts, output } = setup(['y', '1']);
    const [allowed, answered] = await Promise.all([
      prompts.permission(request),
      prompts.ask({ stepId: 'pick', question: 'Which?', choices: ['a', 'b'] }, signal()),
    ]);
    expect(allowed).toBe('allow');
    expect(answered).toEqual({ answer: 'a' });
    expect(output.text().indexOf('Question from pick')).toBeGreaterThan(output.text().indexOf('Allow Edit'));
  });
});
