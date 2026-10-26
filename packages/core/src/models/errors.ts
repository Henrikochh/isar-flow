import { ModelError, type ModelErrorKind } from './types';

const MAX_DETAIL = 500;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clip(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function kindForStatus(status: number): ModelErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad-request';
  return 'other';
}

/** Pulls a human-readable message out of an error payload such as `{ error: { message } }`. */
export function messageFromPayload(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  if (!isRecord(payload)) return undefined;
  const { error } = payload;
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.detail === 'string') return payload.detail;
  return undefined;
}

/** The readable part of an HTML error page (gateways and proxies send these): its title, else its text. */
function htmlText(text: string): string | undefined {
  if (!/^<(!doctype\s+html|html|head|body)\b/i.test(text)) return undefined;
  const html = text.slice(0, 100_000);
  const title = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]?.trim();
  if (title) return title;
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ');
}

/** The server's explanation from an error response body (JSON, HTML or plain text), shortened. */
export function serverMessage(body: string): string {
  const text = body.trim();
  if (!text) return '';
  try {
    const found = messageFromPayload(JSON.parse(text));
    if (found) return clip(found);
  } catch {
    // Not JSON: use the raw text.
  }
  return clip(htmlText(text) ?? text);
}

/** Parses a Retry-After header (delay in seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export interface HttpErrorContext {
  /** Provider label shown to the user. */
  label: string;
  /** Requested URL. */
  url: string;
  /** Set for chat requests, so a 404 is reported as an unknown model. */
  modelId?: string;
}

/** Builds the user-facing error for a failed HTTP response. */
export function httpError(
  status: number,
  body: string,
  ctx: HttpErrorContext,
  retryAfter?: string | null,
): ModelError {
  const kind = kindForStatus(status);
  const detail = serverMessage(body);
  const said = detail ? ` Server said: ${detail}` : '';
  const provider = `provider '${ctx.label}'`;
  let message: string;
  switch (kind) {
    case 'auth':
      message = `Authentication failed for ${provider} (HTTP ${status}). Set the API key with 'Isar Flow: Set provider API key'.`;
      break;
    case 'not-found':
      message =
        ctx.modelId !== undefined
          ? `Model '${ctx.modelId}' was not found on ${provider}.`
          : `Nothing found at ${ctx.url} (HTTP 404). Check the base URL of ${provider}; OpenAI-compatible APIs usually end with /v1.`;
      break;
    case 'rate-limit':
      message = `The ${provider} is rate limiting requests (HTTP 429). Wait a moment and try again.${said}`;
      break;
    case 'server':
      message = `The ${provider} had a server error (HTTP ${status}). Try again later.${said}`;
      break;
    case 'bad-request':
      message = detail
        ? `The ${provider} rejected the request (HTTP ${status}): ${detail}`
        : `The ${provider} rejected the request (HTTP ${status}).`;
      break;
    default:
      message = `The ${provider} answered with unexpected HTTP status ${status}.${said}`;
  }
  const error = new ModelError(message, kind, status);
  const retryAfterMs = parseRetryAfter(retryAfter);
  // Read by withRetry to wait as long as the server asked.
  return retryAfterMs === undefined ? error : Object.assign(error, { retryAfterMs });
}

/** The server could not be reached at all (connection refused, DNS failure, TLS error ...). */
export function unreachableError(baseUrl: string, cause: unknown): ModelError {
  const error = new ModelError(`Cannot reach ${baseUrl}. Is the server running?`, 'network');
  error.cause = cause;
  return error;
}

/** The connection broke after the server had started answering. */
export function connectionLostError(baseUrl: string, cause: unknown): ModelError {
  const error = new ModelError(
    `The connection to ${baseUrl} was lost while receiving the answer. Try again.`,
    'network',
  );
  error.cause = cause;
  return error;
}

/** The base URL from the settings cannot be used for requests at all. */
export function invalidBaseUrlError(label: string, baseUrl: string): ModelError {
  const problem = baseUrl.trim()
    ? `The base URL '${baseUrl}' of provider '${label}' is not a valid http(s) URL.`
    : `Provider '${label}' has no base URL.`;
  return new ModelError(
    `${problem} Use the full address, for example http://localhost:4000/v1.`,
    'bad-request',
  );
}

/** A header (or the API key) holds characters HTTP cannot carry. Never includes the value: it may be a secret. */
export function invalidHeaderError(label: string, header: string, isApiKey: boolean): ModelError {
  const message = isApiKey
    ? `The API key of provider '${label}' contains characters that cannot be sent in an HTTP header. ` +
      "Set it again with 'Isar Flow: Set provider API key'."
    : `The header '${header}' of provider '${label}' cannot be sent over HTTP: its name or value contains ` +
      'characters that are not allowed, such as line breaks or non-ASCII letters. Fix it in the provider settings.';
  return new ModelError(message, 'bad-request');
}

export function cancelledError(label: string): ModelError {
  return new ModelError(`The request to provider '${label}' was cancelled.`, 'aborted');
}
