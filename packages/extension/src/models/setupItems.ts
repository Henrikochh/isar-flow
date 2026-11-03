import {
  type ModelCatalog,
  type ModelProbeResult,
  parseModelRef,
  probeFailureKind,
  type ProviderSummary,
  type SetupCheckItem,
  type SetupFix,
  type SidebarToHost,
} from '@isar-flow/core';
import type { ModelUse } from './modelUsage';
import { VSCODE_PROVIDER_ID } from './settings';

const VSCODE_SETTINGS: SetupFix = {
  label: 'Open settings',
  message: { type: 'openSettings', query: 'isarFlow.vscodeModels' },
};
const ADD_ENDPOINT: SetupFix = { label: 'Add endpoint', message: { type: 'addProvider' } };
const editEndpoint = (providerId: string): SetupFix => ({
  label: 'Edit endpoint',
  message: { type: 'editProvider', providerId },
});
const setApiKey = (providerId: string): SetupFix => ({
  label: 'Set API key',
  message: { type: 'setProviderKey', providerId },
});

const models = (n: number) => `${n} model${n === 1 ? '' : 's'}`;

/** One item per model endpoint: reachable, API key, models. */
export function endpointItems(catalog: ModelCatalog): SetupCheckItem[] {
  const items = catalog.providers.map(endpointItem);
  if (!catalog.providers.some((p) => p.id === VSCODE_PROVIDER_ID)) {
    items.unshift({
      id: `endpoint:${VSCODE_PROVIDER_ID}`,
      kind: 'endpoint',
      label: 'VS Code',
      status: 'skipped',
      message: 'VS Code models are turned off.',
    });
  }
  return items;
}

function endpointItem(provider: ProviderSummary): SetupCheckItem {
  const item = (status: SetupCheckItem['status'], message: string, fix?: SetupFix): SetupCheckItem => ({
    id: `endpoint:${provider.id}`,
    kind: 'endpoint',
    label: provider.label,
    status,
    message,
    ...(fix ? { fix } : {}),
  });
  return provider.kind === 'vscode' ? vscodeItem(provider, item) : compatItem(provider, item);
}

type MakeItem = (status: SetupCheckItem['status'], message: string, fix?: SetupFix) => SetupCheckItem;

function vscodeItem(provider: ProviderSummary, item: MakeItem): SetupCheckItem {
  switch (provider.status) {
    case 'error':
      return item('error', `Listing the models failed: ${provider.error ?? 'unknown error'}`);
    case 'ok':
      return provider.modelCount > 0
        ? item('ok', models(provider.modelCount))
        : item(
            'warning',
            'No models. Install and sign in to an extension that provides them, for example GitHub Copilot.',
            VSCODE_SETTINGS,
          );
    default:
      return item('warning', 'VS Code is still loading its models. Run the check again in a moment.');
  }
}

function compatItem(provider: ProviderSummary, item: MakeItem): SetupCheckItem {
  const edit = editEndpoint(provider.id);
  switch (provider.status) {
    case 'ok':
      return provider.modelCount > 0
        ? item('ok', `Reachable, ${models(provider.modelCount)}`)
        : item('warning', 'Reachable, but it lists no models. Add model ids under Extra models.', edit);
    case 'error':
      switch (provider.errorKind) {
        case 'auth':
          return item(
            'error',
            provider.hasApiKey ? 'The API key was rejected.' : 'It needs an API key.',
            setApiKey(provider.id),
          );
        case 'network':
          return item('error', "Can't reach it. Check that it is running and the base URL is right.", edit);
        case 'not-found':
          return item(
            'error',
            'Nothing was found at the base URL. OpenAI-compatible APIs usually end with /v1.',
            edit,
          );
        default:
          return item('error', provider.error ?? 'Listing the models failed.', edit);
      }
    case 'loading':
      return item(
        'error',
        "It didn't answer in time. Check that it is running and the base URL is right.",
        edit,
      );
    default:
      return item('skipped', 'Not checked.');
  }
}

function providerIdOf(ref: string): string | undefined {
  try {
    return parseModelRef(ref).provider;
  } catch {
    return undefined;
  }
}

/** The fix for a failed "Test model" result. */
export function probeFix(ref: string, result: ModelProbeResult, catalog: ModelCatalog): SetupFix | undefined {
  const providerId = providerIdOf(ref);
  if (providerId === undefined) return undefined;
  const known = catalog.providers.some((p) => p.id === providerId);
  if (providerId === VSCODE_PROVIDER_ID) return known ? undefined : VSCODE_SETTINGS;
  if (!known) return ADD_ENDPOINT;
  switch (probeFailureKind(result.message)) {
    case 'auth':
      return setApiKey(providerId);
    case 'network':
    case 'not-found':
    case 'bad-request':
    case 'timeout':
      return editEndpoint(providerId);
    default:
      return undefined;
  }
}

/** The item of a model that cannot be tested (bad reference, missing or broken endpoint); else undefined. */
export function untestedModelItem(use: ModelUse, catalog: ModelCatalog): SetupCheckItem | undefined {
  const item = (message: string, fix?: SetupFix): SetupCheckItem => ({
    ...modelBase(use),
    status: 'error',
    message,
    ...(fix ? { fix } : {}),
  });
  const providerId = providerIdOf(use.ref);
  if (providerId === undefined) {
    return item('This is not a model reference. Use "<provider>/<model>", for example "litellm/gpt-4.1".');
  }
  const provider = catalog.providers.find((p) => p.id === providerId);
  if (!provider) {
    return providerId === VSCODE_PROVIDER_ID
      ? item('VS Code models are turned off.', VSCODE_SETTINGS)
      : item(`There is no model endpoint '${providerId}'. Add it, or pick another model.`, ADD_ENDPOINT);
  }
  if (provider.kind === 'vscode' || provider.status === 'ok') return undefined;
  return item(
    `Not tested because ${provider.label} has a problem. Fix the endpoint first.`,
    endpointItem(provider).fix,
  );
}

/** The item of a tested model. */
export function modelItem(use: ModelUse, result: ModelProbeResult, catalog: ModelCatalog): SetupCheckItem {
  const base = modelBase(use);
  switch (result.outcome) {
    case 'tools': {
      const latency = result.latencyMs === undefined ? '' : ` (${(result.latencyMs / 1000).toFixed(1)} s)`;
      return { ...base, status: 'ok', message: `${result.message}${latency}` };
    }
    case 'text': {
      const pending = use.targets.filter((t) => t.usesTools && t.toolMode !== 'text');
      if (!pending.length) return { ...base, status: 'ok', message: 'Works in text tool mode' };
      return {
        ...base,
        status: 'warning',
        message: `Needs text tool mode. In ${joinNames(pending.map((t) => t.name))}, set Tool calls to Text in the prompt.`,
        fix: pending[0].fix,
      };
    }
    default: {
      const fix = probeFix(use.ref, result, catalog);
      return { ...base, status: 'error', message: result.message, ...(fix ? { fix } : {}) };
    }
  }
}

/** The item shown while a model is being tested. */
export function testingItem(use: ModelUse): SetupCheckItem {
  return { ...modelBase(use), status: 'running', message: 'Testing…' };
}

function modelBase(use: ModelUse): Pick<SetupCheckItem, 'id' | 'kind' | 'label' | 'usedBy'> {
  return { id: `model:${use.ref}`, kind: 'model', label: use.ref, usedBy: use.usedBy };
}

function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The command (and arguments) that performs a setup fix outside the sidebar, e.g. from a notification. */
export function fixCommand(message: SidebarToHost): [string, ...unknown[]] | undefined {
  switch (message.type) {
    case 'setProviderKey':
    case 'editProvider':
      return [`isarFlow.${message.type}`, message.providerId];
    case 'addProvider':
      return ['isarFlow.addProvider'];
    case 'openSettings':
      return ['workbench.action.openSettings', message.query];
    default:
      return undefined;
  }
}
