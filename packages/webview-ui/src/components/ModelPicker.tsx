import { useMemo } from 'react';
import type { ModelCatalog } from '@isar-flow/core';
import { Button } from './Button';
import { ProbeChip } from './Capabilities';
import { Chip } from './Display';
import { Select, type SelectOption } from './Select';

export interface ModelPickerProps {
  value: string | undefined;
  catalog: ModelCatalog;
  onChange: (ref: string) => void;
  /** Adds a first option that clears the value (e.g. "Use the agent's model"). */
  emptyOption?: string;
  placeholder?: string;
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  onRefresh?: () => void;
  onAddProvider?: () => void;
}

const EMPTY = '__none__';

/** Searchable model selector grouped by provider; accepts unlisted refs typed by the user. */
export function ModelPicker({
  value,
  catalog,
  onChange,
  emptyOption,
  placeholder = 'Choose a model',
  id,
  describedBy,
  invalid,
  onRefresh,
  onAddProvider,
}: ModelPickerProps) {
  const options = useMemo(() => {
    const list: SelectOption[] = [];
    if (emptyOption) list.push({ value: EMPTY, label: emptyOption });
    const failing = new Map(catalog.providers.filter((p) => p.status === 'error').map((p) => [p.id, p]));
    const probes = typeof catalog.probes === 'object' && catalog.probes !== null ? catalog.probes : {};
    const probeOf = (ref: string) => (Object.hasOwn(probes, ref) ? probes[ref] : undefined);
    for (const model of catalog.models) {
      list.push({
        value: model.ref,
        label: model.name,
        description: model.ref,
        group: model.providerLabel,
        meta: (
          <span className="if-model-chips">
            {model.capabilities.tools ? <Chip tone="outline">Tools</Chip> : null}
            {model.capabilities.jsonSchema ? <Chip tone="outline">JSON</Chip> : null}
            <ProbeChip probe={probeOf(model.ref)} />
          </span>
        ),
      });
    }
    for (const provider of failing.values()) {
      list.push({
        value: `__error__${provider.id}`,
        label: provider.error ?? 'Models could not be loaded',
        group: provider.label,
        disabled: true,
      });
    }
    if (value && !list.some((o) => o.value === value)) {
      const probe = probeOf(value);
      list.push({
        value,
        label: value,
        description: 'Not in the model list',
        group: 'Current value',
        meta: probe ? <ProbeChip probe={probe} /> : undefined,
      });
    }
    return list;
  }, [catalog, emptyOption, value]);

  const footer =
    onRefresh || onAddProvider ? (
      <div style={{ display: 'flex', gap: 6, padding: 6, borderTop: '1px solid var(--if-border)' }}>
        {onRefresh ? (
          <Button size="s" variant="ghost" icon="refresh" onClick={onRefresh}>
            Refresh models
          </Button>
        ) : null}
        {onAddProvider ? (
          <Button size="s" variant="ghost" icon="add" onClick={onAddProvider}>
            Add endpoint
          </Button>
        ) : null}
      </div>
    ) : undefined;

  return (
    <Select
      id={id}
      describedBy={describedBy}
      invalid={invalid}
      value={value ?? (emptyOption ? EMPTY : undefined)}
      options={options}
      searchable
      allowCustom
      customLabel={(text) => `Use model "${text}"`}
      placeholder={catalog.loading && catalog.models.length === 0 ? 'Loading models…' : placeholder}
      emptyText={
        catalog.loading ? 'Loading models…' : 'No models match. Type a full reference like litellm/gpt-4.1.'
      }
      onChange={(next) => onChange(next === EMPTY ? '' : next)}
      footer={footer}
    />
  );
}
