import { USER_AGENT } from './constants.js';
import { CheckError } from './errors.js';

/** One HTTP response, reduced to what the checks need. */
export interface HttpHopResult {
  /** The URL that was requested. */
  url: string;
  /** HTTP status code. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** Raw `Location` header, or `null` when this was not a redirect. */
  location: string | null;
  /** Wall-clock milliseconds from request to response headers. */
  elapsedMs: number;
}

/** A parsed JSON response. */
export interface JsonResult {
  /** HTTP status code. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** The decoded body, or `null` when the body was empty or not JSON. */
  body: unknown;
}

/**
 * Performs one HTTP request without following redirects.
 *
 * Uses `GET` rather than `HEAD` on purpose: enough servers, WAFs and CDNs
 * mishandle `HEAD` that a failure reads as a problem with the site when it is a
 * problem with the tool — unacceptable when the output goes into a client
 * report. The body is cancelled the moment the headers arrive, which makes the
 * `GET` nearly as cheap.
 *
 * @param url Absolute URL to request.
 * @param timeoutMs Deadline for this hop.
 * @param signal Optional outer signal, so a whole-chain budget can cut it short.
 * @returns The status, headers and timing for this hop.
 * @throws {CheckError} `timeout` when the deadline passes, `network` otherwise.
 */
export async function httpHop(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpHopResult> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
  const startedAt = performance.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: combined,
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    });
  } catch (cause) {
    throw asCheckError(cause, url, timeoutMs);
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  // Nothing here reads the body, and an unconsumed body keeps the connection
  // occupied until it is collected.
  await response.body?.cancel().catch(() => undefined);

  return {
    url,
    status: response.status,
    headers: response.headers,
    location: response.headers.get('location'),
    elapsedMs,
  };
}

/**
 * Fetches and decodes a JSON document, following redirects.
 *
 * Redirects are followed here — unlike {@link httpHop} — because RDAP thin
 * registries legitimately redirect to the registrar's own server.
 *
 * @param url Absolute URL to request.
 * @param timeoutMs Deadline for the whole request.
 * @param accept Value for the `Accept` header. Cloudflare's DNS-over-HTTPS
 *   endpoint returns HTTP 400 without `application/dns-json`, so this is not
 *   optional in practice.
 * @returns Status, headers and the decoded body.
 * @throws {CheckError} `timeout` when the deadline passes, `network` otherwise.
 */
export async function getJson(
  url: string,
  timeoutMs: number,
  accept = 'application/json',
): Promise<JsonResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept },
    });
  } catch (cause) {
    throw asCheckError(cause, url, timeoutMs);
  }

  return { status: response.status, headers: response.headers, body: await decodeJson(response) };
}

/**
 * Decodes a response body as JSON, tolerating one that is not.
 *
 * A non-JSON body is not an error here: several registries answer a 404 with an
 * empty body or with HTML, and the status is the authoritative signal anyway.
 *
 * @param response The response to read.
 * @returns The decoded body, or `null`.
 * @throws Never.
 */
async function decodeJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.trim() === '' ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Converts a `fetch` rejection into a categorised error.
 *
 * @param cause The rejection.
 * @param url The URL being requested.
 * @param timeoutMs The deadline that applied, for the message.
 * @returns A {@link CheckError}.
 * @throws Never.
 */
function asCheckError(cause: unknown, url: string, timeoutMs: number): CheckError {
  const seconds = (timeoutMs / 1000).toFixed(0);
  if (cause instanceof Error && cause.name === 'TimeoutError') {
    return new CheckError('timeout', `${url} did not respond within ${seconds}s`, { cause });
  }
  if (cause instanceof Error && cause.name === 'AbortError') {
    return new CheckError('timeout', `the request to ${url} was cut short by the time budget`, {
      cause,
    });
  }
  const detail = cause instanceof Error ? (cause.cause ?? cause) : cause;
  const reason = detail instanceof Error ? detail.message : String(detail);
  return new CheckError('network', `could not reach ${url}: ${reason}`, { cause });
}
