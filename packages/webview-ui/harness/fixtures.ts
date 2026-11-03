/** Realistic sample data for the harness, component tests and screenshots. */
import type {
  AgentSummary,
  ChatModelInfo,
  ModelCatalog,
  ModelProbeResult,
  RunRecordSummary,
  SetupReport,
  WorkflowSummary,
} from '@isar-flow/core';

export * from './reviews';

const NOW = Date.UTC(2026, 9, 26, 9, 30);
export const FIXTURE_NOW = NOW;

function model(provider: string, providerLabel: string, id: string, name = id): ChatModelInfo {
  return {
    ref: `${provider}/${id}`,
    provider,
    providerLabel,
    id,
    name,
    capabilities: { tools: true, jsonSchema: provider !== 'vscode' },
  };
}

export const MODELS: ChatModelInfo[] = [
  model('vscode', 'VS Code', 'copilot/gpt-4.1', 'GPT-4.1'),
  model('vscode', 'VS Code', 'copilot/claude-sonnet-4.5', 'Claude Sonnet 4.5'),
  model('vscode', 'VS Code', 'copilot/gemini-2.5-pro', 'Gemini 2.5 Pro'),
  model('vscode', 'VS Code', 'copilot/gpt-5-mini', 'GPT-5 mini'),
  model('litellm', 'LiteLLM (localhost:4000)', 'claude-sonnet'),
  model('litellm', 'LiteLLM (localhost:4000)', 'claude-haiku'),
  model('litellm', 'LiteLLM (localhost:4000)', 'gpt-4.1'),
  model('litellm', 'LiteLLM (localhost:4000)', 'llama-3.3-70b'),
  model('litellm', 'LiteLLM (localhost:4000)', 'qwen-coder-32b'),
];

/** "Test model" results: native tool calls, text tool mode and a failure. */
export const PROBES: Record<string, ModelProbeResult> = {
  'litellm/claude-sonnet': {
    ref: 'litellm/claude-sonnet',
    outcome: 'tools',
    message: 'Tool calls work',
    toolCalls: true,
    json: true,
    latencyMs: 820,
    testedAt: NOW - 2 * 3_600_000,
  },
  'litellm/llama-3.3-70b': {
    ref: 'litellm/llama-3.3-70b',
    outcome: 'text',
    message: 'Needs text tool mode',
    toolCalls: false,
    json: true,
    latencyMs: 2_350,
    testedAt: NOW - 2 * 3_600_000,
  },
  'litellm/gpt-4.1': {
    ref: 'litellm/gpt-4.1',
    outcome: 'failed',
    message: 'The API key was rejected. Set a new API key for LiteLLM.',
    toolCalls: false,
    json: false,
    testedAt: NOW - 3_600_000,
  },
};

export const CATALOG: ModelCatalog = {
  loading: false,
  models: MODELS,
  probes: PROBES,
  // Prices of the coder's and the reviewer's models; the docs writer's model has none.
  prices: {
    'litellm/claude-sonnet': { input: 3, output: 15 },
    'vscode/copilot/gpt-4.1': { input: 2.5, output: 10 },
  },
  providers: [
    { id: 'vscode', label: 'VS Code', kind: 'vscode', hasApiKey: false, status: 'ok', modelCount: 4 },
    {
      id: 'litellm',
      label: 'LiteLLM (localhost:4000)',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:4000',
      hasApiKey: true,
      status: 'ok',
      modelCount: 5,
    },
    {
      id: 'ollama',
      label: 'Ollama',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      hasApiKey: false,
      status: 'error',
      error: 'Cannot reach http://localhost:11434/v1. Is the server running?',
      modelCount: 0,
    },
  ],
};

export const AGENTS: AgentSummary[] = [
  {
    id: 'coder',
    name: 'Coder',
    description: 'Implements changes and fixes review findings',
    model: 'litellm/claude-sonnet',
    tools: [
      'readFile',
      'listFiles',
      'searchText',
      'gitDiff',
      'editFile',
      'applyPatch',
      'writeFile',
      'runCommand',
    ],
    permissions: { edits: 'auto', commands: 'ask' },
    scope: 'workspace',
    uri: 'file:///c%3A/work/shop/.isarflow/agents/coder.agent.yaml',
    valid: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Strict senior code reviewer',
    model: 'vscode/copilot/gpt-4.1',
    tools: ['readFile', 'listFiles', 'searchText', 'gitDiff'],
    permissions: { edits: 'none', commands: 'none' },
    scope: 'workspace',
    uri: 'file:///c%3A/work/shop/.isarflow/agents/reviewer.agent.yaml',
    valid: true,
  },
  {
    id: 'docs-writer',
    name: 'Docs writer',
    description: 'Keeps the README and changelog current',
    model: 'litellm/llama-3.3-70b',
    tools: ['readFile', 'writeFile'],
    permissions: { edits: 'ask' },
    scope: 'user',
    uri: 'file:///c%3A/Users/me/AppData/Roaming/Code/User/globalStorage/isarflow.isar-flow/agents/docs-writer.agent.yaml',
    valid: true,
  },
];

export const RECENT_RUNS: RunRecordSummary[] = [
  {
    runId: 'run-7',
    workflowUri: 'file:///c%3A/work/shop/.isarflow/workflows/review-loop.workflow.yaml',
    workflowName: 'Review until approved',
    status: 'success',
    startedAt: NOW - 4 * 60_000,
    durationMs: 252_000,
    usage: { inputTokens: 48_210, outputTokens: 6_930 },
    review: { total: 4, kept: 2, reverted: 0, pending: 2 },
  },
  {
    runId: 'run-6',
    workflowUri: 'file:///c%3A/work/shop/.isarflow/workflows/test-fix.workflow.yaml',
    workflowName: 'Fix failing tests',
    status: 'failure',
    startedAt: NOW - 3 * 3_600_000,
    durationMs: 611_000,
    error: "Loop 'fix_loop' reached its limit of 5 iterations without meeting its condition",
  },
  {
    runId: 'run-5',
    workflowUri: 'file:///c%3A/work/shop/.isarflow/workflows/review-loop.workflow.yaml',
    workflowName: 'Review until approved',
    status: 'cancelled',
    startedAt: NOW - 26 * 3_600_000,
    durationMs: 48_000,
  },
];

const LITELLM_DOCS_WRITER = AGENTS[2].uri;

/** A finished "Check setup": two endpoints work, Ollama is down, one model needs text mode, one key was rejected. */
export const SETUP_REPORT: SetupReport = {
  startedAt: NOW - 40_000,
  finishedAt: NOW - 31_000,
  items: [
    { id: 'endpoint:vscode', kind: 'endpoint', label: 'VS Code', status: 'ok', message: '4 models' },
    {
      id: 'endpoint:litellm',
      kind: 'endpoint',
      label: 'LiteLLM (localhost:4000)',
      status: 'ok',
      message: 'Reachable, 5 models',
    },
    {
      id: 'endpoint:ollama',
      kind: 'endpoint',
      label: 'Ollama',
      status: 'error',
      message: "Can't reach Ollama. Check that it is running and the base URL is right.",
      fix: { label: 'Edit endpoint', message: { type: 'editProvider', providerId: 'ollama' } },
    },
    {
      id: 'model:litellm/claude-sonnet',
      kind: 'model',
      label: 'litellm/claude-sonnet',
      status: 'ok',
      message: 'Tool calls work',
      usedBy: ['coder', '.isarflow/workflows/review-loop.workflow.yaml'],
    },
    {
      id: 'model:litellm/llama-3.3-70b',
      kind: 'model',
      label: 'litellm/llama-3.3-70b',
      status: 'warning',
      message: 'Needs text tool mode. In docs-writer, set Tool calls to Text in the prompt.',
      usedBy: ['docs-writer', 'tools/release-notes.workflow.yaml'],
      fix: { label: 'Open agent', message: { type: 'openAgent', uri: LITELLM_DOCS_WRITER } },
    },
    {
      id: 'model:litellm/gpt-4.1',
      kind: 'model',
      label: 'litellm/gpt-4.1',
      status: 'error',
      message: 'The API key was rejected. Set a new API key for LiteLLM.',
      usedBy: ['.isarflow/workflows/test-fix.workflow.yaml'],
      fix: { label: 'Set API key', message: { type: 'setProviderKey', providerId: 'litellm' } },
    },
  ],
};

/** The same check while it runs: endpoints are done, the first model passed, the second is being tested. */
export const SETUP_REPORT_RUNNING: SetupReport = {
  startedAt: NOW - 6_000,
  items: [
    ...SETUP_REPORT.items.slice(0, 4),
    {
      id: 'model:litellm/llama-3.3-70b',
      kind: 'model',
      label: 'litellm/llama-3.3-70b',
      status: 'running',
      message: 'Testing the model…',
      usedBy: ['docs-writer', 'tools/release-notes.workflow.yaml'],
    },
  ],
};

export const WORKFLOWS: WorkflowSummary[] = [
  {
    uri: 'file:///c%3A/work/shop/.isarflow/workflows/review-loop.workflow.yaml',
    name: 'Review until approved',
    description: 'Implement a task, then test and review until the reviewer approves.',
    relativePath: '.isarflow/workflows/review-loop.workflow.yaml',
    valid: true,
    stepCount: 6,
    lastRun: RECENT_RUNS[0],
  },
  {
    uri: 'file:///c%3A/work/shop/.isarflow/workflows/test-fix.workflow.yaml',
    name: 'Fix failing tests',
    relativePath: '.isarflow/workflows/test-fix.workflow.yaml',
    valid: true,
    stepCount: 4,
    lastRun: RECENT_RUNS[1],
  },
  {
    uri: 'file:///c%3A/work/shop/tools/release-notes.workflow.yaml',
    name: 'Draft release notes',
    relativePath: 'tools/release-notes.workflow.yaml',
    valid: false,
    stepCount: 2,
  },
];

export const REVIEWER_AGENT_TEXT = `# Reviews changes and answers with JSON so workflows can branch on it.
name: Reviewer
description: Strict senior code reviewer
model: vscode/copilot/gpt-4.1
fallbackModels:
  - litellm/claude-sonnet
systemPrompt: |
  You are a strict senior reviewer. Check correctness, tests, naming and edge cases.
  Answer with JSON: { "approved": boolean, "issues": string[] }.
  Only approve when there is nothing left to fix.
temperature: 0.2
maxTokens: 4000
maxTurns: 20
tools: [readFile, listFiles, searchText, gitDiff]
permissions:
  edits: none
  commands: none
`;

/** Workflow editor scenario 'allblocks': every block type, nested containers and a Break inside an If. */
export const ALL_BLOCKS_WORKFLOW_TEXT = `version: 1
name: Release checklist
description: Build, lint until clean, ask before publishing.
inputs:
  version: { type: string, description: Version to publish, required: true }
  dryRun: { type: boolean, default: true }
steps:
  - id: build
    name: Build the package
    type: console
    shell: pwsh
    run: |
      npm ci
      npm run build -- --mode production
  - id: notes
    name: Draft release notes
    type: agent
    agent: docs-writer
    prompt: Summarise the changes since the last tag for version \${{ inputs.version }}.
  - id: polish
    type: loop
    while: { value: "\${{ steps.check.exitCode }}", op: neq, to: 0 }
    maxIterations: 3
    onMaxIterations: continue
    steps:
      - id: check
        type: console
        run: npm run lint
        continueOnError: true
      - id: lint_clean
        type: if
        condition: { value: "\${{ steps.check.exitCode }}", op: eq, to: 0 }
        then:
          - id: done
            type: break
        else:
          - id: autofix
            type: agent
            agent: coder
            prompt: Fix these lint errors without changing behaviour. \${{ tail(steps.check.output, 40) }}
  - id: confirm
    type: approval
    message: Publish \${{ inputs.version }} to npm?
  - id: dry
    type: if
    condition: "\${{ inputs.dryRun }}"
    then:
      - id: stop_dry
        type: stop
        outcome: success
        message: Dry run finished. Nothing was published.
  - id: publish
    type: console
    run: npm publish --access public
`;

/** Workflow with very long names, ids, commands and conditions, to check ellipsis and wrapping on the canvas. */
export const LONG_TEXT_WORKFLOW_TEXT = `version: 1
name: Nightly dependency upgrade with the full regression suite and a staged rollout to every environment
inputs:
  packageManifestPath: { type: string, default: services/checkout-api/package.json }
  maximumAllowedRegressionPercentage: { type: number, default: 2 }
  notifyChannelForReleaseManagers: { type: string, default: releases }
steps:
  - id: upgrade_all_dependencies_to_latest_minor_versions_and_regenerate_the_lockfile
    type: console
    shell: bash
    continueOnError: true
    run: npx --yes npm-check-updates --target minor --upgrade --packageFile \${{ inputs.packageManifestPath }} && npm install --no-audit --no-fund --loglevel=error
  - id: assess
    name: Assess the upgrade risk for every changed package and summarise all breaking changes for the release notes
    type: agent
    agent: docs-writer
    model: vscode/copilot/claude-sonnet-4.5
    output: { format: json }
    prompt: Read the changelogs of every package that changed in \${{ inputs.packageManifestPath }} and list breaking changes, deprecations and anything that needs a migration, with links. Keep it short.
  - id: regression_until_green_or_out_of_attempts_for_the_whole_checkout_service
    type: loop
    until:
      all:
        - { value: "\${{ steps.regression_suite_with_coverage_and_mutation_testing.exitCode }}", op: eq, to: 0 }
        - { value: "\${{ steps.assess.json.riskLevelForTheProductionRollout }}", op: neq, to: high }
    maxIterations: 10
    steps:
      - id: regression_suite_with_coverage_and_mutation_testing
        type: console
        continueOnError: true
        run: npm run test:regression -- --coverage --reporter=junit --outputFile=reports/regression-\${{ loop.iteration }}.xml
      - id: regression_failed_or_coverage_dropped_below_the_agreed_threshold
        type: if
        condition: "\${{ steps.regression_suite_with_coverage_and_mutation_testing.exitCode != 0 || steps.assess.json.coverageDelta < -inputs.maximumAllowedRegressionPercentage }}"
        then:
          - id: give_up_and_notify_the_release_managers_in_the_channel
            type: stop
            message: The regression suite still fails after the automatic fixes, so the upgrade was rolled back and the release managers were notified in the channel.
        else:
          - id: ask_before_rolling_out_to_production_environments
            type: approval
            message: All regression tests pass and coverage is within the agreed threshold. Roll the upgrade out to staging and then to every production region now?
`;

/** Containers inside containers: loops in loops and in If lanes, an If in an If, and an empty loop. */
export const NESTED_WORKFLOW_TEXT = `version: 1
name: Ship a release candidate
inputs:
  channel: { type: string, default: beta }
steps:
  - id: attempts
    name: Up to three attempts
    type: loop
    maxIterations: 3
    steps:
      - id: flaky
        name: Retry flaky suites
        type: loop
        until: { value: "\${{ steps.suite.exitCode }}", op: eq, to: 0 }
        maxIterations: 4
        steps:
          - id: suite
            type: console
            continueOnError: true
            run: npm run test:e2e
      - id: green
        type: if
        condition: { value: "\${{ steps.suite.exitCode }}", op: eq, to: 0 }
        then:
          - id: done
            type: break
        else:
          - id: heal
            type: agent
            agent: coder
            prompt: Fix the failing end-to-end tests. \${{ tail(steps.suite.output, 60) }}
  - id: route
    type: if
    condition: { value: "\${{ inputs.channel }}", op: eq, to: beta }
    then:
      - id: soak
        type: loop
        maxIterations: 2
        steps: []
    else:
      - id: risky
        type: if
        condition: "\${{ steps.heal.status == 'success' }}"
        then:
          - id: sign_off
            type: approval
            message: The agent changed code to get the suite green. Ship anyway?
        else:
          - id: ship
            type: console
            run: npm publish
`;
