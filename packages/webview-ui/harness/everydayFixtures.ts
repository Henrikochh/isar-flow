/**
 * Package C ("Everyday use") samples: a release workflow with triggers, Copilot access, ask blocks and blocks that
 * read the editor and git, plus the memory files of the agent editor and the sidebar.
 */
import type {
  EditorContext,
  GitContext,
  MemoryFileState,
  RunRecordSummary,
  WorkflowSummary,
} from '@isar-flow/core';

const NOW = Date.UTC(2026, 9, 26, 9, 30);

export const RELEASE_WORKFLOW_URI = 'file:///c%3A/work/shop/.isarflow/workflows/release.workflow.yaml';
export const RELEASE_WORKFLOW_FILE = '.isarflow/workflows/release.workflow.yaml';
export const RELEASE_SIMULATION_PATH = '.isarflow/simulations/release.sim.yaml';

/** Runs on save of TypeScript sources (not generated ones) and every hour; Copilot may run it. */
export const RELEASE_WORKFLOW_TEXT = `version: 1
name: Release to an environment
description: Ask where to deploy, deploy, and summarize the selected code and the changes.
on:
  save:
    files:
      - src/**/*.ts
      - "!src/gen/**"
  schedule:
    every: 1h
expose: true
steps:
  - id: pick-env
    type: ask
    question: Which environment should I deploy to?
    choices:
      - dev
      - staging
      - prod
    default: dev
    timeout: 300
  - id: release-notes
    type: ask
    question: What should the release notes say?
    default: Routine release
    timeout: 150
  - id: deploy
    type: console
    run: npm run deploy -- --env \${{ steps.pick-env.answer }}
  - id: summarize
    type: agent
    agent: coder
    prompt: |
      Summarize this release for the team.
      Notes: \${{ steps.release-notes.answer }}
      Selected code: \${{ editor.selection }}
      Changes: \${{ git.diff }}
`;

/** The release workflow asking with seven long choices: the card offers a list instead of buttons. */
export const RELEASE_MANY_CHOICES_TEXT = RELEASE_WORKFLOW_TEXT.replace(
  '      - dev\n      - staging\n      - prod\n',
  [
    '      - dev',
    '      - staging',
    '      - prod',
    '      - qa',
    '      - preview for the checkout redesign (shared with the design team)',
    '      - canary in eu-central-1 with 5 % of the traffic',
    '      - load-test',
    '',
  ].join('\n'),
);

/**
 * Many patterns per trigger, a change trigger and no schedule: the Start marker and the settings have to wrap, and
 * the marker says what the last trigger did.
 */
export const RELEASE_LONG_TRIGGERS_TEXT = RELEASE_WORKFLOW_TEXT.replace(
  `on:
  save:
    files:
      - src/**/*.ts
      - "!src/gen/**"
  schedule:
    every: 1h
`,
  `on:
  save:
    files:
      - src/**/*.ts
      - src/**/*.tsx
      - packages/checkout/src/vouchers/**/*.ts
      - "!src/gen/**"
      - "!**/*.test.ts"
      - "!packages/checkout/src/vouchers/fixtures/very/deeply/nested/generated/**"
  change:
    files:
      - package-lock.json
      - .env.staging
`,
);

/** What the editor showed when the release runs started: a selected function in the checkout. */
export const EDITOR_CONTEXT: EditorContext = {
  selection: [
    'export function applyVoucher(cart: Cart, code: string): Cart {',
    '  const voucher = findVoucher(code);',
    '  if (!voucher || voucher.expiresAt < Date.now()) throw new VoucherError(code);',
    '  return { ...cart, total: cart.total - voucher.amount };',
    '}',
  ].join('\n'),
  file: 'src/checkout/vouchers.ts',
  language: 'typescript',
  line: 42,
};

export const GIT_CONTEXT: GitContext = {
  branch: 'feature/vouchers',
  changedFiles: ['src/checkout/vouchers.ts', 'src/checkout/vouchers.test.ts', 'CHANGELOG.md'],
  diff: [
    'diff --git a/src/checkout/vouchers.ts b/src/checkout/vouchers.ts',
    '@@ -40,6 +40,7 @@ export function applyVoucher(cart: Cart, code: string): Cart {',
    '   const voucher = findVoucher(code);',
    '-  if (!voucher) throw new VoucherError(code);',
    '+  if (!voucher || voucher.expiresAt < Date.now()) throw new VoucherError(code);',
  ].join('\n'),
};

/** Mocks of the release workflow: the first simulated ask answers staging, the second prod. */
export const RELEASE_SIMULATION_TEXT = `# Mocks for Simulate: results per block, used in order; the last one repeats.
version: 1
blocks:
  pick-env:
    - answer: staging
    - answer: prod
`;

const SHOP = 'file:///c%3A/work/shop';
const DOCS = 'file:///c%3A/work/shop-docs';

/** A memory file with a few dated notes, as agents with "Read and write" leave it. */
export const MEMORY_PREVIEW = [
  '# Project memory',
  '',
  '- 2026-10-24: Tests run with npm test; the e2e suite needs npm run e2e:setup first.',
  '- 2026-10-25: Vouchers live in src/checkout/vouchers.ts; never apply one twice.',
  '- 2026-10-25: Release notes go to CHANGELOG.md under "Unreleased".',
  '- 2026-10-26: Staging deploys need the VPN.',
  '- 2026-10-26: Keep the public API of src/cart.ts stable.',
].join('\n');

export const MEMORY_FILE: MemoryFileState = {
  uri: `${SHOP}/.isarflow/memory.md`,
  folderUri: SHOP,
  folderName: 'shop',
  path: '.isarflow/memory.md',
  exists: true,
  bytes: 1_284,
  overLimit: false,
  preview: MEMORY_PREVIEW,
};

export const MEMORY_MISSING: MemoryFileState = {
  uri: `${DOCS}/.isarflow/memory.md`,
  folderUri: DOCS,
  folderName: 'shop-docs',
  path: '.isarflow/memory.md',
  exists: false,
  bytes: 0,
  overLimit: false,
  preview: '',
};

export const MEMORY_OVER: MemoryFileState = { ...MEMORY_FILE, bytes: 11_930, overLimit: true };

/** The release workflow in the sidebar: triggers and Copilot access; its last run started on save. */
export const RELEASE_LAST_RUN: RunRecordSummary = {
  runId: 'run-12',
  workflowUri: RELEASE_WORKFLOW_URI,
  workflowName: 'Release to an environment',
  status: 'success',
  startedAt: NOW - 3 * 60_000,
  durationMs: 41_000,
  origin: { kind: 'trigger', trigger: 'save', file: 'src/app.ts' },
};

export const RELEASE_WORKFLOW: WorkflowSummary = {
  uri: RELEASE_WORKFLOW_URI,
  name: 'Release to an environment',
  description: 'Ask where to deploy, deploy, and summarize the selected code and the changes.',
  relativePath: '.isarflow/workflows/release.workflow.yaml',
  valid: true,
  stepCount: 4,
  lastRun: RELEASE_LAST_RUN,
  exposed: true,
  usesEditor: true,
  triggers: [
    { kind: 'save', label: 'On save: src/**/*.ts, !src/gen/**', files: ['src/**/*.ts', '!src/gen/**'] },
    { kind: 'schedule', label: 'Every hour', every: '1h', everyMs: 3_600_000 },
  ],
};

/** Runs started by a trigger, Copilot and a selection, newest first (sidebar recent runs and workflow history). */
export const ORIGIN_RUNS: RunRecordSummary[] = [
  RELEASE_LAST_RUN,
  {
    runId: 'run-11',
    workflowUri: RELEASE_WORKFLOW_URI,
    workflowName: 'Release to an environment',
    status: 'success',
    startedAt: NOW - 25 * 60_000,
    durationMs: 38_000,
    origin: { kind: 'copilot' },
  },
  {
    runId: 'run-10',
    workflowUri: RELEASE_WORKFLOW_URI,
    workflowName: 'Release to an environment',
    status: 'failure',
    startedAt: NOW - 70 * 60_000,
    durationMs: 12_000,
    error: 'Command exited with code 1',
    origin: { kind: 'selection' },
  },
];
