import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { hashPassword } from '../server/auth.js';

const USERNAME = 'cinema-admin';
const PASSWORD = 'A-very-strong-test-password-2026!';
const SECRET = 'test-session-secret-that-is-longer-than-32-characters';

let server;
let baseUrl;
let passwordHash;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(env.port), ADMIN_USERNAME: USERNAME, ADMIN_PASSWORD_HASH: passwordHash, SESSION_SECRET: SECRET, ...env.extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitForServer(url, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

function client() {
  const jar = new Map();
  return {
    jar,
    async request(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' });
      const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const raw of setCookies) {
        const [pair, ...attributes] = raw.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (!value || attributes.some((attribute) => attribute.trim().toLowerCase() === 'max-age=0')) jar.delete(name);
        else jar.set(name, value);
      }
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status, headers: response.headers, body, setCookies };
    },
  };
}

const login = (api, password = PASSWORD, forwardedFor) => api.request('/api/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}) },
  body: JSON.stringify({ username: USERNAME, password }),
});

before(async () => {
  passwordHash = hashPassword(PASSWORD);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = startServer({ port });
  await waitForServer(`${baseUrl}/index.html`);
});

after(() => {
  server?.kill();
});

test('home page includes Google Search Console verification meta tag in head', async () => {
  const response = await fetch(`${baseUrl}/`, { headers: { accept: 'text/html' } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(
    html,
    /<head>[\s\S]*<meta\s+name="google-site-verification"\s+content="6nwKbe3UwHbbzzDg0S8a6TRE_rEEIAdyGgIJD6q6ua4"\s*\/?>[\s\S]*<\/head>/,
  );
});

test('anonymous session is not authenticated', async () => {
  const response = await fetch(`${baseUrl}/api/admin/session`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false });
});

test('wrong password is rejected and sets no session', async () => {
  const api = client();
  const response = await login(api, 'wrong-password', '198.51.100.1');
  assert.equal(response.status, 401);
  assert.equal(api.jar.size, 0);
});

test('wrong username is rejected', async () => {
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.2' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(response.status, 401);
});

test('correct credentials issue an HttpOnly session cookie', async () => {
  const api = client();
  const response = await login(api);
  assert.equal(response.status, 200);
  assert.equal(response.body.authenticated, true);
  const cookie = response.setCookies.join(';');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, new RegExp(PASSWORD));

  const session = await api.request('/api/admin/session');
  assert.deepEqual(session.body, { authenticated: true, username: USERNAME });
});

test('a forged or tampered cookie is rejected', async () => {
  const forged = Buffer.from(JSON.stringify({ sub: USERNAME, exp: Date.now() + 60000 })).toString('base64url');
  const response = await fetch(`${baseUrl}/api/admin/session`, {
    headers: { cookie: `cinema_admin_session=${forged}.invalidsignature` },
  });
  assert.deepEqual(await response.json(), { authenticated: false });
});

test('Secure is added when the request arrives over https', async () => {
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-For': '198.51.100.3',
    },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.getSetCookie().join(';'), /Secure/);
});

test('logout clears the session', async () => {
  const api = client();
  await login(api);
  assert.equal((await api.request('/api/admin/session')).body.authenticated, true);
  const logout = await api.request('/api/admin/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  assert.equal((await api.request('/api/admin/session')).body.authenticated, false);
});

test('cross-origin login attempts are refused', async () => {
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
      'X-Forwarded-For': '198.51.100.4',
    },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  assert.equal(response.status, 403);
});

test('unsupported methods and unknown endpoints are rejected', async () => {
  assert.equal((await fetch(`${baseUrl}/api/admin/login`)).status, 405);
  assert.equal((await fetch(`${baseUrl}/api/admin/unknown`)).status, 404);
});

test('repeated failures are rate limited, even with the right password', async () => {
  const ip = '198.51.100.5';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await login(client(), 'wrong', ip);
    assert.equal(response.status, 401);
  }
  const blocked = await login(client(), PASSWORD, ip);
  assert.equal(blocked.status, 429);
});

test('the site stays public while admin login is closed when unconfigured', async () => {
  const port = await freePort();
  const unconfigured = startServer({ port, extra: { ADMIN_PASSWORD_HASH: '', SESSION_SECRET: '', ADMIN_USERNAME: '' } });
  try {
    await waitForServer(`http://127.0.0.1:${port}/index.html`);
    const home = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: 'text/html' } });
    assert.equal(home.status, 200);
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(response.status, 503);
  } finally {
    unconfigured.kill();
  }
});
