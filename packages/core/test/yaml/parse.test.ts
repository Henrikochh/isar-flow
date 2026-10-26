import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { offsetToPosition, parseAgentText, parseWorkflowText } from '../../src/yaml';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');

describe('parseWorkflowText', () => {
  it('parses a valid workflow with step ranges', () => {
    const text = fixture('commented.workflow.yaml');
    const result = parseWorkflowText(text);
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.workflow?.name).toBe('Review until approved');
    expect(result.workflow?.steps.map((s) => s.id)).toEqual(['implement', 'review_loop']);
    const range = result.stepRanges.review;
    expect(text.split('\n')[range.start.line]).toContain('- id: review');
  });

  it('reports YAML syntax errors with line numbers', () => {
    const text = 'version: 1\nname: x\nsteps:\n  - id: a\n    type: agent\n   prompt: bad indent\n';
    const result = parseWorkflowText(text);
    expect(result.workflow).toBeNull();
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0].code).toBe('yaml-syntax');
    expect(result.diagnostics[0].range?.start.line).toBe(5);
  });

  it('reports schema errors at the offending key and attributes them to the block', () => {
    const text = [
      'version: 1',
      'name: x',
      'steps:',
      '  - id: impl',
      '    type: agent',
      '    promt: typo',
      '  - id: run',
      '    type: console',
      '    run: echo hi',
    ].join('\n');
    const result = parseWorkflowText(text);
    expect(result.valid).toBe(false);
    // Lenient model still renders on the canvas.
    expect(result.workflow?.steps.map((s) => s.id)).toEqual(['impl', 'run']);
    const unknownKey = result.diagnostics.find((d) => d.code === 'unknown-property');
    expect(unknownKey?.message).toBe("Unknown property 'promt'");
    expect(unknownKey?.range?.start).toEqual({ line: 5, character: 4 });
    expect(unknownKey?.stepId).toBe('impl');
    const missing = result.diagnostics.find((d) => d.code === 'missing-property');
    expect(missing?.message).toBe("Missing required property 'prompt'");
    expect(missing?.stepId).toBe('impl');
  });

  it('explains unknown block types', () => {
    const text = 'version: 1\nname: x\nsteps:\n  - id: a\n    type: teleport\n';
    const result = parseWorkflowText(text);
    const d = result.diagnostics.find((x) => x.code === 'unknown-block-type');
    expect(d?.message).toBe(
      "Unknown block type 'teleport'. Use one of: agent, console, loop, if, break, stop, approval.",
    );
    expect(d?.range?.start.line).toBe(4);
  });

  it('handles empty documents and non-objects', () => {
    expect(parseWorkflowText('').diagnostics[0].message).toMatch(/empty/i);
    expect(parseWorkflowText('- just\n- a list\n').diagnostics[0].message).toMatch(/mapping/i);
  });

  it('keeps blocks without ids in the lenient model', () => {
    const result = parseWorkflowText('version: 1\nname: x\nsteps:\n  - type: break\n');
    expect(result.workflow?.steps).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.code === 'missing-property')).toBe(true);
  });

  it('rejects duplicate keys', () => {
    const result = parseWorkflowText('version: 1\nname: a\nname: b\nsteps: []\n');
    expect(result.diagnostics[0].code).toBe('yaml-syntax');
  });
});

describe('parseAgentText', () => {
  it('parses agents', () => {
    const result = parseAgentText('name: Reviewer\nmodel: litellm/gpt-4.1\ntools: [readFile]\n');
    expect(result.agent?.name).toBe('Reviewer');
    expect(result.valid).toBe(true);
  });

  it('reports missing model', () => {
    const result = parseAgentText('name: Reviewer\n');
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0].message).toBe("Missing required property 'model'");
  });
});

describe('offsetToPosition', () => {
  it('maps offsets to 0-based line and character, handling CRLF', () => {
    const text = 'ab\r\ncd\nef';
    expect(offsetToPosition(text, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(text, 5)).toEqual({ line: 1, character: 1 });
    expect(offsetToPosition(text, 8)).toEqual({ line: 2, character: 1 });
  });
});
