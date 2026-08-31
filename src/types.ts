/**
 * Result shapes shared across tools.
 *
 * Every tool returns human-readable text *and* structured data. The structured
 * half is what a model or a downstream script consumes; the text half is what a
 * person reads in a chat transcript.
 */

/**
 * Machine-readable reason a tool could not produce a result.
 *
 * These are the failure modes callers can act on differently: a `timeout` is
 * worth retrying, an `invalid_input` never is.
 */
export type ToolErrorCode =
  /** The input was syntactically valid but unusable (e.g. a URL with no host). */
  | 'invalid_input'
  /** The target could not be reached: DNS failure, refused connection, TLS handshake failure. */
  | 'network'
  /** The operation exceeded its deadline. */
  | 'timeout'
  /** The target responded, but the thing being asked about does not exist. */
  | 'not_found'
  /** Anything unforeseen. A bug in this server until proven otherwise. */
  | 'unexpected';

/**
 * A tool failure carried across the MCP boundary as a normal result.
 *
 * No exception ever leaves a handler: an MCP server that crashes is a useless
 * MCP server, so failures are values, not throws.
 */
export interface ToolError {
  /** Category of failure, for callers that branch on it. */
  code: ToolErrorCode;
  /**
   * Actionable, human-readable explanation, in English.
   * Say what failed and against what, e.g. `TLS handshake with example.com:443
   * timed out after 10s`, not `request failed`.
   */
  message: string;
}

/** Liveness report returned by the `health` tool. */
export interface HealthReport {
  /** Always `'ok'`. If the server can answer at all, it is healthy. */
  status: 'ok';
  /** Server name, matching the MCP handshake. */
  server: string;
  /** Server version, matching `package.json`. */
  version: string;
  /** Node.js version the server is running under, e.g. `'v20.11.0'`. */
  node: string;
  /** Whole seconds since this server process started. */
  uptimeSeconds: number;
  /** Moment the report was produced, ISO 8601 with timezone. */
  checkedAt: string;
}
