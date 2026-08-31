import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolError, ToolErrorCode } from '../types.js';

/**
 * Builds a successful tool result carrying both halves of the contract: text
 * for a human reading the transcript, and structured data for whatever consumes
 * the output programmatically.
 *
 * @param text Human-readable summary. Written for someone who has not seen the
 *   raw data — lead with the answer, not with the method.
 * @param structured Value matching the tool's `outputSchema`. The SDK validates
 *   it before it reaches the wire, so a mismatch fails loudly at development
 *   time rather than silently at the client. Typed as `object` rather than as a
 *   generic because the protocol's own field is untyped; the real check is the
 *   schema validation the SDK runs, not this signature.
 * @returns A `CallToolResult` with `content` and `structuredContent` populated.
 * @throws Never.
 */
export function succeed(text: string, structured: object): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/**
 * Builds a failed tool result.
 *
 * Deliberately carries no `structuredContent`: the shape a tool advertises in
 * its `outputSchema` describes a successful reading, and an error object is not
 * one. Squeezing failures into the same schema would force every field to be
 * optional and would cost callers the guarantee that a success means a complete
 * answer. The error stays in the text block, where clients already look.
 *
 * @param code Category of failure. See {@link ToolErrorCode}.
 * @param message Actionable explanation naming what failed and against what.
 * @returns A `CallToolResult` with `isError: true`.
 * @throws Never.
 */
export function fail(code: ToolErrorCode, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true,
  };
}

/**
 * Converts an unknown thrown value into a {@link ToolError}.
 *
 * Anything can be thrown in JavaScript, including values that are not `Error`
 * instances, so the non-`Error` case is handled rather than assumed away.
 *
 * @param cause The value caught in a `catch` block.
 * @returns An `unexpected` tool error carrying the best available message.
 * @throws Never.
 */
export function toToolError(cause: unknown): ToolError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { code: 'unexpected', message };
}

/**
 * Wraps a tool handler so that no exception can cross the MCP boundary.
 *
 * A handler that throws produces an opaque protocol error at best. Every
 * registered handler goes through here, so an unforeseen bug degrades to one
 * failed tool call instead of an unusable server.
 *
 * @param handler The handler to protect.
 * @returns A handler with the same signature that always resolves to a
 *   `CallToolResult`, using `isError: true` for anything that escaped.
 * @throws Never.
 */
export function guard<Args extends unknown[]>(
  handler: (...args: Args) => Promise<CallToolResult> | CallToolResult,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args): Promise<CallToolResult> => {
    try {
      return await handler(...args);
    } catch (cause) {
      const error = toToolError(cause);
      return fail(error.code, error.message);
    }
  };
}
