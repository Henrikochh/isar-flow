import { describe, expect, it } from 'vitest';
import { httpError, parseRetryAfter, serverMessage } from '../../src/models/errors';

const ctx = { label: 'LiteLLM', url: 'http://localhost:4000/v1/models' };

describe('httpError', () => {
  it.each([401, 403])('reports HTTP %i as an auth problem with a fix', (status) => {
    const error = httpError(status, '{"error":{"message":"forbidden"}}', ctx);
    expect(error).toMatchObject({ kind: 'auth', status, retryable: false });
    expect(error.message).toBe(
      `Authentication failed for provider 'LiteLLM' (HTTP ${status}). Set the API key with 'Isar Flow: Set provider API key'.`,
    );
  });

  it('names the URL and the /v1 hint for a 404 while listing', () => {
    const error = httpError(404, 'Not Found', ctx);
    expect(error).toMatchObject({ kind: 'not-found', status: 404 });
    expect(error.message).toContain('http://localhost:4000/v1/models');
    expect(error.message).toContain('/v1');
  });

  it('names the model for a 404 while chatting', () => {
    const error = httpError(404, '', { ...ctx, modelId: 'gpt-9' });
    expect(error.message).toBe("Model 'gpt-9' was not found on provider 'LiteLLM'.");
  });

  it('marks 429 and 5xx as retryable and keeps the server message', () => {
    const limited = httpError(429, '{"error":{"message":"Too many tokens"}}', ctx);
    expect(limited).toMatchObject({ kind: 'rate-limit', retryable: true });
    expect(limited.message).toContain('Too many tokens');
    const broken = httpError(502, '{"detail":"upstream timed out"}', ctx);
    expect(broken).toMatchObject({ kind: 'server', status: 502, retryable: true });
    expect(broken.message).toContain('upstream timed out');
  });

  it('includes the server explanation for other client errors', () => {
    const error = httpError(400, '{"error":"temperature must be <= 2"}', ctx);
    expect(error).toMatchObject({ kind: 'bad-request', retryable: false });
    expect(error.message).toBe(
      "The provider 'LiteLLM' rejected the request (HTTP 400): temperature must be <= 2",
    );
  });

  it('carries the Retry-After hint in milliseconds', () => {
    expect(httpError(429, '', ctx, '2')).toMatchObject({ retryAfterMs: 2000 });
    expect(httpError(429, '', ctx, null)).not.toHaveProperty('retryAfterMs');
  });
});

describe('serverMessage', () => {
  it('reads the common JSON error shapes', () => {
    expect(serverMessage('{"error":{"message":"a"}}')).toBe('a');
    expect(serverMessage('{"error":"b"}')).toBe('b');
    expect(serverMessage('{"message":"c"}')).toBe('c');
    expect(serverMessage('{"detail":"d"}')).toBe('d');
    expect(serverMessage('  plain\n text ')).toBe('plain text');
    expect(serverMessage('')).toBe('');
  });

  it('shortens very long bodies', () => {
    expect(serverMessage('x'.repeat(2000)).length).toBeLessThanOrEqual(500);
  });

  it('uses the title of an HTML error page instead of its markup', () => {
    const nginx =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n' +
      '<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>';
    expect(serverMessage(nginx)).toBe('502 Bad Gateway');
  });

  it('strips markup, scripts and styles from HTML pages without a title', () => {
    const page =
      '<!DOCTYPE html><html><head><style>body{color:red}</style><script>var x = 1;</script></head>' +
      '<body><h1>Service unavailable</h1><p>Try again later.</p></body></html>';
    expect(serverMessage(page)).toBe('Service unavailable Try again later.');
  });
});

describe('parseRetryAfter', () => {
  it('reads delays in seconds', () => {
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter('-3')).toBe(0);
  });

  it('reads HTTP dates relative to now', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', now)).toBe(0);
  });

  it('ignores missing or unreadable values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('  ')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});
