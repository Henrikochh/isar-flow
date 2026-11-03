import { stringify } from 'yaml';
import type { WorkflowTemplateId } from '../protocol';

export type DefaultAgentKind = 'coder' | 'reviewer';

export const DEFAULT_AGENT_MODEL = 'vscode/copilot/gpt-4.1';

/** A single-line YAML scalar for user text, quoted only when YAML needs it. */
function scalar(value: string): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

function displayName(name: string, fallback: string): string {
  const clean = name.replace(/\s+/g, ' ').trim();
  return clean === '' ? fallback : clean;
}

const lines = (...text: string[]) => `${text.join('\n')}\n`;

export function newWorkflowText(name: string): string {
  return lines(
    '# Isar Flow workflow. Add blocks on the canvas or edit this YAML; both stay in sync.',
    'version: 1',
    `name: ${scalar(displayName(name, 'New workflow'))}`,
    'steps: []',
  );
}

function reviewLoopTemplate(name: string): string {
  return lines(
    '# Implements a task, then tests and reviews it until the tests pass and the reviewer approves.',
    '# Needs the agents "coder" and "reviewer" in .isarflow/agents/. Replace "npm test" with your test command.',
    'version: 1',
    `name: ${scalar(name)}`,
    'description: Implement a task, then test and review it until approved (at most 5 rounds).',
    'inputs:',
    '  task: { type: string, description: What should be implemented?, required: true, multiline: true }',
    'steps:',
    '  - id: implement',
    '    type: agent',
    '    agent: coder',
    '    prompt: |',
    '      Implement the following task in this repository:',
    '      ${{ inputs.task }}',
    '',
    '  - id: review_loop',
    '    type: loop',
    '    until:',
    '      all:',
    '        - { value: "${{ steps.tests.exitCode }}", op: eq, to: 0 }',
    '        - { value: "${{ steps.review.json.approved }}", op: isTrue }',
    '    maxIterations: 5 # the run fails if this is not enough',
    '    steps:',
    '      - id: tests',
    '        type: console',
    '        run: npm test',
    '        continueOnError: true',
    '      - id: review',
    '        type: agent',
    '        agent: reviewer',
    '        prompt: |',
    '          Review the changes made for this task:',
    '          ${{ inputs.task }}',
    '',
    '          The tests exited with code ${{ steps.tests.exitCode }}. Last lines of their output:',
    '          ${{ tail(steps.tests.output, 80) }}',
    '        output:',
    '          format: json',
    '          schema: { approved: boolean, issues: "string[]" }',
    '      - id: needs_fix',
    '        type: if',
    '        condition: "${{ !steps.review.json.approved || steps.tests.exitCode != 0 }}"',
    '        then:',
    '          - id: fix',
    '            type: agent',
    '            agent: coder',
    '            prompt: |',
    '              Fix the problems found in this round.',
    '              Reviewer issues: ${{ toJSON(steps.review.json.issues) }}',
    '              Test exit code: ${{ steps.tests.exitCode }}. Last lines of the test output:',
    '              ${{ tail(steps.tests.output, 80) }}',
  );
}

function testFixTemplate(name: string): string {
  return lines(
    '# Runs the tests and lets the coder fix failures until they pass (at most 5 rounds).',
    '# Needs the agent "coder" in .isarflow/agents/. Replace "npm test" with your test command.',
    'version: 1',
    `name: ${scalar(name)}`,
    'description: Run the tests and fix failures until they pass.',
    'steps:',
    '  - id: fix_loop',
    '    type: loop',
    '    until: { value: "${{ steps.tests.exitCode }}", op: eq, to: 0 }',
    '    maxIterations: 5',
    '    steps:',
    '      - id: tests',
    '        type: console',
    '        run: npm test',
    '        continueOnError: true',
    '      - id: failing',
    '        type: if',
    '        condition: { value: "${{ steps.tests.exitCode }}", op: neq, to: 0 }',
    '        then:',
    '          - id: fix',
    '            type: agent',
    '            agent: coder',
    '            prompt: |',
    '              The tests fail with exit code ${{ steps.tests.exitCode }}. Find the cause and fix it.',
    '              Change a test only if the test itself is wrong.',
    '              Last lines of the test output:',
    '              ${{ tail(steps.tests.output, 80) }}',
  );
}

export function workflowTemplate(templateId: WorkflowTemplateId, name: string): string {
  const title = displayName(name, 'New workflow');
  switch (templateId) {
    case 'review-loop':
      return reviewLoopTemplate(title);
    case 'test-fix':
      return testFixTemplate(title);
    default:
      return newWorkflowText(title);
  }
}

export function newAgentText(name: string, model: string = DEFAULT_AGENT_MODEL): string {
  return lines(
    '# Isar Flow agent. Workflows use it as "agent: <file name without .agent.yaml>".',
    `name: ${scalar(displayName(name, 'New agent'))}`,
    `model: ${scalar(model)}`,
    'systemPrompt: |',
    '  You are a careful software engineer working in this repository.',
    '  Read the relevant files before you answer. Keep answers short and concrete.',
    '# Read-only: it can look at files but not change them. Add editFile, applyPatch or writeFile to let it change code.',
    'tools: [readFile, listFiles, searchText, gitDiff]',
    'permissions: { edits: ask, commands: ask } # none | ask | auto',
  );
}

export function defaultAgentText(kind: DefaultAgentKind, model: string): string {
  if (kind === 'coder') {
    return lines(
      '# Coder: implements tasks and fixes problems. Edits files directly and asks before running commands.',
      'name: Coder',
      'description: Implements tasks and fixes failing tests',
      `model: ${scalar(model)}`,
      'systemPrompt: |',
      '  You are a pragmatic senior software engineer working in this repository.',
      '  - Explore first: read the relevant files and search for related code before you change anything.',
      '  - Make focused, minimal changes with editFile; create new files with writeFile.',
      '  - Use applyPatch for changes in several places or files.',
      '  - Follow the existing code style and keep the project building.',
      '  - Use runCommand to run the tests or the build when it helps you verify your work.',
      '  - Finish with a short summary of what you changed and why.',
      'temperature: 0.2',
      'maxTurns: 40',
      'tools: [readFile, listFiles, searchText, gitDiff, editFile, applyPatch, writeFile, runCommand]',
      'permissions: { edits: auto, commands: ask } # none | ask | auto',
    );
  }
  return lines(
    '# Reviewer: read-only code reviewer that answers in JSON, made for review loops.',
    'name: Reviewer',
    'description: Strict senior code reviewer',
    `model: ${scalar(model)}`,
    'systemPrompt: |',
    '  You are a strict senior code reviewer. Review the current changes in this repository:',
    '  use gitDiff to see them and readFile or searchText for context.',
    '  Check correctness, tests, error handling, security, naming and readability.',
    '  Approve only when nothing important is left to fix.',
    '  Answer with JSON only (no prose, no code fences), exactly in this shape:',
    '  {"approved": true, "issues": ["path:line - what is wrong and how to fix it"]}',
    '  When changes are needed, use "approved": false and list every blocking issue.',
    'temperature: 0.1',
    'tools: [readFile, listFiles, searchText, gitDiff]',
    'permissions: { edits: none, commands: none }',
  );
}
