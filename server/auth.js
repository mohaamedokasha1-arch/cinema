// Server-side authentication for the admin panel.
// Credentials live ONLY in environment variables (never in the client bundle):
//   ADMIN_USERNAME       - optional, defaults to "admin"
//   ADMIN_PASSWORD_HASH  - scrypt hash produced by `npm run admin:hash`
//   SESSION_SECRET       - random secret (32+ chars) used to sign session cookies
// The admin session is an HttpOnly, SameSite=Strict, signed cookie that the
// client cannot read or forge. Every admin API call is verified on the server.
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'cinema_admin_session';

const SESSION_TTL_SECONDS = 8 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const MAX_BODY_BYTES = 4096;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// In-memory rate limiting. Serverless instances may be recycled, so this is a
// first line of defence on top of the cost of scrypt and the signed session.
const failedAttempts = new Map();

function envValue(name) {
  return String(process.env[name] || '').trim();
}

export function authConfig() {
  const passwordHash = envValue('ADMIN_PASSWORD_HASH');
  const sessionSecret = envValue('SESSION_SECRET');
  return {
    username: envValue('ADMIN_USERNAME') || 'admin',
    passwordHash,
    sessionSecret,
    configured: Boolean(passwordHash && sessionSecret && sessionSecret.length >= 32),
  };
}

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, storedHash) {
  try {
    const parts = String(storedHash || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, rawN, rawR, rawP, saltBase64, keyBase64] = parts;
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    const salt = Buffer.from(saltBase64, 'base64');
    const expected = Buffer.from(keyBase64, 'base64');
    if (!Number.isInteger(N) || N < 4096 || N > 262144) return false;
    if (!Number.isInteger(r) || r < 1 || r > 32) return false;
    if (!Number.isInteger(p) || p < 1 || p > 16) return false;
    if (!salt.length || !expected.length) return false;
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N, r, p, maxmem: 128 * 1024 * 1024,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionToken(username, secret) {
  const issuedAt = Date.now();
  const payload = Buffer.from(JSON.stringify({
    sub: username,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_MS,
  })).toString('base64url');
  return `${payload}.${signPayload(payload, secret)}`;
}

export function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;
  const expected = signPayload(payload, secret);
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(provided, expectedBuffer)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.sub !== 'string' || !data.sub) return null;
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const jar = {};
  if (!header || typeof header !== 'string') return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || jar[name] !== undefined) continue;
    jar[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

export function getSession(req) {
  const { sessionSecret } = authConfig();
  if (!sessionSecret) return null;
  return verifySessionToken(parseCookies(req.headers?.cookie)[SESSION_COOKIE], sessionSecret);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function isSecureRequest(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket?.encrypted);
}

function sessionCookie(req, value, maxAgeSeconds) {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) attributes.push('Secure');
  return attributes.join('; ');
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  // Requests without an Origin header (server-to-server, curl) cannot perform
  // cookie-based CSRF; browsers always send Origin on cross-site POSTs.
  if (!origin) return true;
  try {
    const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '')
      .split(',')[0].trim();
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function clientKey(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function isBlocked(key) {
  const entry = failedAttempts.get(key);
  if (!entry) return false;
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) return true;
  if (entry.blockedUntil && entry.blockedUntil <= Date.now()) {
    failedAttempts.delete(key);
    return false;
  }
  if (Date.now() - entry.first > FAILURE_WINDOW_MS) {
    failedAttempts.delete(key);
    return false;
  }
  return false;
}

function recordFailure(key) {
  const now = Date.now();
  if (failedAttempts.size > 1000) {
    for (const [entryKey, entry] of failedAttempts) {
      const expired = entry.blockedUntil ? entry.blockedUntil <= now : now - entry.first > FAILURE_WINDOW_MS;
      if (expired) failedAttempts.delete(entryKey);
    }
  }
  const entry = failedAttempts.get(key);
  if (!entry || now - entry.first > FAILURE_WINDOW_MS) {
    failedAttempts.set(key, { first: now, count: 1, blockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) entry.blockedUntil = now + BLOCK_MS;
}

function clearFailures(key) {
  failedAttempts.delete(key);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return new Promise((resolve) => {
    let raw = '';
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        aborted = true;
        resolve(null);
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

export async function handleLogin(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    return;
  }
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'forbidden_origin' });
    return;
  }
  const config = authConfig();
  if (!config.configured) {
    sendJson(res, 503, { error: 'auth_not_configured' });
    return;
  }
  const key = clientKey(req);
  if (isBlocked(key)) {
    sendJson(res, 429, { error: 'too_many_attempts' }, { 'Retry-After': '900' });
    return;
  }
  const body = await readJsonBody(req);
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password || username.length > 120 || password.length > 240) {
    recordFailure(key);
    sendJson(res, 401, { error: 'invalid_credentials' });
    return;
  }
  // Always run the hash comparison so timing does not reveal whether the
  // username exists.
  const passwordMatches = verifyPassword(password, config.passwordHash);
  const usernameMatches = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(username).digest(),
    crypto.createHash('sha256').update(config.username).digest(),
  );
  if (!passwordMatches || !usernameMatches) {
    recordFailure(key);
    sendJson(res, 401, { error: 'invalid_credentials' });
    return;
  }
  clearFailures(key);
  const token = createSessionToken(config.username, config.sessionSecret);
  sendJson(res, 200, { authenticated: true, username: config.username }, {
    'Set-Cookie': sessionCookie(req, token, SESSION_TTL_SECONDS),
  });
}

export function handleLogout(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    return;
  }
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'forbidden_origin' });
    return;
  }
  sendJson(res, 200, { authenticated: false }, {
    'Set-Cookie': sessionCookie(req, '', 0),
  });
}

export function handleSession(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    return;
  }
  const config = authConfig();
  if (!config.configured) {
    sendJson(res, 503, { authenticated: false, available: false });
    return;
  }
  const session = getSession(req);
  if (!session) {
    sendJson(res, 200, { authenticated: false });
    return;
  }
  sendJson(res, 200, { authenticated: true, username: session.sub });
}

// Shared entry point for Vercel functions, the Node server and the Vite dev server.
export async function handleApiRequest(req, res, pathname) {
  const path = String(pathname || '').replace(/\/+$/, '');
  if (path === '/api/admin/login') return handleLogin(req, res);
  if (path === '/api/admin/logout') return handleLogout(req, res);
  if (path === '/api/admin/session') return handleSession(req, res);
  return sendJson(res, 404, { error: 'not_found' });
}
