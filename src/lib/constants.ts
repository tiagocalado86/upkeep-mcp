/**
 * Identity of this server, shared by the MCP handshake, the `health` tool and
 * the outgoing `User-Agent`.
 *
 * `SERVER_VERSION` is duplicated from `package.json` on purpose: importing JSON
 * from an ESM build means either an import attribute or a runtime file read,
 * both of which complicate the published entrypoint for one string. The
 * duplication is held in check by a test that fails if the two drift apart.
 */
export const SERVER_NAME = 'upkeep-mcp';

/** Semantic version of the server. Must match `version` in `package.json`. */
export const SERVER_VERSION = '0.4.0';

/**
 * Sent on every outgoing HTTP request.
 *
 * Principle 4 of the project brief requires an identifiable agent with a
 * contact URL, so that anyone seeing these requests in their own access logs
 * can find out what made them and how to complain. The repository is the
 * contact point rather than an email address, which keeps a personal address
 * out of third-party logs.
 */
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION} (+https://github.com/tiagocalado86/upkeep-mcp)`;
