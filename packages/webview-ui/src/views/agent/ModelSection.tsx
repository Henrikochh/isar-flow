import { useMemo } from 'react';
import type { ModelCatalog } from '@isar-flow/core';
import { Chip, Field, IconButton, ModelPicker, Section } from '../../components';
import type { AgentForm, FieldIssues, UpdateAgent } from './agentForm';
import { NumberField } from './NumberField';

interface CatalogActions {
  onRefresh: () => void;
  onAddProvider: () => void;
}

/** A hint about the chosen model that the schema cannot know: unlisted models, missing tool support. */
export function modelNote(ref: string, usesTools: boolean, catalog: ModelCatalog): string | undefined {
  if (!ref) return 'Choose the model this agent talks to.';
  const info = catalog.models.find((m) => m.ref === ref);
  if (info) return usesTools && !info.capabilities.tools ? "This model can't call tools, so the agent's tools won't be used." : undefined;
  if (catalog.loading) return undefined;
  const providerId = ref.split('/')[0];
  const provider = catalog.providers.find((p) => p.id === providerId);
  if (!provider) return `No endpoint called "${providerId}" is set up. Add an endpoint or choose another model.`;
  if (provider.status === 'error') return `${provider.label} can't be reached right now, so this model can't be checked.`;
  if (provider.status === 'ok') return `${provider.label} doesn't list this model. Refresh models or choose another one.`;
  return undefined;
}

function ModelSummary({ refText, catalog, note }: { refText: string; catalog: ModelCatalog; note?: string }) {
  const info = catalog.models.find((m) => m.ref === refText);
  return (
    <span className="ag-model-summary">
      {/* The picker shows a listed model by its name; an unlisted one already appears there as its reference. */}
      {info ? <span className="ag-model-summary__ref">{refText}</span> : null}
      {info?.capabilities.tools ? <Chip tone="outline">Tools</Chip> : null}
      {info?.capabilities.jsonSchema ? <Chip tone="outline">JSON</Chip> : null}
      {note ? (
        <span className="ag-model-summary__note">
          <i className="codicon codicon-warning ag-model-summary__icon" aria-hidden="true" />
          {note}
        </span>
      ) : null}
    </span>
  );
}

function FallbackModels({
  list,
  mainModel,
  catalog,
  error,
  onChange,
  onRefresh,
  onAddProvider,
}: {
  list: string[];
  mainModel: string;
  catalog: ModelCatalog;
  error?: string;
  onChange: (list: string[]) => void;
} & CatalogActions) {
  const available = useMemo(
    () => ({ ...catalog, models: catalog.models.filter((m) => m.ref !== mainModel && !list.includes(m.ref)) }),
    [catalog, mainModel, list],
  );
  return (
    <Field label="Fallback models" labelExtra="Optional" hint="Tried in this order when the main model fails." error={error}>
      {({ id, describedBy, invalid }) => (
        <div className="ag-fallbacks">
          {list.length > 0 ? (
            <ol className="ag-fallbacks__list" aria-label="Fallback models">
              {list.map((ref, index) => (
                <li key={`${index}:${ref}`} className="ag-fallback">
                  <span className="ag-fallback__order" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="ag-fallback__ref" title={ref}>
                    {ref}
                  </span>
                  <IconButton
                    icon="close"
                    label={`Remove ${ref}`}
                    className="ag-fallback__remove"
                    onClick={() => onChange(list.filter((_, i) => i !== index))}
                  />
                </li>
              ))}
            </ol>
          ) : null}
          <div className="ag-fallbacks__add">
            <ModelPicker
              id={id}
              describedBy={describedBy}
              invalid={invalid}
              value={undefined}
              catalog={available}
              placeholder="Add a fallback model"
              onChange={(ref) => {
                if (ref && !list.includes(ref)) onChange([...list, ref]);
              }}
              onRefresh={onRefresh}
              onAddProvider={onAddProvider}
            />
          </div>
        </div>
      )}
    </Field>
  );
}

export function ModelSection({
  form,
  catalog,
  issues,
  update,
  onRefresh,
  onAddProvider,
}: {
  form: AgentForm;
  catalog: ModelCatalog;
  issues: FieldIssues;
  update: UpdateAgent;
} & CatalogActions) {
  const modelIssue = issues.message('model');
  const note = modelIssue.error || modelIssue.warning ? modelIssue.warning : modelNote(form.model, form.tools.length > 0, catalog);
  const setNumber = (key: 'temperature' | 'maxTokens' | 'maxTurns') => (value: number | undefined) =>
    value === undefined ? update({}, [key]) : update({ [key]: value });

  return (
    <Section title="Model">
      <Field label="Main model" error={modelIssue.error} hint={<ModelSummary refText={form.model} catalog={catalog} note={note} />}>
        {({ id, describedBy, invalid }) => (
          <ModelPicker
            id={id}
            describedBy={describedBy}
            invalid={invalid}
            value={form.model || undefined}
            catalog={catalog}
            onChange={(ref) => {
              if (ref && ref !== form.model) update({ model: ref });
            }}
            onRefresh={onRefresh}
            onAddProvider={onAddProvider}
          />
        )}
      </Field>
      <FallbackModels
        list={form.fallbackModels}
        mainModel={form.model}
        catalog={catalog}
        error={issues.message('fallbackModels').error}
        onChange={(list) => (list.length ? update({ fallbackModels: list }) : update({}, ['fallbackModels']))}
        onRefresh={onRefresh}
        onAddProvider={onAddProvider}
      />
      <div className="ag-numbers">
        <NumberField
          label="Temperature"
          value={form.temperature}
          placeholder="Default"
          hint="0 to 2. Lower is more focused."
          error={issues.message('temperature').error}
          onCommit={setNumber('temperature')}
        />
        <NumberField
          label="Max tokens"
          value={form.maxTokens}
          placeholder="Model default"
          hint="Longest reply per model call."
          integer
          error={issues.message('maxTokens').error}
          onCommit={setNumber('maxTokens')}
        />
        <NumberField
          label="Max turns"
          value={form.maxTurns}
          placeholder="20"
          hint="Tool rounds per task."
          integer
          error={issues.message('maxTurns').error}
          onCommit={setNumber('maxTurns')}
        />
      </div>
    </Section>
  );
}
