# TradeMind Broker Proxy

Production-hardened proxy layer for browser-based broker integrations with **Angel One**, **Groww**, **Zerodha**, and **Upstox**.

This project solves a real limitation in broker-connected browser apps: many broker APIs are designed for server-to-server usage and do not expose the CORS headers needed for direct browser access. TradeMind Broker Proxy sits between the frontend and the broker APIs so a browser-based dashboard can authenticate, fetch quotes, and request broker data through a controlled backend.

## Why this project exists

When building a browser-based live trading dashboard, direct frontend calls to broker APIs often fail even when credentials and endpoints are correct. The issue is not always the trading logic — it is the browser security model. If the API does not return `Access-Control-Allow-Origin`, the browser blocks the request.

This project fixes that problem by:

- Routing broker API requests through a lightweight Express proxy.
- Restricting allowed upstream hosts to approved broker domains.
- Enforcing origin allowlisting for the frontend.
- Adding API-key protection for the proxy layer.
- Applying rate limiting and request timeouts for safer public exposure.

## Architecture

```text
Browser frontend
   |
   |  POST /api/proxy
   v
TradeMind Broker Proxy (Express)
   |
   |  server-to-server broker requests
   v
Angel One / Groww / Zerodha / Upstox APIs
```

The frontend never calls the broker APIs directly. It calls the proxy, and the proxy forwards only approved HTTPS requests to known broker hosts.

## Features

- Broker CORS workaround for browser-based apps.
- HTTPS-only upstream validation.
- Broker host allowlist.
- Origin allowlisting through `ALLOWED_ORIGIN`.
- Proxy API-key authentication via `x-proxy-api-key`.
- Per-IP in-memory rate limiting.
- Upstream request timeouts using `AbortController`.
- Async Upstox gzip decompression.
- `/health` endpoint for deployment checks.
- Public-demo friendly hardening for portfolio usage.

## Tech stack

- Node.js 18+
- Express
- CORS middleware
- Native `fetch`
- `zlib` for instrument decompression

## Project structure

```text
trademind-broker-proxy/
├── server.js
├── package.json
├── .env.example
├── .gitignore
├── LICENSE
├── README.md
└── DEPLOYMENT.md
```

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Expected output:

```bash
TradeMind proxy listening on http://localhost:8787
```

## Environment variables

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Use `production` in deployed environments. |
| `PORT` | Server port. |
| `ALLOWED_ORIGIN` | Comma-separated frontend origins allowed to call the proxy. |
| `PROXY_API_KEY` | Required in production; clients must send this as `x-proxy-api-key`. |
| `REQUEST_TIMEOUT_MS` | Upstream broker request timeout in milliseconds. |
| `RATE_LIMIT_WINDOW_MS` | Rate-limit time window. |
| `RATE_LIMIT_MAX` | Max requests allowed per IP per window. |
| `UPSTOX_INSTRUMENTS_URL` | Override only if the Upstox instrument URL changes. |

## Frontend integration

Your frontend should send requests like this:

```js
const PROXY_BASE = 'https://your-proxy-host.com';
const PROXY_API_KEY = 'replace-with-your-key';

async function pfetch(payload) {
  const res = await fetch(`${PROXY_BASE}/api/proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-proxy-api-key': PROXY_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(`Proxy ${json.status || res.status}: ${JSON.stringify(json.data || json.error)}`);
  }
  return json.data;
}
```

## Security model

This project is designed for controlled demo/public exposure, not yet as a full multi-tenant SaaS backend.

What is already implemented:

- Strict production checks for `ALLOWED_ORIGIN` and `PROXY_API_KEY`.
- Allowed broker host enforcement.
- HTTPS-only upstream requests.
- Basic middleware authentication.
- Basic rate limiting.
- Timeout handling.
- No intentional credential logging.

What should be improved if this grows further:

- Replace shared proxy API key with user/session-based authentication.
- Move broker secrets fully server-side where broker flow permits.
- Add Redis-backed distributed rate limiting.
- Add persistent audit-safe observability.
- Introduce user-level usage isolation and quotas.

## Health check

```bash
curl http://localhost:8787/health
```

Expected response:

```json
{
  "ok": true,
  "env": "development",
  "strictOrigin": true,
  "authEnabled": true
}
```

## Deployment options

This works well on:

- Render
- Railway
- Fly.io
- VPS / Docker host

See `DEPLOYMENT.md` for a production deployment checklist.

## Portfolio positioning

This is a strong portfolio project because it demonstrates:

- Real-world product problem solving.
- Understanding of browser security constraints.
- Backend middleware design.
- Security hardening beyond a raw proof of concept.
- AI-assisted development with human review and architecture ownership.

## Known limitations

- This is not a brokerage platform and does not place trades by itself.
- Shared proxy API key is suitable for controlled exposure, not broad public multi-user production.
- Some broker login flows may still require additional hardening depending on the authentication architecture.

## License

MIT
