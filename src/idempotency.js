// Level 4: a retry with the same Idempotency-Key never creates a second booking.
// The first request claims the key in Postgres and saves its response; retries replay it.
import { createHash } from 'node:crypto';
import { query } from './db.js';
import { HttpError } from './http.js';

const WAIT_FOR_FIRST_REQUEST_MS = 5_000;
const POLL_MS = 100;

// Stable hash of the body, so key order or spacing doesn't matter.
export function fingerprint(body) {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Claims the key for this request, or returns the response saved by an earlier one.
// Throws 422 if the key was already used with a different body.
export async function claimKey(key, hash) {
  const deadline = Date.now() + WAIT_FOR_FIRST_REQUEST_MS;

  for (;;) {
    const inserted = await query(
      `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, hash]
    );
    if (inserted.rowCount === 1) return { claimed: true };

    // Someone used this key before (or is using it right now).
    const { rows } = await query(
      'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1',
      [key]
    );
    const existing = rows[0];

    if (existing) {
      if (existing.request_hash !== hash) {
        throw new HttpError(422, 'Idempotency-Key was already used with a different request body');
      }
      if (existing.status_code !== null) {
        return {
          replay: {
            status: Number(existing.status_code),
            body: JSON.parse(existing.response_body),
            headers: { 'Idempotency-Replayed': 'true' },
          },
        };
      }
    }
    // The first request is still running (or gave up its claim): wait and look again.
    if (Date.now() > deadline) {
      throw new HttpError(409, 'a request with this Idempotency-Key is still being processed');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export async function saveResponse(key, result) {
  await query(
    'UPDATE idempotency_keys SET status_code = $2, response_body = $3 WHERE key = $1',
    [key, result.status, JSON.stringify(result.body)]
  );
}

// Frees the key so a later retry can run fresh (used for 429s and crashes).
export async function releaseKey(key) {
  await query('DELETE FROM idempotency_keys WHERE key = $1 AND status_code IS NULL', [key]);
}
