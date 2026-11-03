/** "Test model" for the agent's main model: the button and the latest result. */
import type { ModelCatalog, ModelProbeResult } from '@isar-flow/core';
import { Button } from '../../components';
import { formatDuration } from '../../hooks';

const OUTCOME_ICONS: Record<ModelProbeResult['outcome'], string> = {
  tools: 'pass',
  text: 'warning',
  failed: 'error',
};

export function probeOf(catalog: ModelCatalog, ref: string): ModelProbeResult | undefined {
  const probes = catalog.probes;
  if (!ref || !probes || !Object.hasOwn(probes, ref)) return undefined;
  const probe = probes[ref];
  return probe && Object.hasOwn(OUTCOME_ICONS, probe.outcome) ? probe : undefined;
}

export function isProbing(catalog: ModelCatalog, ref: string): boolean {
  return Boolean(ref) && Array.isArray(catalog.probing) && catalog.probing.includes(ref);
}

export function TestModelButton({
  refText,
  catalog,
  onTest,
}: {
  refText: string;
  catalog: ModelCatalog;
  onTest: (ref: string) => void;
}) {
  const testing = isProbing(catalog, refText);
  const probe = probeOf(catalog, refText);
  return (
    <>
      <Button
        icon="beaker"
        loading={testing}
        disabled={!refText}
        title={
          refText ? 'Try one tool call and one JSON answer with this model' : 'Choose a model to test it'
        }
        onClick={() => onTest(refText)}
      >
        {testing ? 'Testing…' : 'Test model'}
      </Button>
      {/* The result appears in the field's hint; screen readers hear it when it changes. */}
      <span role="status" className="if-visually-hidden">
        {testing ? `Testing ${refText}…` : probe ? `Test of ${refText}: ${probe.message}` : ''}
      </span>
    </>
  );
}

/**
 * "Tool calls work  820 ms": the probe's own sentence and how long the test took. `settled`: the agent already
 * does what the result asks for (text tool mode), so it reads as fine.
 */
export function ProbeResult({ probe, settled }: { probe: ModelProbeResult; settled?: boolean }) {
  const outcome = settled ? 'tools' : probe.outcome;
  return (
    <span className={`ag-probe ag-probe--${outcome}`}>
      <i className={`codicon codicon-${OUTCOME_ICONS[outcome]} ag-probe__icon`} aria-hidden="true" />
      <span className="ag-probe__message">{probe.message}</span>
      {probe.latencyMs !== undefined ? (
        <span className="ag-probe__latency">{formatDuration(probe.latencyMs)}</span>
      ) : null}
    </span>
  );
}
