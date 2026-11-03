import { describe, expect, it } from 'vitest';
import { parseProjectConfigText } from '../../src/yaml';

const lines = (...text: string[]) => `${text.join('\n')}\n`;

describe('parseProjectConfigText', () => {
  it('reads a valid config', () => {
    const text = lines(
      'version: 1',
      'providers:',
      '  - id: litellm',
      '    label: LiteLLM',
      '    baseUrl: http://localhost:4000/v1',
      '    apiKeyEnv: LITELLM_API_KEY',
      '    discoverModels: false',
      '    models: [gpt-4.1, claude]',
      '    headers: { X-Team: core }',
    );
    expect(parseProjectConfigText(text)).toEqual({
      config: {
        version: 1,
        providers: [
          {
            id: 'litellm',
            label: 'LiteLLM',
            baseUrl: 'http://localhost:4000/v1',
            apiKeyEnv: 'LITELLM_API_KEY',
            discoverModels: false,
            models: ['gpt-4.1', 'claude'],
            headers: { 'X-Team': 'core' },
          },
        ],
      },
      valid: true,
      diagnostics: [],
    });
  });

  it('treats an empty file or a file with only comments as an empty config', () => {
    for (const text of ['', '\n', '# Isar Flow command line settings\n']) {
      expect(parseProjectConfigText(text)).toEqual({ config: {}, valid: true, diagnostics: [] });
    }
  });

  it('reports schema problems with ranges', () => {
    const text = lines('providers:', '  - id: vscode', '    baseUrl: localhost:4000');
    const result = parseProjectConfigText(text);
    expect(result.config).toBeNull();
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'invalid-value',
        message: "The id 'vscode' is reserved for VS Code's own models, which the command line can't use",
        path: ['providers', 0, 'id'],
        range: { start: { line: 1, character: 8 }, end: { line: 1, character: 14 } },
      },
      {
        severity: 'error',
        code: 'invalid-value',
        message: 'Enter a full http:// or https:// address, e.g. "http://localhost:4000/v1"',
        path: ['providers', 0, 'baseUrl'],
        range: { start: { line: 2, character: 13 }, end: { line: 2, character: 27 } },
      },
    ]);
  });

  it('reports missing and unknown properties', () => {
    const text = lines('version: 2', 'providers:', '  - label: x', 'models: []');
    const { diagnostics, valid } = parseProjectConfigText(text);
    expect(valid).toBe(false);
    expect(diagnostics.map((d) => [d.code, d.message, d.range?.start.line])).toEqual([
      ['invalid-value', "'version' must be 1 (found 2)", 0],
      ['missing-property', "Missing required property 'id'", 2],
      ['missing-property', "Missing required property 'baseUrl'", 2],
      ['unknown-property', "Unknown property 'models'", 3],
    ]);
  });

  it('explains that API keys never go into the file', () => {
    const text = lines(
      'providers:',
      '  - id: litellm',
      '    baseUrl: http://localhost:4000',
      '    apiKey: sk-123',
    );
    const { diagnostics } = parseProjectConfigText(text);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'unknown-property',
        message:
          "Unknown property 'apiKey'. Don't put API keys in this file: store the key in an environment variable " +
          'and name that variable in apiKeyEnv.',
        path: ['providers', 0, 'apiKey'],
        range: { start: { line: 3, character: 4 }, end: { line: 3, character: 10 } },
      },
    ]);
  });

  it('reports YAML errors and files that are not a mapping', () => {
    const broken = parseProjectConfigText('providers: [\n');
    expect(broken).toMatchObject({ config: null, valid: false });
    expect(broken.diagnostics[0]).toMatchObject({ severity: 'error', code: 'yaml-syntax' });
    expect(broken.diagnostics[0].range).toBeDefined();

    const list = parseProjectConfigText('- id: litellm\n');
    expect(list).toMatchObject({ config: null, valid: false });
    expect(list.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'not-a-mapping',
        message:
          'A config file must be a YAML mapping with version and providers, but this file contains a list.',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
      },
    ]);
    expect(parseProjectConfigText('litellm\n').diagnostics[0].message).toBe(
      'A config file must be a YAML mapping with version and providers, but this file contains a single value.',
    );
  });

  it('reports unknown aliases', () => {
    const { diagnostics, valid } = parseProjectConfigText('providers: *missing\n');
    expect(valid).toBe(false);
    expect(diagnostics[0]).toMatchObject({ code: 'yaml-syntax' });
  });
});
