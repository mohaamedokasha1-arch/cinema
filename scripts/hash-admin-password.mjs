#!/usr/bin/env node
// Creates the ADMIN_PASSWORD_HASH value used by the admin login API.
// Usage:
//   npm run admin:hash -- --generate     # creates a strong password + hash
//   ADMIN_PASSWORD='...' npm run admin:hash
// The plain password and the hash are printed locally only. Never commit them:
// store them in the hosting provider's secret/environment settings (or .env.local).
import crypto from 'node:crypto';
import readline from 'node:readline';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function strongPassword(length = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+';
  const bytes = crypto.randomBytes(length * 3);
  let output = '';
  for (const byte of bytes) {
    if (output.length >= length) break;
    if (byte < 256 - (256 % alphabet.length)) output += alphabet[byte % alphabet.length];
  }
  return output;
}

async function askPassword() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const answer = await new Promise((resolve) => rl.question('New admin password: ', resolve));
  rl.close();
  return answer;
}

async function main() {
  const generate = process.argv.includes('--generate');
  const password = generate ? strongPassword() : process.env.ADMIN_PASSWORD || (await askPassword());
  if (!password || password.length < 12) {
    console.error('Choose a password with at least 12 characters.');
    process.exit(1);
  }
  console.log('');
  if (generate) console.log(`Password        : ${password}`);
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
  console.log(`SESSION_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
  console.log('');
  console.log('Add both values to the hosting environment (or .env.local), then restart.');
  console.log('Treat this output as a secret: do not commit it or paste it into the site code.');
}

main();
