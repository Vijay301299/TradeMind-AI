const express = require('express');
const cors = require('cors');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const app = express();
const PORT = Number(process.env.PORT || 8787);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const UPSTOX_INSTRUMENTS_URL = process.env.UPSTOX_INSTRUMENTS_URL || 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

if (NODE_ENV === 'production' && ALLOWED_ORIGIN === '*') {
  throw new Error('Refusing to start in production with ALLOWED_ORIGIN="*". Set a strict frontend origin.');
}

if (NODE_ENV === 'production' && !PROXY_API_KEY) {
  throw new Error('Refusing to start in production without PROXY_API_KEY.');
}

const allowedOrigins = ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '1mb' }));

const ALLOWED_HOSTS = new Set([
  'apiconnect.angelone.in',
  'margincalculator.angelbroking.com',
  'api.groww.in',
  'api.kite.trade',
  'api.upstox.com',
  'assets.upstox.com'
]);

const rateStore = new Map();

function cleanupRateStore(now) {
  for (const [key, value] of rateStore.entries()) {
    if (now > value.resetAt) rateStore.delete(key);
  }
}

function rateLimit(req, res, next) {
  const now = Date.now();
  cleanupRateStore(now);
  const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const existing = rateStore.get(key);

  if (!existing || now > existing.resetAt) {
    rateStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', RATE_LIMIT_MAX - 1);
    return next();
  }

  if (existing.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Please try again later.' });
  }

  existing.count += 1;
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - existing.count));
  next();
}

function requireApiKey(req, res, next) {
  if (!PROXY_API_KEY) return next();
  const token = req.get('x-proxy-api-key');
  if (!token || token !== PROXY_API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

function hostAllowed(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function sanitizeHeaders(input) {
  const safe = {};
  const blocked = new Set(['host', 'origin', 'referer', 'content-length', 'connection']);
  for (const [key, value] of Object.entries(input || {})) {
    const lower = key.toLowerCase();
    if (blocked.has(lower)) continue;
    safe[key] = value;
  }
  return safe;
}

function buildTimeoutSignal(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

function logProxyError(context, err, extra = {}) {
  console.error(JSON.stringify({
    level: 'error',
    context,
    message: err.message,
    ...extra,
    timestamp: new Date().toISOString()
  }));
}

app.use(rateLimit);
app.use(requireApiKey);

app.post('/api/proxy', async (req, res) => {
  const { url, method = 'GET', headers = {}, body, bodyType = 'json' } = req.body || {};

  if (!url || !hostAllowed(url)) {
    return res.status(400).json({ ok: false, error: 'URL missing, invalid, non-HTTPS, or host not allowed.' });
  }

  const normalizedMethod = String(method).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) {
    return res.status(400).json({ ok: false, error: 'HTTP method not allowed.' });
  }

  const outgoingHeaders = sanitizeHeaders(headers);
  const fetchOptions = { method: normalizedMethod, headers: outgoingHeaders };

  if (body !== undefined && normalizedMethod !== 'GET') {
    if (bodyType === 'form') {
      fetchOptions.body = typeof body === 'string' ? body : new URLSearchParams(body).toString();
      fetchOptions.headers['Content-Type'] = fetchOptions.headers['Content-Type'] || 'application/x-www-form-urlencoded';
    } else {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
      fetchOptions.headers['Content-Type'] = fetchOptions.headers['Content-Type'] || 'application/json';
    }
  }

  const { signal, clear } = buildTimeoutSignal(REQUEST_TIMEOUT_MS);
  fetchOptions.signal = signal;

  try {
    const brokerRes = await fetch(url, fetchOptions);
    const contentType = brokerRes.headers.get('content-type') || '';
    const raw = await brokerRes.text();
    let data;

    if (contentType.includes('application/json')) {
      try { data = JSON.parse(raw); } catch { data = raw; }
    } else {
      try { data = JSON.parse(raw); } catch { data = raw; }
    }

    return res.status(200).json({ ok: brokerRes.ok, status: brokerRes.status, data });
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    logProxyError('api_proxy', err, { targetHost: new URL(url).hostname, timedOut });
    return res.status(timedOut ? 504 : 502).json({
      ok: false,
      status: timedOut ? 504 : 502,
      error: timedOut ? 'Upstream request timed out.' : `Proxy fetch failed: ${err.message}`
    });
  } finally {
    clear();
  }
});

app.get('/api/upstox/instruments', async (req, res) => {
  const { signal, clear } = buildTimeoutSignal(REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(UPSTOX_INSTRUMENTS_URL, { signal });
    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: `Upstream returned ${upstream.status}` });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const unzipped = await gunzip(buf);
    const list = JSON.parse(unzipped.toString('utf8'));
    return res.status(200).json(list);
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    logProxyError('upstox_instruments', err, { timedOut });
    return res.status(timedOut ? 504 : 502).json({
      ok: false,
      error: timedOut ? 'Instrument download timed out.' : `Failed to fetch/decompress instruments: ${err.message}`
    });
  } finally {
    clear();
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    strictOrigin: ALLOWED_ORIGIN !== '*',
    authEnabled: Boolean(PROXY_API_KEY)
  });
});

app.listen(PORT, () => {
  console.log(`TradeMind proxy listening on http://localhost:${PORT}`);
  console.log(`Allowed frontend origin(s): ${ALLOWED_ORIGIN}`);
  console.log(`Proxy authentication enabled: ${Boolean(PROXY_API_KEY)}`);
});
