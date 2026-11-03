/** Chips that say what an agent may do and how a model did in "Test model". */
import { agentCapabilities, type CapabilitySource, type ModelProbeResult } from '@isar-flow/core';
import { Chip, type ChipTone } from './Display';

/**
 * Capability badges of an agent ("Read-only", "Edits files (auto)", "Runs commands (asks)") from its tools and
 * permissions. Renders a fragment so the badges sit among the caller's other chips.
 */
export function CapabilityChips({ source }: { source: CapabilitySource | null | undefined }) {
  return (
    <>
      {agentCapabilities(source).map((badge) => (
        <Chip key={badge.kind} tone="outline" icon={badge.icon} title={badge.title}>
          {badge.text}
        </Chip>
      ))}
    </>
  );
}

const PROBE_CHIPS: Record<ModelProbeResult['outcome'], { label: string; tone: ChipTone; icon: string }> = {
  tools: { label: 'Tool calls OK', tone: 'success', icon: 'pass' },
  text: { label: 'Needs text mode', tone: 'warning', icon: 'warning' },
  failed: { label: 'Test failed', tone: 'error', icon: 'error' },
};

/** Outcome of the latest "Test model" run; the tooltip carries the full message. */
export function ProbeChip({ probe }: { probe: ModelProbeResult | undefined }) {
  const chip = probe && Object.hasOwn(PROBE_CHIPS, probe.outcome) ? PROBE_CHIPS[probe.outcome] : undefined;
  if (!chip || !probe) return null;
  return (
    <Chip tone={chip.tone} icon={chip.icon} title={probe.message || undefined}>
      {chip.label}
    </Chip>
  );
}
