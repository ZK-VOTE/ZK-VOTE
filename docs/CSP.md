# Content Security Policy (CSP) Implementation

## Overview

The ZK-VOTE application implements a strict Content Security Policy (CSP) to protect against Cross-Site Scripting (XSS), data injection, and clickjacking attacks. CSP is configured at both the frontend (nginx) and backend (Express/helmet) layers.

## CSP Directives

### Frontend (nginx.conf)

```nginx
Content-Security-Policy: 
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https: blob:;
  connect-src 'self' https: wss: blob:;
  font-src 'self' data:;
  frame-src https://anchor.circle.com https://anchor.eurc.circle.com;
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  block-all-mixed-content;
  upgrade-insecure-requests;
  report-uri /csp-report;
  report-to csp-endpoint
```

### Backend (Express/helmet)

The backend uses Helmet's CSP middleware with the same directives for API endpoints.

## Directive Explanations

| Directive | Value | Purpose |
|-----------|-------|---------|
| `default-src 'self'` | `'self'` | Only allow resources from the same origin |
| `script-src 'self' 'wasm-unsafe-eval'` | `'self' 'wasm-unsafe-eval'` | Allow scripts from same origin and WebAssembly execution (required for snarkjs/ZK circuits) |
| `style-src 'self' 'unsafe-inline'` | `'self' 'unsafe-inline'` | Allow styles from same origin and inline styles (required for Tailwind CSS) |
| `img-src 'self' data: https: blob:` | `'self' data: https: blob:` | Allow images from same origin, data URIs, HTTPS, and blob URLs (for IPFS images) |
| `connect-src 'self' https: wss: blob:` | `'self' https: wss: blob:` | Allow API connections to same origin, HTTPS, WebSockets, and blob URLs |
| `font-src 'self' data:` | `'self' data:` | Allow fonts from same origin and data URIs |
| `object-src 'none'` | `'none'` | Block plugins (Flash, Java, etc.) |
| `base-uri 'self'` | `'self'` | Restrict `<base>` tag to same origin |
| `form-action 'self'` | `'self'` | Restrict form submissions to same origin |
| `frame-ancestors 'none'` | `'none'` | Prevent clickjacking by blocking framing from any origin |
| `block-all-mixed-content` | - | Block all HTTP content on HTTPS pages |
| `upgrade-insecure-requests` | - | Automatically upgrade HTTP requests to HTTPS |

## WebAssembly Support

The `wasm-unsafe-eval` directive in `script-src` is required for WebAssembly execution, which is used by:
- **snarkjs**: For zero-knowledge proof generation in the browser
- **ZK circuits**: For anonymous voting operations

This is a known security exception but necessary for the application's core functionality. The risk is mitigated by:
- Only allowing WebAssembly from trusted sources (`'self'`)
- Using integrity checks for WASM modules
- Regular security audits of ZK circuit implementations

## CSP Violation Reporting

### Endpoint: `POST /csp-report`

The backend provides a CSP violation reporting endpoint that:
- Receives violation reports from browsers
- Logs violations with context (user agent, IP, report details)
- Returns HTTP 204 on success
- Returns HTTP 400 on invalid reports

### Report Format

Browsers send CSP violation reports in the following format:

```json
{
  "csp-report": {
    "document-uri": "https://example.com/page",
    "referrer": "https://example.com/",
    "violated-directive": "script-src",
    "effective-directive": "script-src",
    "original-policy": "...",
    "disposition": "report",
    "blocked-uri": "https://evil.com/script.js",
    "line-number": 42,
    "column-number": 12,
    "source-file": "https://example.com/app.js",
    "status-code": 200,
    "script-sample": ""
  }
}
```

### Monitoring

CSP violations are logged with the `csp_violation` event type and include:
- The full CSP report
- User agent string
- Client IP address

Monitor these logs to:
- Detect potential XSS attacks
- Identify misconfigured CSP directives
- Track legitimate violations that require policy adjustments

## Wallet Extension Compatibility

The CSP is designed to work with Stellar wallet extensions (Freighter, xBull, Albedo):

- **Extension Communication**: Extensions communicate via `window.postMessage`, which is not restricted by CSP
- **Content Scripts**: Extension content scripts run in a separate context with their own CSP
- **RPC Connections**: Wallet RPC endpoints are allowed via `connect-src 'self' https:`

## IPFS Gateway Support

IPFS gateway requests are allowed through:
- `img-src 'self' data: https: blob:` - For IPFS images
- `connect-src 'self' https:` - For IPFS metadata fetching

The application uses:
- **Pinata Gateway**: `https://gateway.pinata.cloud` (configurable)
- **Local IPFS**: If running a local IPFS node

## Testing CSP

### Local Development

To test CSP locally:

1. Build and run the frontend with Docker:
   ```bash
   docker-compose up frontend
   ```

2. Open browser DevTools and check the Security tab for CSP headers

3. Monitor the backend logs for CSP violations:
   ```bash
   docker-compose logs backend | grep csp_violation
   ```

### Browser Testing

Use the following tools to test CSP:
- **Chrome DevTools**: Security tab shows CSP status and violations
- **Firefox DevTools**: Security tab shows CSP status and violations
- **CSP Evaluator**: https://csp-evaluator.withgoogle.com/

### Common Issues

| Issue | Solution |
|-------|----------|
| WebAssembly fails to load | Ensure `wasm-unsafe-eval` is in `script-src` |
| Inline styles blocked | Add `'unsafe-inline'` to `style-src` (required for Tailwind) |
| IPFS images blocked | Add `https:` and `blob:` to `img-src` |
| Wallet extension issues | Check extension compatibility; CSP shouldn't affect extensions |
| Mixed content warnings | Ensure all resources use HTTPS |

## Security Considerations

### Strengths

- **Strict Default**: `default-src 'self'` provides a strong baseline
- **No Inline Scripts**: Prevents most XSS vectors
- **Clickjacking Protection**: `frame-ancestors 'none'` blocks framing
- **Mixed Content Blocking**: Prevents HTTP content on HTTPS pages
- **Violation Reporting**: Enables monitoring and incident response

### Known Exceptions

- **WebAssembly**: `wasm-unsafe-eval` is required for ZK proof generation
- **Inline Styles**: `unsafe-inline` is required for Tailwind CSS
- **Data URIs**: Required for some frontend optimizations

### Recommendations

1. **Regular Audits**: Review CSP violation logs monthly
2. **Policy Tightening**: Consider tightening directives if violations are low
3. **Subresource Integrity**: Add SRI hashes for external scripts (if added)
4. **Nonce-based CSP**: Consider nonce-based CSP for inline scripts if needed
5. **Report-Only Mode**: Test new policies in report-only mode first

## Configuration

### Environment Variables

No additional environment variables are required for CSP. The policy is static and configured in:
- `frontend/nginx.conf` - Frontend CSP
- `backend/src/index.ts` - Backend CSP

### Customization

To customize CSP for your deployment:

1. **Frontend**: Edit `frontend/nginx.conf` and rebuild the Docker image
2. **Backend**: Edit `backend/src/index.ts` and restart the service

### Report-Only Mode

For testing, you can use report-only mode:

```nginx
# nginx.conf
add_header Content-Security-Policy-Report-Only "..." always;
```

This allows you to test policies without blocking resources.

## References

- [MDN CSP Documentation](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [CSP Level 3 Specification](https://www.w3.org/TR/CSP3/)
- [Helmet CSP Documentation](https://helmetjs.github.io/)
- [OWASP CSP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)

## Trusted Types and user-generated Markdown (ZV-130)

The application no longer registers a permissive `default` Trusted Types policy.
The only named policy is `zkvote-escaped-text`, which **escapes all markup**;
it cannot authorize scripts, executable URLs, or unsanitized user HTML.

All untrusted proposal and comment Markdown is rendered as React elements by
`SafeMarkdown`, with `rehype-sanitize`, restricted URL protocols and bidi
override removal. New direct `dangerouslySetInnerHTML`, `innerHTML =`, or
`insertAdjacentHTML` writes fail the frontend ESLint CI job.

To enforce Trusted Types in a *staging* response, first deploy:

```text
Content-Security-Policy-Report-Only: require-trusted-types-for 'script'; trusted-types zkvote-escaped-text; report-to csp-endpoint
```

Then triage genuine violations (including third-party library operations)
before changing to an enforcing `Content-Security-Policy` header. **Do not**
add a permissive default policy to silence violations. Track staging report
rates before/after the change; no runtime CSP violation reduction is claimed
until that measurement exists (dependency ZV-098).
