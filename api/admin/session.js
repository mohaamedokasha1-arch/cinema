import { handleSession } from '../../server/auth.js';

export default function handler(req, res) {
  return handleSession(req, res);
}
