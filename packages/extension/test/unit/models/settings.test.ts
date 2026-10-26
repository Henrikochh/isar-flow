import { describe, expect, it } from 'vitest';
import {
  apiKeySecret,
  checkBaseUrl,
  checkProviderId,
  providerIdFromSecret,
  readProviderConfigs,
  suggestProviderId,
} from '../../../src/models/settings';

describe('readProviderConfigs', () => {
  it('accepts a missing setting as no providers', () => {
    expect(readProviderConfigs(undefined)).toEqual({ configs: [], problems: [] });
    expect(readProviderConfigs(null)).toEqual({ configs: [], problems: [] });
  });

  it('reports a setting that is not a list', () => {
    const { configs, problems } = readProviderConfigs({ id: 'litellm' });
    expect(configs).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('isarFlow.providers');
  });

  it('reads a complete entry and defaults the label to the id', () => {
    const { configs, problems } = readProviderConfigs([
      {
        id: 'litellm',
        baseUrl: ' http://localhost:4000 ',
        discoverModels: false,
        models: ['gpt-4.1', ' claude '],
        headers: { 'X-Team': 'core' },
      },
      { id: 'or', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    ]);
    expect(problems).toEqual([]);
    expect(configs).toEqual([
      {
        id: 'litellm',
        label: 'litellm',
        baseUrl: 'http://localhost:4000',
        discoverModels: false,
        models: ['gpt-4.1', 'claude'],
        headers: { 'X-Team': 'core' },
      },
      { id: 'or', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    ]);
  });

  it('skips entries with invalid ids and says why', () => {
    const { configs, problems } = readProviderConfigs([
      { id: 'LiteLLM', baseUrl: 'http://a' },
      { id: '-x', baseUrl: 'http://a' },
      { baseUrl: 'http://a' },
      'litellm',
    ]);
    expect(configs).toEqual([]);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain("'LiteLLM'");
    expect(problems[0]).toMatch(/lowercase/);
  });

  it('reserves the id vscode', () => {
    const { configs, problems } = readProviderConfigs([{ id: 'vscode', baseUrl: 'http://a' }]);
    expect(configs).toEqual([]);
    expect(problems[0]).toMatch(/reserved/);
  });

  it('keeps the first of duplicate ids', () => {
    const { configs, problems } = readProviderConfigs([
      { id: 'a', baseUrl: 'http://one' },
      { id: 'a', baseUrl: 'http://two' },
    ]);
    expect(configs.map((c) => c.baseUrl)).toEqual(['http://one']);
    expect(problems[0]).toMatch(/more than once/);
  });

  it('requires an http(s) base URL', () => {
    const { configs, problems } = readProviderConfigs([
      { id: 'a', baseUrl: 'localhost:4000' },
      { id: 'b', baseUrl: 'ftp://host' },
      { id: 'c' },
      { id: 'd', baseUrl: 'https://ok.example/v1' },
    ]);
    expect(configs.map((c) => c.id)).toEqual(['d']);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("'a'");
    expect(problems[0]).toMatch(/http:\/\//);
  });

  it('drops malformed optional fields but keeps the endpoint', () => {
    const { configs, problems } = readProviderConfigs([
      {
        id: 'a',
        baseUrl: 'http://a',
        label: 42,
        discoverModels: 'yes',
        models: ['ok', 7],
        headers: { good: 'v', bad: 1 },
      },
      { id: 'b', baseUrl: 'http://b', models: 'gpt', headers: ['x'] },
    ]);
    expect(configs).toEqual([
      { id: 'a', label: 'a', baseUrl: 'http://a', models: ['ok'], headers: { good: 'v' } },
      { id: 'b', label: 'b', baseUrl: 'http://b' },
    ]);
    expect(problems).toHaveLength(6);
  });
});

describe('provider id and URL checks', () => {
  it('validates ids for input boxes', () => {
    expect(checkProviderId('litellm', [])).toBeUndefined();
    expect(checkProviderId('my_proxy-2', [])).toBeUndefined();
    expect(checkProviderId('', [])).toMatch(/Enter/);
    expect(checkProviderId('Lite', [])).toMatch(/lowercase/);
    expect(checkProviderId('vscode', [])).toMatch(/reserved/);
    expect(checkProviderId('litellm', ['litellm'])).toMatch(/already/);
  });

  it('validates base URLs', () => {
    expect(checkBaseUrl('http://localhost:4000')).toBeUndefined();
    expect(checkBaseUrl(' https://api.openai.com/v1 ')).toBeUndefined();
    expect(checkBaseUrl('')).toMatch(/Enter/);
    expect(checkBaseUrl('localhost:4000')).toMatch(/http:\/\//);
    expect(checkBaseUrl('file:///x')).toMatch(/http:\/\//);
  });

  it('suggests a free id', () => {
    expect(suggestProviderId('litellm', [])).toBe('litellm');
    expect(suggestProviderId('litellm', ['litellm', 'litellm-2'])).toBe('litellm-3');
  });

  it('names API key secrets per provider', () => {
    expect(apiKeySecret('litellm')).toBe('isarFlow.provider.litellm.apiKey');
    expect(providerIdFromSecret('isarFlow.provider.litellm.apiKey')).toBe('litellm');
    expect(providerIdFromSecret('isarFlow.secret.TOKEN')).toBeUndefined();
  });
});
