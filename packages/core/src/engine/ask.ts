import { type ExpressionContext, stringifyValue } from '../expr';
import type { AskStep } from '../schema/types';
import { choiceList, matchChoice } from './choices';
import { renderField, StepSetupError } from './context';
import type { LeafDeps, LeafOutcome, PreparedLeaf } from './leaves';
import type { BlockResult } from './result';
import { stepTimeoutMs } from './timing';
import type { AskResult, StepIO } from './types';

/** Rendered choices, trimmed and without duplicates; undefined for a free-text question. */
function renderChoices(step: AskStep, ctx: ExpressionContext): string[] | undefined {
  if (!Array.isArray(step.choices) || step.choices.length === 0) return undefined;
  const choices: string[] = [];
  step.choices.forEach((choice: unknown, i) => {
    const text = typeof choice === 'string' ? choice : stringifyValue(choice);
    const rendered = renderField(`choices[${i}]`, text, ctx).trim();
    if (rendered === '') {
      throw new StepSetupError(`Choice ${i + 1} of '${step.id}' is empty after its template was filled in.`);
    }
    if (!choices.includes(rendered)) choices.push(rendered);
  });
  return choices;
}

/** The rendered default with the spelling of its choice; undefined when it is missing or empty. */
function renderDefault(
  step: AskStep,
  ctx: ExpressionContext,
  choices: string[] | undefined,
): string | undefined {
  if (step.default === undefined) return undefined;
  const rendered = renderField('default', step.default, ctx).trim();
  if (rendered === '' || !choices) return rendered || undefined;
  const choice = matchChoice(rendered, choices);
  if (choice === undefined) {
    throw new StepSetupError(
      `The default '${rendered}' of '${step.id}' isn't one of its choices: ${choiceList(choices)}.`,
    );
  }
  return choice;
}

const answered = (answer: string, timedOut = false): BlockResult => ({
  status: 'success',
  output: { answer, timedOut },
});

const failed = (error: string, retryable = true): LeafOutcome => ({
  status: 'failure',
  output: { timedOut: false },
  error,
  ...(!retryable && { retryable: false }),
});

/**
 * Prepares an ask block: renders the question, its choices and default up front (template problems fail the
 * block before anyone is asked) and checks the host's answer against the choices.
 */
export function prepareAsk(step: AskStep, deps: LeafDeps): PreparedLeaf {
  const question = renderField('question', step.question, deps.ctx);
  const choices = renderChoices(step, deps.ctx);
  const fallback = renderDefault(step, deps.ctx, choices);
  const timeoutMs = stepTimeoutMs(step.timeout);

  const outcome = (result: AskResult | undefined, io: StepIO): LeafOutcome => {
    const given: unknown = result?.answer;
    const answer = (typeof given === 'string' ? given : stringifyValue(given)).trim();
    if (answer === '') {
      if (fallback === undefined) {
        return failed(`'${step.id}' got an empty answer. Answer the question or give the block a default.`);
      }
      io.log('info', `Nobody answered; using the default '${fallback}'.\n`);
      return answered(fallback);
    }
    if (!choices) return answered(answer);
    const choice = matchChoice(answer, choices);
    if (choice !== undefined) return answered(choice);
    return failed(`Answer '${answer}' isn't one of the choices of '${step.id}': ${choiceList(choices)}.`);
  };

  return {
    detail: question,
    invoke: async (io) => {
      const askUser = deps.host.askUser?.bind(deps.host);
      if (!askUser) {
        const answer = fallback ?? choices?.[0];
        if (answer === undefined)
          return failed(`Nobody can answer '${step.id}' here. Give it a default.`, false);
        const which = fallback === undefined ? 'first choice' : 'default';
        io.log('info', `Nobody can answer here; using the ${which} '${answer}'.\n`);
        return answered(answer);
      }
      const request = {
        stepId: step.id,
        question,
        ...(choices && { choices: [...choices] }),
        ...(fallback !== undefined && { default: fallback }),
        ...(timeoutMs !== undefined && { timeoutMs }),
      };
      return outcome(await askUser(request, io), io);
    },
    ...(fallback !== undefined && {
      onTimeout: (io: StepIO) => {
        io.log('info', `No answer within ${step.timeout}s; using the default '${fallback}'.\n`);
        return answered(fallback, true);
      },
    }),
  };
}
