// Level 5: max 5 booking attempts per email per minute (sliding window), failed ones included.
// Stored in Postgres, not memory, so the limit holds across serverless instances.
import { withTransaction } from './db.js';

export const MAX_ATTEMPTS = 5;
export const WINDOW_SECONDS = 60;

// Records an attempt if under the limit. Returns { allowed: true } or
// { allowed: false, retryAfter } in whole seconds.
export async function takeBookingAttempt(email) {
  return withTransaction(async (client) => {
    // Requests for the same email queue up here, one at a time, so six requests
    // arriving at the same instant can't all see "4 attempts so far".
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 5))', [
      `booking-attempts:${email}`,
    ]);

    // Forget attempts older than the window.
    await client.query(
      `DELETE FROM booking_attempts
        WHERE email = $1 AND attempted_at <= now() - make_interval(secs => $2)`,
      [email, WINDOW_SECONDS]
    );

    const { rows } = await client.query(
      `SELECT count(*)::int AS attempts,
              EXTRACT(EPOCH FROM min(attempted_at) + make_interval(secs => $2) - now())::float8
                AS seconds_until_oldest_expires
         FROM booking_attempts
        WHERE email = $1`,
      [email, WINDOW_SECONDS]
    );
    const { attempts, seconds_until_oldest_expires: wait } = rows[0];

    if (attempts >= MAX_ATTEMPTS) {
      // Rejected attempts aren't recorded, so Retry-After stays accurate:
      // once the oldest attempt leaves the window, the next one will go through.
      return { allowed: false, retryAfter: Math.max(1, Math.ceil(wait)) };
    }

    await client.query('INSERT INTO booking_attempts (email) VALUES ($1)', [email]);
    return { allowed: true };
  });
}
