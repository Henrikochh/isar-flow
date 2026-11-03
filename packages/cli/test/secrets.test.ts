import { describe, expect, it } from 'vitest';
import { processEnv, readSecrets, referencedSecretNames, secretEnvName } from '../src/secrets';

describe('secrets from the environment', () => {
  it('names the environment variable of a secret', () => {
    expect(secretEnvName('api_token')).toBe('ISARFLOW_SECRET_API_TOKEN');
    expect(secretEnvName('deploy-key')).toBe('ISARFLOW_SECRET_DEPLOY_KEY');
  });

  it('finds the secrets a workflow reads', () => {
    const text = [
      'run: curl -H "Bearer ${{ secrets.api_token }}" ${{ secrets["deploy-key"] }}',
      "prompt: ${{ secrets . NPM }} and ${{ secrets['other'] }} and ${{ secrets.api_token }}",
      'note: mysecrets.nothing',
    ].join('\n');
    expect(referencedSecretNames(text)).toEqual(['NPM', 'api_token', 'deploy-key', 'other']);
  });

  it('reads ISARFLOW_SECRET_ variables and the secrets the workflow names', () => {
    const env = {
      ISARFLOW_SECRET_API_TOKEN: 'tok-1234',
      ISARFLOW_SECRET_DEPLOY_KEY: 'key-5678',
      ISARFLOW_SECRET_EMPTY: '',
      OTHER: 'x',
    };
    expect(readSecrets(env, ['api_token', 'missing'], 'linux')).toEqual({
      API_TOKEN: 'tok-1234',
      DEPLOY_KEY: 'key-5678',
      api_token: 'tok-1234',
    });
  });

  it('ignores the case of variable names on Windows', () => {
    const env = { isarflow_secret_token: 'abcd1234' };
    expect(readSecrets(env, ['token'], 'win32')).toEqual({ TOKEN: 'abcd1234', token: 'abcd1234' });
    expect(readSecrets(env, ['token'], 'linux')).toEqual({});
  });

  it('passes the process environment as text values', () => {
    expect(processEnv({ A: '1', B: undefined })).toEqual({ A: '1' });
  });
});
