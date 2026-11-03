import { describe, expect, it } from 'vitest';
import type { ModelCatalog, ModelProbeResult, ProviderSummary } from '@isar-flow/core';
import type { ModelUse } from '../../../src/models/modelUsage';
import {
  endpointItems,
  fixCommand,
  modelItem,
  probeFix,
  untestedModelItem,
} from '../../../src/models/setupItems';

const provider = (overrides: Partial<ProviderSummary> & Pick<ProviderSummary, 'id'>): ProviderSummary => ({
  label: overrides.id,
  kind: 'openai-compatible',
  baseUrl: 'http://localhost:4000',
  hasApiKey: false,
  status: 'ok',
  modelCount: 12,
  ...overrides,
});

const vscodeProvider = (overrides: Partial<ProviderSummary> = {}) =>
  provider({ id: 'vscode', label: 'VS Code', kind: 'vscode', baseUrl: undefined, ...overrides });

const catalog = (...providers: ProviderSummary[]): ModelCatalog => ({
  models: [],
  providers,
  loading: false,
});

const result = (outcome: ModelProbeResult['outcome'], message: string, ref = 'litellm/gpt-4.1') => ({
  ref,
  outcome,
  message,
  toolCalls: outcome === 'tools',
  json: true,
  latencyMs: 812,
  testedAt: 1,
});

const use = (overrides: Partial<ModelUse> = {}): ModelUse => ({
  ref: 'litellm/gpt-4.1',
  usedBy: ['review.workflow.yaml', 'coder'],
  targets: [
    {
      name: 'Coder',
      usesTools: true,
      fix: { label: 'Open Coder', message: { type: 'openAgent', uri: 'file:///ws/coder.agent.yaml' } },
    },
  ],
  ...overrides,
});

describe('endpointItems', () => {
  it('reports reachable endpoints with their model count', () => {
    const items = endpointItems(
      catalog(
        vscodeProvider({ modelCount: 3 }),
        provider({ id: 'litellm', label: 'LiteLLM', modelCount: 1 }),
      ),
    );
    expect(items).toEqual([
      { id: 'endpoint:vscode', kind: 'endpoint', label: 'VS Code', status: 'ok', message: '3 models' },
      {
        id: 'endpoint:litellm',
        kind: 'endpoint',
        label: 'LiteLLM',
        status: 'ok',
        message: 'Reachable, 1 model',
      },
    ]);
  });

  it('skips VS Code models when they are turned off', () => {
    expect(endpointItems(catalog())).toEqual([
      {
        id: 'endpoint:vscode',
        kind: 'endpoint',
        label: 'VS Code',
        status: 'skipped',
        message: 'VS Code models are turned off.',
      },
    ]);
  });

  it('warns about endpoints without models', () => {
    const [vscode, litellm] = endpointItems(
      catalog(vscodeProvider({ modelCount: 0 }), provider({ id: 'litellm', modelCount: 0 })),
    );
    expect(vscode).toMatchObject({
      status: 'warning',
      message:
        'No models. Install and sign in to an extension that provides them, for example GitHub Copilot.',
      fix: { label: 'Open settings', message: { type: 'openSettings', query: 'isarFlow.vscodeModels' } },
    });
    expect(litellm).toMatchObject({
      status: 'warning',
      message: 'Reachable, but it lists no models. Add model ids under Extra models.',
      fix: { label: 'Edit endpoint', message: { type: 'editProvider', providerId: 'litellm' } },
    });
  });

  it('offers the fix that matches the error', () => {
    const items = endpointItems(
      catalog(
        vscodeProvider({ status: 'error', error: 'LM service unavailable', modelCount: 0 }),
        provider({ id: 'key', status: 'error', errorKind: 'auth', hasApiKey: true }),
        provider({ id: 'nokey', status: 'error', errorKind: 'auth' }),
        provider({ id: 'down', status: 'error', errorKind: 'network' }),
        provider({ id: 'path', status: 'error', errorKind: 'not-found' }),
        provider({ id: 'odd', status: 'error', errorKind: 'other', error: 'Unexpected model list.' }),
        provider({ id: 'bare', status: 'error' }),
        provider({ id: 'slow', status: 'loading' }),
      ),
    );
    expect(items.map((i) => [i.status, i.message, i.fix?.label, i.fix?.message])).toEqual([
      ['error', 'Listing the models failed: LM service unavailable', undefined, undefined],
      ['error', 'The API key was rejected.', 'Set API key', { type: 'setProviderKey', providerId: 'key' }],
      ['error', 'It needs an API key.', 'Set API key', { type: 'setProviderKey', providerId: 'nokey' }],
      [
        'error',
        "Can't reach it. Check that it is running and the base URL is right.",
        'Edit endpoint',
        { type: 'editProvider', providerId: 'down' },
      ],
      [
        'error',
        'Nothing was found at the base URL. OpenAI-compatible APIs usually end with /v1.',
        'Edit endpoint',
        { type: 'editProvider', providerId: 'path' },
      ],
      ['error', 'Unexpected model list.', 'Edit endpoint', { type: 'editProvider', providerId: 'odd' }],
      ['error', 'Listing the models failed.', 'Edit endpoint', { type: 'editProvider', providerId: 'bare' }],
      [
        'error',
        "It didn't answer in time. Check that it is running and the base URL is right.",
        'Edit endpoint',
        { type: 'editProvider', providerId: 'slow' },
      ],
    ]);
  });
});

describe('modelItem', () => {
  const ok = catalog(provider({ id: 'litellm' }));

  it('reports working tool calls with the latency', () => {
    expect(modelItem(use(), result('tools', 'Tool calls work'), ok)).toEqual({
      id: 'model:litellm/gpt-4.1',
      kind: 'model',
      label: 'litellm/gpt-4.1',
      status: 'ok',
      message: 'Tool calls work (0.8 s)',
      usedBy: ['review.workflow.yaml', 'coder'],
    });
  });

  it('asks for text tool mode in the agents that use tools', () => {
    const item = modelItem(
      use({
        targets: [
          {
            name: 'Writer',
            usesTools: false,
            fix: { label: 'Open Writer', message: { type: 'addProvider' } },
          },
          {
            name: 'Reviewer',
            toolMode: 'text',
            usesTools: true,
            fix: { label: 'x', message: { type: 'addProvider' } },
          },
          ...use().targets,
          { name: 'Fixer', usesTools: true, fix: { label: 'Open Fixer', message: { type: 'addProvider' } } },
        ],
      }),
      result('text', 'Needs text tool mode'),
      ok,
    );
    expect(item).toMatchObject({
      status: 'warning',
      message: 'Needs text tool mode. In Coder and Fixer, set Tool calls to Text in the prompt.',
      fix: use().targets[0].fix,
    });
  });

  it('is fine when every agent already uses text tool mode', () => {
    const textMode = use({ targets: [{ ...use().targets[0], toolMode: 'text' }] });
    expect(modelItem(textMode, result('text', 'Needs text tool mode'), ok)).toMatchObject({
      status: 'ok',
      message: 'Works in text tool mode',
    });
    expect(modelItem(use({ targets: [] }), result('text', 'Needs text tool mode'), ok).status).toBe('ok');
  });

  it('reports failures with the matching fix', () => {
    const failed = modelItem(
      use(),
      result('failed', 'The API key was rejected. Set a new API key for LiteLLM.'),
      ok,
    );
    expect(failed).toMatchObject({
      status: 'error',
      message: 'The API key was rejected. Set a new API key for LiteLLM.',
      fix: { label: 'Set API key', message: { type: 'setProviderKey', providerId: 'litellm' } },
    });
  });
});

describe('probeFix', () => {
  const ok = catalog(provider({ id: 'litellm' }), vscodeProvider());
  const fixOf = (message: string, ref = 'litellm/gpt-4.1', where = ok) =>
    probeFix(ref, result('failed', message, ref), where)?.message;

  it('matches the failure', () => {
    expect(fixOf('The API key was rejected. Set a new API key for LiteLLM.')).toEqual({
      type: 'setProviderKey',
      providerId: 'litellm',
    });
    for (const message of [
      "Can't reach LiteLLM. Check that it is running and the base URL is right.",
      "The endpoint doesn't know this model. Check the model id or refresh models.",
      'The endpoint rejected the test request: nope.',
      "The model didn't answer within 60 s.",
    ]) {
      expect(fixOf(message)).toEqual({ type: 'editProvider', providerId: 'litellm' });
    }
    expect(fixOf('The endpoint is rate limiting requests. Try again in a minute.')).toBeUndefined();
    expect(fixOf("Isar Flow may not use the VS Code model 'x' yet.", 'vscode/copilot/x')).toBeUndefined();
  });

  it('offers to add a missing endpoint or turn on VS Code models', () => {
    expect(fixOf('Unknown model provider', 'gone/m')).toEqual({ type: 'addProvider' });
    expect(fixOf('turned off', 'vscode/copilot/x', catalog())).toEqual({
      type: 'openSettings',
      query: 'isarFlow.vscodeModels',
    });
    expect(fixOf('Invalid', 'nonsense')).toBeUndefined();
  });
});

describe('untestedModelItem', () => {
  const where = catalog(
    provider({ id: 'litellm' }),
    provider({ id: 'down', label: 'Down', status: 'error', errorKind: 'network' }),
    vscodeProvider(),
  );

  it('tests models of working endpoints', () => {
    expect(untestedModelItem(use(), where)).toBeUndefined();
    expect(untestedModelItem(use({ ref: 'vscode/copilot/gpt-4.1' }), where)).toBeUndefined();
  });

  it('explains models that cannot be tested', () => {
    expect(untestedModelItem(use({ ref: 'gpt-4.1' }), where)).toMatchObject({
      status: 'error',
      message: 'This is not a model reference. Use "<provider>/<model>", for example "litellm/gpt-4.1".',
    });
    expect(untestedModelItem(use({ ref: 'ollama/llama3' }), where)).toMatchObject({
      status: 'error',
      message: "There is no model endpoint 'ollama'. Add it, or pick another model.",
      fix: { label: 'Add endpoint', message: { type: 'addProvider' } },
    });
    expect(
      untestedModelItem(use({ ref: 'vscode/copilot/x' }), catalog(provider({ id: 'litellm' }))),
    ).toMatchObject({
      status: 'error',
      message: 'VS Code models are turned off.',
      fix: { label: 'Open settings', message: { type: 'openSettings', query: 'isarFlow.vscodeModels' } },
    });
    expect(untestedModelItem(use({ ref: 'down/m' }), where)).toMatchObject({
      id: 'model:down/m',
      status: 'error',
      message: 'Not tested because Down has a problem. Fix the endpoint first.',
      usedBy: ['review.workflow.yaml', 'coder'],
      fix: { label: 'Edit endpoint', message: { type: 'editProvider', providerId: 'down' } },
    });
  });
});

describe('fixCommand', () => {
  it('turns setup fixes into commands', () => {
    expect(fixCommand({ type: 'setProviderKey', providerId: 'a' })).toEqual(['isarFlow.setProviderKey', 'a']);
    expect(fixCommand({ type: 'editProvider', providerId: 'a' })).toEqual(['isarFlow.editProvider', 'a']);
    expect(fixCommand({ type: 'addProvider' })).toEqual(['isarFlow.addProvider']);
    expect(fixCommand({ type: 'openSettings', query: 'isarFlow.x' })).toEqual([
      'workbench.action.openSettings',
      'isarFlow.x',
    ]);
    expect(fixCommand({ type: 'refreshModels' })).toBeUndefined();
  });
});
