# upkeep-mcp

An MCP server for the recurring checks behind ongoing website maintenance:
domains, SSL certificates, uptime, technical SEO and accessibility — all from
publicly available information.

Built for people who look after a portfolio of client sites on a retainer, not
just a single domain. The goal is to answer one question quickly: **what needs
attention this week?**

## Status

Early development, built in public phase by phase. The server runs and connects,
but the checks themselves are not implemented yet — only `health` is available
today.

| Tool                  | Purpose                                                               | Status    |
| --------------------- | --------------------------------------------------------------------- | --------- |
| `health`              | Server name, version, Node.js version, uptime                         | Available |
| `domain_check`        | Registration expiry, registrar, nameservers, DNS records, DNSSEC      | Planned   |
| `ssl_check`           | Certificate expiry, issuer, chain validity, SAN coverage, TLS version | Planned   |
| `uptime_check`        | HTTP status, response time, redirect chain, security headers          | Planned   |
| `seo_audit`           | Title, meta, headings, canonical, robots.txt, sitemap, broken links   | Planned   |
| `accessibility_audit` | WCAG violations via axe-core                                          | Planned   |
| `portfolio_report`    | All of the above across a portfolio, sorted by urgency                | Planned   |

## Installation

Requires **Node.js 20 or newer**. Not published to npm yet — install from
source:

```bash
git clone https://github.com/tiagocalado86/upkeep-mcp.git
cd upkeep-mcp
npm install
npm run build
```

### Claude Code

```bash
claude mcp add upkeep -- node /absolute/path/to/upkeep-mcp/dist/index.js
```

### Claude Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "upkeep": {
      "command": "node",
      "args": ["/absolute/path/to/upkeep-mcp/dist/index.js"]
    }
  }
}
```

Restart the client and ask it to run the `health` tool. It answers with the
server version, the Node.js version and how long the process has been up.

## Security & privacy

This server never asks for, accepts or stores credentials. It reads only
information that any person with a browser or a DNS resolver could read.

- No API keys, tokens or passwords — for any service, ever.
- No intrusive behaviour: no port scanning, no subdomain brute-forcing, no
  vulnerability probing. It inspects public configuration; it is not an
  offensive tool.
- `robots.txt` is respected on any page crawl, with per-host rate limiting and
  an identifiable `User-Agent`.
- No persistent sensitive state. Caching is in memory or in a local file, with
  a TTL.

## License

MIT — see [LICENSE](LICENSE).
