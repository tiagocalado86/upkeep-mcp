# uptime_check

Call:

```json
{ "name": "uptime_check", "arguments": { "url": "http://github.com" } }
```

Text returned to the conversation:

```
http://github.com/ answered 200 in 113ms.
Ends at https://github.com/ after 2 requests.
HSTS: max-age=31536000.

Needs attention:
- [info] These headers do nothing in current browsers and can be removed: x-xss-protection.
```

Structured content:

```json
{
  "url": "http://github.com/",
  "finalUrl": "https://github.com/",
  "checkedAt": "2026-08-31T09:58:12.958Z",
  "severity": "info",
  "findings": [
    {
      "code": "dead_headers_present",
      "severity": "info",
      "message": "These headers do nothing in current browsers and can be removed: x-xss-protection."
    }
  ],
  "reachable": true,
  "status": 200,
  "responseTimeMs": 113,
  "redirects": {
    "hops": [
      {
        "url": "http://github.com/",
        "status": 301,
        "location": "https://github.com/",
        "elapsedMs": 113
      },
      {
        "url": "https://github.com/",
        "status": 200,
        "location": null,
        "elapsedMs": 162
      }
    ],
    "truncated": false,
    "loopDetected": false,
    "crossHost": false
  },
  "https": {
    "probedHttp": true,
    "upgradesToHttps": true,
    "upgradeOnFirstHop": true
  },
  "hsts": {
    "present": true,
    "maxAgeSeconds": 31536000,
    "activelyDisabled": false,
    "includeSubDomains": true,
    "preload": true,
    "preloadEligible": true
  },
  "securityHeaders": {
    "contentSecurityPolicy": "default-src 'none'; base-uri 'self'; child-src github.githubassets.com github.com/assets-cdn/worker/ github.com/assets/ gist.github.com/assets-cdn/worker/; connect-src 'self' uploads.github.com www.githubstatus.com collector.github.com raw.githubusercontent.com api.github.com github-cloud.s3.amazonaws.com github-production-repository-file-5c1aeb.s3.amazonaws.com github-production-upload-manifest-file-7fdce7.s3.amazonaws.com github-production-user-asset-6210df.s3.amazonaws.com *.rel.tunnels.api.visualstudio.com wss://*.rel.tunnels.api.visualstudio.com github.githubassets.com objects-origin.githubusercontent.com copilot-proxy.githubusercontent.com proxy.individual.githubcopilot.com proxy.business.githubcopilot.com proxy.enterprise.githubcopilot.com *.actions.githubusercontent.com wss://*.actions.githubusercontent.com productionresultssa0.blob.core.windows.net productionresultssa1.blob.core.windows.net productionresultssa2.blob.core.windows.net productionresultssa3.blob.core.windows.net productionresultssa4.blob.core.windows.net productionresultssa5.blob.core.windows.net productionresultssa6.blob.core.windows.net productionresultssa7.blob.core.windows.net productionresultssa8.blob.core.windows.net productionresultssa9.blob.core.windows.net productionresultssa10.blob.core.windows.net productionresultssa11.blob.core.windows.net productionresultssa12.blob.core.windows.net productionresultssa13.blob.core.windows.net productionresultssa14.blob.core.windows.net productionresultssa15.blob.core.windows.net productionresultssa16.blob.core.windows.net productionresultssa17.blob.core.windows.net productionresultssa18.blob.core.windows.net productionresultssa19.blob.core.windows.net github-production-repository-image-32fea6.s3.amazonaws.com github-production-release-asset-2e65be.s3.amazonaws.com insights.github.com wss://alive.github.com wss://alive-staging.github.com api.githubcopilot.com api.individual.githubcopilot.com api.business.githubcopilot.com api.enterprise.githubcopilot.com wss://production-copilot-host.webpubsub.azure.com edge.fullstory.com rs.fullstory.com; font-src github.githubassets.com; form-action 'self' github.com gist.github.com copilot-workspace.githubnext.com objects-origin.githubusercontent.com; frame-ancestors 'none'; frame-src viewscreen.githubusercontent.com notebooks.githubusercontent.com www.youtube-nocookie.com; img-src 'self' data: blob: github.githubassets.com media.githubusercontent.com camo.githubusercontent.com identicons.github.com avatars.githubusercontent.com private-avatars.githubusercontent.com github-cloud.s3.amazonaws.com objects.githubusercontent.com release-assets.githubusercontent.com secured-user-images.githubusercontent.com user-images.githubusercontent.com private-user-images.githubusercontent.com opengraph.githubassets.com repository-images.githubusercontent.com marketplace-screenshots.githubusercontent.com copilotprodattachments.blob.core.windows.net/github-production-copilot-attachments/ github-production-user-asset-6210df.s3.amazonaws.com customer-stories-feed.github.com spotlights-feed.github.com explore-feed.github.com objects-origin.githubusercontent.com *.githubusercontent.com images.ctfassets.net/8aevphvgewt8/; manifest-src 'self'; media-src github.com user-images.githubusercontent.com secured-user-images.githubusercontent.com private-user-images.githubusercontent.com github-production-user-asset-6210df.s3.amazonaws.com gist.github.com github.githubassets.com assets.ctfassets.net/8aevphvgewt8/ videos.ctfassets.net/8aevphvgewt8/; script-src github.githubassets.com; style-src 'unsafe-inline' github.githubassets.com; upgrade-insecure-requests; worker-src github.githubassets.com github.com/assets-cdn/worker/ github.com/assets/ gist.github.com/assets-cdn/worker/",
    "contentSecurityPolicyReportOnly": false,
    "framingProtection": "csp-frame-ancestors",
    "xContentTypeOptions": "nosniff",
    "referrerPolicy": "origin-when-cross-origin, strict-origin-when-cross-origin",
    "permissionsPolicy": null,
    "crossOriginOpenerPolicy": null,
    "reportingEndpoints": null,
    "deadHeadersPresent": [
      "x-xss-protection"
    ]
  }
}
```
