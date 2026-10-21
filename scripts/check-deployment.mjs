#!/usr/bin/env node
// Read-only smoke check for a deployment.
// Usage: npm run check:deploy -- https://cinema-el3arab.vercel.app
const base = (process.argv[2] || 'https://cinema-el3arab.vercel.app').replace(/\/+$/, '');
let failures = 0;

function report(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  console.log(`Checking ${base}\n`);

  const home = await fetch(base, { headers: { accept: 'text/html' } });
  const html = await home.text();
  report(home.ok, 'home page responds', `HTTP ${home.status}`);
  report(html.includes('id="root"'), 'SPA shell served');
  report(!/admin123|admin_demo|DEMO STUDIO/.test(html), 'no demo credentials in HTML');

  const asset = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
  report(Boolean(asset), 'index bundle referenced', asset || 'not found');
  if (asset) {
    const script = await fetch(`${base}${asset}`);
    const code = await script.text();
    report(script.ok, 'index bundle loads', `HTTP ${script.status}`);
    for (const marker of ['admin123', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET', 'scrypt$']) {
      report(!code.includes(marker), `bundle does not expose "${marker}"`);
    }
  }

  for (const poster of ['/images/cinema-hero.jpg', '/images/posters/dark-knight.webp', '/images/poster-fallback.svg']) {
    const response = await fetch(`${base}${poster}`);
    report(response.ok && (response.headers.get('content-type') || '').startsWith('image/'), `asset ${poster}`, `HTTP ${response.status}`);
  }

  for (const route of ['/watch/dark-knight', '/?type=series', '/admin/login']) {
    const response = await fetch(`${base}${route}`, { headers: { accept: 'text/html' } });
    report(response.ok, `route ${route}`, `HTTP ${response.status}`);
  }

  const session = await fetch(`${base}/api/admin/session`);
  const sessionBody = await session.json().catch(() => null);
  report(session.ok, 'admin session endpoint responds', `HTTP ${session.status}`);
  if (sessionBody?.available === false) {
    report(false, 'admin login configured', 'ADMIN_PASSWORD_HASH / SESSION_SECRET are missing on this deployment');
  } else {
    report(sessionBody?.authenticated === false, 'anonymous visitor has no admin session');
  }

  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'not-the-admin', password: 'not-the-password' }),
  });
  report([401, 429].includes(login.status), 'admin login rejects unknown credentials', `HTTP ${login.status}`);

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Deployment check failed:', error.message);
  process.exit(1);
});
