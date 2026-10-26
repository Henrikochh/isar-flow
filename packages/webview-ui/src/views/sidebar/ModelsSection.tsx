import { useState } from 'react';
import type { ModelCatalog, ProviderSummary } from '@isar-flow/core';
import { IconButton, Section } from '../../components';
import { ConfirmStrip } from './ConfirmStrip';
import { PROVIDER_STATUS_LABELS, providerCountText, send, uniqueKeys } from './model';
import './models.css';

export function ModelsSection({ catalog }: { catalog: ModelCatalog }) {
  const providers = catalog.providers ?? [];
  const keys = uniqueKeys(providers, (provider) => provider.id);
  return (
    <Section
      title="Models"
      actions={
        <span className="sb-section-actions">
          <IconButton
            icon={catalog.loading ? 'loading codicon-modifier-spin' : 'refresh'}
            label={catalog.loading ? 'Fetching models…' : 'Refresh models'}
            aria-busy={catalog.loading || undefined}
            onClick={() => send({ type: 'refreshModels' })}
          />
          <IconButton icon="add" label="Add endpoint" onClick={() => send({ type: 'addProvider' })} />
        </span>
      }
    >
      {providers.length === 0 ? (
        <p className="sb-note">No model providers yet. Add an OpenAI-compatible endpoint such as LiteLLM or Ollama.</p>
      ) : (
        <ul className="sb-list" aria-label="Model providers">
          {providers.map((provider, index) => (
            <li key={keys[index]}>
              <ProviderRow provider={provider} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ProviderRow({ provider }: { provider: ProviderSummary }) {
  const [confirming, setConfirming] = useState(false);
  const label = provider.label || provider.id || 'Unnamed provider';
  const status = provider.status in PROVIDER_STATUS_LABELS ? provider.status : 'unknown';
  const editable = provider.kind === 'openai-compatible';

  if (confirming) {
    return (
      <ConfirmStrip
        title={`Remove ${label}?`}
        confirmLabel="Remove endpoint"
        onConfirm={() => {
          setConfirming(false);
          send({ type: 'removeProvider', providerId: provider.id });
        }}
        onCancel={() => setConfirming(false)}
      >
        Its models disappear from the model pickers. Agents that use them need another model.
      </ConfirmStrip>
    );
  }

  return (
    <div className="sb-row">
      <button
        type="button"
        className="sb-row__main sb-provider"
        title={provider.baseUrl || undefined}
        onClick={() => send({ type: 'editProvider', providerId: provider.id })}
      >
        <span className={`sb-dot sb-dot--${status}`} role="img" aria-label={PROVIDER_STATUS_LABELS[status]} />
        <span className="sb-row__body">
          <span className="sb-provider__line">
            <span className="sb-provider__label">{label}</span>
            <span className={editable ? 'sb-provider__count sb-provider__count--yields' : 'sb-provider__count'}>
              {providerCountText(provider)}
            </span>
          </span>
          {status === 'error' && provider.error ? <span className="sb-provider__error">{provider.error}</span> : null}
        </span>
      </button>
      {editable ? (
        <div className="sb-row__overlay">
          <IconButton icon="key" label={provider.hasApiKey ? 'Change API key' : 'Set API key'} onClick={() => send({ type: 'setProviderKey', providerId: provider.id })} />
          <IconButton icon="trash" label={`Remove ${label}`} onClick={() => setConfirming(true)} />
        </div>
      ) : null}
    </div>
  );
}
