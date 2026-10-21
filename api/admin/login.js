import { handleLogin } from '../../server/auth.js';

export default async function handler(req, res) {
  return handleLogin(req, res);
}
