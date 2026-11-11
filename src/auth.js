// Level 2: every API request must carry the right X-API-Key header.
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';

export function requireApiKey(req) {
  const expected = process.env.API_KEY;
  if (!expected) throw new HttpError(500, 'server misconfigured: API_KEY is not set');

  const given = req.headers['x-api-key'];
  if (typeof given !== 'string' || !sameSecret(given, expected)) {
    throw new HttpError(401, 'missing or invalid API key');
  }
}

// Compare hashes in constant time so response timing doesn't leak the key.
function sameSecret(a, b) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
