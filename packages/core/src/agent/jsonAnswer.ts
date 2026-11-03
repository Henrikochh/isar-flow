import type { OutputShape } from '../schema/types';
import { errorMessage } from './format';
import { describeOutputShape, extractJson, extractJsonMatching, isJsonSchema } from './json';

export function parseAnswer(
  text: string,
  shape: OutputShape | undefined,
): { value?: unknown; problems: string[] } {
  try {
    return shape ? extractJsonMatching(text, shape) : { value: extractJson(text), problems: [] };
  } catch (error) {
    return { problems: [errorMessage(error)] };
  }
}

function shapeText(shape: OutputShape): string {
  const intro = isJsonSchema(shape)
    ? 'It must match this JSON Schema:'
    : 'It must match this shape (keys marked with ? are optional):';
  return `${intro}\n${describeOutputShape(shape)}`;
}

export function jsonInstruction(shape: OutputShape | undefined): string {
  const base = 'Your final answer must be JSON only, with no explanations and no code fences.';
  return shape ? `${base} ${shapeText(shape)}` : base;
}

export function repairPrompt(problems: string[], shape: OutputShape | undefined): string {
  const lines = [
    'Your answer is not valid JSON for the expected shape:',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'Reply again with the corrected JSON only, with no explanations and no code fences.',
  ];
  if (shape) lines.push(shapeText(shape));
  return lines.join('\n');
}
