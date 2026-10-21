import { handleLogout } from '../../server/auth.js';

export default function handler(req, res) {
  return handleLogout(req, res);
}
