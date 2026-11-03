import { useMemo } from 'react';
import type { ModelCatalog, ToolMode } from '@isar-flow/core';
import { Chip, Field, IconButton, ModelPicker, Section } from '../../components';
import type { AgentForm, FieldIssues, UpdateAgent } from './agentForm';
import { ProbeResult, probeOf, TestModelButton } from './ModelTest';
import { NumberField } from './NumberField';
import { ToolModeField } from './ToolModeField';

interface CatalogActions {
  onRefresh: () => void;
  onAddProvider: () => void;
}

export interface ModelNote {
  text: string;
  /** info: how the agent copes with the model; warning: something to fix. */
  tone: 'info' | 'warning';
}

const warning = (text: string): ModelNote => ({ text, tone: 'warning' });

/** Tool call mode the agent runs with: unknown values count as automatic, like the default. */
export function effectiveToolMode(value: string | undefined): ToolMode {
  return value === 'native' || value === 'text' ? value : 'auto';
}

/**
 * A hint about the chosen model that the schema cannot know: unlisted models, missing tool support (from the model
 * list or a "Test model" that needed text mode).
 */
export function modelNote(
  ref: string,
  usesTools: boolean,
  catalog: ModelCatalog,
  toolMode: ToolMode = 'auto',
): ModelNote | undefined {
  if (!ref) return warning('Choose the model this agent talks to.');
  const info = catalog.models.find((m) => m.ref === ref);
  const textOnly =
    (info !== undefined && !info.capabilities.tools) || probeOf(catalog, ref)?.outcome === 'text';
  if (usesTools && textOnly) {
    if (toolMode === 'native')
      return warning(
        "This model can't call tools natively. Set Tool calls to Automatic or Text in the prompt.",
      );
    if (toolMode === 'auto')
      return {
        text: "This model can't call tools natively, so Automatic describes the tools in the prompt.",
        tone: 'info',
      };
    return undefined;
  }
  if (info || catalog.loading) return undefined;
  const providerId = ref.split('/')[0];
  const provider = catalog.providers.find((p) => p.id === providerId);
  if (!provider)
    return warning(`No endpoint called "${providerId}" is set up. Add an endpoint or choose another model.`);
  if (provider.status === 'error')
    return warning(`${provider.label} can't be reached right now, so this model can't be checked.`);
  if (provider.status === 'ok')
    return warning(`${provider.label} doesn't list this model. Refresh models or choose another one.`);
  return undefined;
}

function ModelSummary({
  refText,
  catalog,
  note,
  toolMode,
}: {
  refText: string;
  catalog: ModelCatalog;
  note?: ModelNote;
  toolMode: ToolMode;
}) {
  const info = catalog.models.find((m) => m.ref === refText);
  const probe = probeOf(catalog, refText);
  return (
    <span className="ag-model-summary">
      {/* The picker shows a listed model by its name; an unlisted one already appears there as its reference. */}
      {info ? <span className="ag-model-summary__ref">{refText}</span> : null}
      {info?.capabilities.tools ? <Chip tone="outline">Tools</Chip> : null}
      {info?.capabilities.jsonSchema ? <Chip tone="outline">JSON</Chip> : null}
      {probe ? <ProbeResult probe={probe} settled={probe.outcome === 'text' && toolMode === 'text'} /> : null}
      {note ? (
        <span className={`ag-model-summary__note ag-model-summary__note--${note.tone}`}>
          <i
            className={`codicon codicon-${note.tone === 'info' ? 'info' : 'warning'} ag-model-summary__icon`}
            aria-hidden="true"
          />
          {note.text}
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
    () => ({
      ...catalog,
      models: catalog.models.filter((m) => m.ref !== mainModel && !list.includes(m.ref)),
    }),
    [catalog, mainModel, list],
  );
  return (
    <Field
      label="Fallback models"
      labelExtra="Optional"
      hint="Tried in this order when the main model fails."
      error={error}
    >
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
  onTestModel,
}: {
  form: AgentForm;
  catalog: ModelCatalog;
  issues: FieldIssues;
  update: UpdateAgent;
  onTestModel: (ref: string) => void;
} & CatalogActions) {
  const modelIssue = issues.message('model');
  const note: ModelNote | undefined =
    modelIssue.error || modelIssue.warning
      ? modelIssue.warning
        ? warning(modelIssue.warning)
        : undefined
      : modelNote(form.model, form.tools.length > 0, catalog, effectiveToolMode(form.toolMode));
  const setNumber = (key: 'temperature' | 'maxTokens' | 'maxTurns') => (value: number | undefined) =>
    value === undefined ? update({}, [key]) : update({ [key]: value });

  return (
    <Section title="Model">
      <Field
        label="Main model"
        error={modelIssue.error}
        hint={
          <ModelSummary
            refText={form.model}
            catalog={catalog}
            note={note}
            toolMode={effectiveToolMode(form.toolMode)}
          />
        }
      >
        {({ id, describedBy, invalid }) => (
          <div className="ag-model-row">
            <div className="ag-model-row__picker">
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
            </div>
            <TestModelButton refText={form.model} catalog={catalog} onTest={onTestModel} />
          </div>
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
      <ToolModeField value={form.toolMode} error={issues.message('toolMode').error} update={update} />
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
