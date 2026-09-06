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

/** A text response, read up to a byte limit. */
export interface TextResult {
  /** The URL the response finally came from, after any redirects. */
  url: string;
  /** HTTP status code. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** The `Content-Type` header with any parameters stripped, lowercased. */
  contentType: string | null;
  /** The decoded body, cut off at the byte limit. */
  body: string;
  /** Whether the body was longer than the limit and was cut off. */
  truncated: boolean;
}

/** A binary response, read up to a byte limit. */
export interface BytesResult {
  /** The URL the response finally came from, after any redirects. */
  url: string;
  /** HTTP status code. */
  status: number;
  /** The `Content-Type` header with any parameters stripped, lowercased. */
  contentType: string | null;
  /** The body, cut off at the byte limit. */
  body: Uint8Array;
  /** Whether the body was longer than the limit and was cut off. */
  truncated: boolean;
}

/**
 * Fetches a text document, following redirects, and stops reading at a limit.
 *
 * The limit is not a nicety. A response body is attacker-controlled length —
 * a page that streams forever would otherwise hold this process until the
 * deadline, having already allocated everything it sent — so the body is read
 * in chunks and abandoned once it has produced enough to analyse.
 *
 * @param url Absolute URL to request.
 * @param timeoutMs Deadline for the whole request, reading included.
 * @param maxBytes Most bytes to read before giving up on the rest.
 * @param accept Value for the `Accept` header.
 * @returns The final URL, status, headers and as much of the body as was read.
 * @throws {CheckError} `timeout` when the deadline passes, `network` otherwise.
 */
export async function getText(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  accept = 'text/html,application/xhtml+xml,*/*;q=0.8',
): Promise<TextResult> {
  const deadline = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: deadline,
      headers: { 'user-agent': USER_AGENT, accept },
    });
  } catch (cause) {
    throw asCheckError(cause, url, timeoutMs);
  }

  let body: string;
  let truncated: boolean;
  try {
    ({ body, truncated } = await readCapped(response, maxBytes));
  } catch (cause) {
    throw asCheckError(cause, url, timeoutMs);
  }

  return {
    url: response.url === '' ? url : response.url,
    status: response.status,
    headers: response.headers,
    contentType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null,
    body,
    truncated,
  };
}

/**
 * Reads a response body up to a byte limit.
 *
 * @param response The response to drain.
 * @param maxBytes Most bytes to keep.
 * @returns The decoded text and whether anything was left unread.
 * @throws Whatever the underlying stream throws; the caller categorises it.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  const { bytes, truncated } = await readCappedBytes(response, maxBytes);
  // `fatal: false` so that a body cut mid-character, or one mislabelled by the
  // server, degrades to a replacement character instead of failing the check.
  return { body: new TextDecoder('utf-8', { fatal: false }).decode(bytes), truncated };
}

/**
 * Reads a response body up to a byte limit, without decoding it.
 *
 * @param response The response to drain.
 * @param maxBytes Most bytes to keep.
 * @returns The bytes and whether anything was left unread.
 * @throws Whatever the underlying stream throws; the caller categorises it.
 */
async function readCappedBytes(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const stream = response.body;
  if (stream === null) return { bytes: new Uint8Array(0), truncated: false };

  // `@types/node` types a response stream as `ReadableStream<any>`, so the chunk
  // type has to be pinned here. The Streams standard guarantees `Uint8Array`
  // chunks from a response body; this asserts what the types decline to say,
  // and it is the only place in the project that does.
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      // A chunk is whatever size the sender chose, so the last one is cut to
      // the allowance rather than kept whole: without this the limit is
      // "maxBytes plus one arbitrary chunk", which is not a limit.
      const room = maxBytes - total;
      const kept = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(kept);
      total += kept.byteLength;
      if (kept.byteLength < value.byteLength) truncated = true;
    }
    // Filling the allowance says nothing about whether more was coming, so the
    // stream is asked once more rather than guessed at.
    if (!truncated && total >= maxBytes) {
      truncated = !(await reader.read()).done;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes: merged, truncated };
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
 * Posts bytes and reads bytes back, up to a limit.
 *
 * The one request this project makes that is neither text nor JSON. An OCSP
 * query is a DER structure posted to the certificate authority's responder, and
 * the answer is DER too — it travels over plain HTTP by design, because the
 * response carries the authority's signature and it is the signature, not the
 * transport, that makes it evidence.
 *
 * Redirects are not followed. The responder URL comes out of the certificate
 * being inspected, so it is chosen by whoever runs the target; following its
 * redirects would take the request somewhere the target guard has not been asked
 * about, which is the whole shape of the hole this project closed in `0.3.2`.
 *
 * @param url Absolute URL to post to.
 * @param body The request body.
 * @param contentType Value for the `Content-Type` header.
 * @param timeoutMs Deadline for the whole request, reading included.
 * @param maxBytes Most bytes to read before giving up on the rest.
 * @returns The status, content type and as much of the body as was read.
 * @throws {CheckError} `timeout` when the deadline passes, `network` otherwise.
 */
export async function postForBytes(
  url: string,
  body: Uint8Array,
  contentType: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<BytesResult> {
  const deadline = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: deadline,
      headers: { 'user-agent': USER_AGENT, accept: '*/*', 'content-type': contentType },
      body,
    });
  } catch (cause) {
    throw asCheckError(cause, url, timeoutMs);
  }

  let bytes: Uint8Array;
  let truncated: boolean;
  try {
    ({ bytes, truncated } = await readCappedBytes(response, maxBytes));
  } catch (cause) {
    throw asCheckError(cause, url, timeoutMs);
  }

  return {
    // Redirects are refused above, so the URL that answered is the one asked for.
    url,
    status: response.status,
    contentType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null,
    body: bytes,
    truncated,
  };
}

/**
 * Fetches a document as bytes, following redirects, and stops reading at a limit.
 *
 * The counterpart to {@link getText} for a document that is not text until
 * something has been done to it. A sitemap is the case in hand: `sitemap.xml.gz`
 * is a gzip *file*, not a gzip-encoded response, so nothing in the HTTP stack
 * unpacks it and decoding those bytes as UTF-8 produces a page of replacement
 * characters that no sitemap parser can make sense of.
 *
 * @param url Absolute URL to request.
 * @param timeoutMs Deadline for the whole request, reading included.
 * @param maxBytes Most bytes to read before giving up on the rest.
 * @param accept Value for the `Accept` header.
 * @returns The final URL, status, content type and as much of the body as was
 *   read.
 * @throws {CheckError} `timeout` when the deadline passes, `network` otherwise.
 */
export async function getBytes(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  accept = 'application/xml,text/xml,application/gzip,*/*;q=0.8',
): Promise<BytesResult> {
  const deadline = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: deadline,
      headers: { 'user-agent': USER_AGENT, accept },
    });
  } catch (cause) {
    throw asCheckError(cause, url, timeoutMs);
  }

  let bytes: Uint8Array;
  let truncated: boolean;
  try {
    ({ bytes, truncated } = await readCappedBytes(response, maxBytes));
  } catch (cause) {
    throw asCheckError(cause, url, timeoutMs);
  }

  return {
    url: response.url === '' ? url : response.url,
    status: response.status,
    contentType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null,
    body: bytes,
    truncated,
  };
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
