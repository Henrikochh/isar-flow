import type { ApprovalRequest, ApprovalResult, AskRequest, AskResult } from '@isar-flow/core';
import type { PermissionAnswer, PermissionPrompt } from '@isar-flow/core/node';
import type { CliOutput } from './io';
import type { LineReader } from './lineReader';

export const NO_TERMINAL = 'No terminal to ask in. Run with --yes to approve and use default answers.';

export interface TerminalPromptOptions {
  /** Reads the answers; omitted when stdin is not a terminal (then nobody is asked). */
  reader?: LineReader;
  /** --yes: approve, use default answers and allow agent tools without asking. */
  yes: boolean;
  /** Where questions go (stderr, so stdout stays clean for --json). */
  output: CliOutput;
}

/** Approvals, ask blocks and agent tool permissions in the terminal. Texts arrive masked. */
export interface TerminalPrompts {
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult>;
  ask(request: AskRequest, signal: AbortSignal): Promise<AskResult>;
  permission: PermissionPrompt;
}

/** What a typed line means: an answer, or what to say before asking again. */
type Reply<T> = { answer: T } | { retry: string };

const YES_NO: Record<string, boolean> = { y: true, yes: true, n: false, no: false };
const PERMISSIONS: Record<string, PermissionAnswer> = {
  y: 'allow',
  yes: 'allow',
  a: 'allowRun',
  always: 'allowRun',
  n: 'deny',
  no: 'deny',
  '': 'deny',
};

const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n');

/** One question at a time: answers typed for one prompt never go to another. */
/**
 * The engine runs ahead of the event reporter, so a prompt first waits one macrotask: the block's queued start
 * line is printed before its question.
 */
const afterQueuedEvents = () => new Promise<void>((resolve) => setImmediate(resolve));

function serialize() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = () => afterQueuedEvents().then(task);
    const result = last.then(run, run);
    last = result.catch(() => undefined);
    return result;
  };
}

function choiceReply(line: string, choices: string[], fallback: string | undefined): Reply<string> {
  if (line === '')
    return fallback === undefined ? { retry: 'Type a number or a choice.' } : { answer: fallback };
  const byNumber = /^\d+$/.test(line) ? choices[Number(line) - 1] : undefined;
  const answer = byNumber ?? choices.find((choice) => choice.toLowerCase() === line.toLowerCase());
  if (answer !== undefined) return { answer };
  return {
    retry: `'${line}' isn't one of the choices. Type a number from 1 to ${choices.length} or a choice.`,
  };
}

export function createTerminalPrompts({ reader, yes, output }: TerminalPromptOptions): TerminalPrompts {
  const exclusive = serialize();
  const say = (text: string) => output.write(`${text}\n`);

  async function readUntil<T>(
    terminal: LineReader,
    prompt: string,
    signal: AbortSignal | undefined,
    meaning: (line: string) => Reply<T>,
  ): Promise<T> {
    for (;;) {
      const reply = meaning((await terminal.read(prompt, signal)).trim());
      if ('answer' in reply) return reply.answer;
      say(reply.retry);
    }
  }

  const approve = (request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult> =>
    exclusive(async () => {
      say(`\nApproval needed in ${request.stepId}: ${request.message}`);
      if (yes) {
        say('Approved (--yes)');
        return { approved: true };
      }
      if (!reader) {
        say(NO_TERMINAL);
        return { approved: false, comment: NO_TERMINAL };
      }
      const approved = await readUntil(reader, 'Approve? [y/n] ', signal, (line): Reply<boolean> => {
        const value: boolean | undefined = YES_NO[line.toLowerCase()];
        return value === undefined ? { retry: 'Type y or n.' } : { answer: value };
      });
      const comment = (await reader.read('Comment (optional): ', signal)).trim();
      return { approved, ...(comment !== '' && { comment }) };
    });

  const ask = (request: AskRequest, signal: AbortSignal): Promise<AskResult> =>
    exclusive(async () => {
      const { stepId, question, choices, default: fallback } = request;
      if (yes) {
        const answer = fallback ?? choices?.[0];
        if (answer === undefined) {
          throw new Error(
            `'${stepId}' needs an answer, but --yes gives none. Give it a default or run without --yes.`,
          );
        }
        say(`\nQuestion from ${stepId}: ${question}\nAnswered '${answer}' (--yes)`);
        return { answer };
      }
      if (!reader) throw new Error(NO_TERMINAL);
      say(`\nQuestion from ${stepId}: ${question}`);
      if (choices) {
        choices.forEach((choice, i) =>
          say(`  ${i + 1}) ${choice}${choice === fallback ? ' (default)' : ''}`),
        );
        say(`Type a number or a choice${fallback === undefined ? '.' : '; Enter picks the default.'}`);
        return {
          answer: await readUntil(reader, '> ', signal, (line) => choiceReply(line, choices, fallback)),
        };
      }
      if (fallback !== undefined) say(`Type an answer; Enter picks the default (${fallback}).`);
      const answer = await readUntil(reader, '> ', signal, (line): Reply<string> => {
        if (line !== '') return { answer: line };
        return fallback === undefined ? { retry: 'Type an answer.' } : { answer: fallback };
      });
      return { answer };
    });

  const permission: PermissionPrompt = (request) =>
    exclusive(async (): Promise<PermissionAnswer> => {
      if (yes) {
        say(`Allowed (--yes): ${request.summary}`);
        return 'allow';
      }
      if (!reader) {
        say(`Denied (no terminal): ${request.summary}`);
        return 'deny';
      }
      say(`\nThe agent in ${request.stepId} asks: ${request.summary}`);
      if (request.detail) say(indent(request.detail));
      const prompt = `Allow ${request.summary}? [y]es / [a]lways for this run / [n]o `;
      return readUntil(reader, prompt, undefined, (line): Reply<PermissionAnswer> => {
        const answer: PermissionAnswer | undefined = PERMISSIONS[line.toLowerCase()];
        return answer === undefined ? { retry: 'Type y, a or n.' } : { answer };
      });
    });

  return { approve, ask, permission };
}
