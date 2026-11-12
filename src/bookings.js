// Bookings: create (levels 1–5), get (1), cancel (3), list a person's bookings (4).
import { randomBytes } from 'node:crypto';
import { query } from './db.js';
import { HttpError } from './http.js';
import { parseNewBooking, normalizeEmail } from './validation.js';
import { takeBookingAttempt } from './rateLimit.js';
import { fingerprint, claimKey, saveResponse, releaseKey } from './idempotency.js';

const BOOKING_COLUMNS = `id, slot_id, name, email, status,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;


// Create Booking
export async function createBooking({ req, body }) {
  const key = idempotencyKeyFrom(req);
  if (!key) return attemptBooking(body);

  // Level 4: same key + same body => same response; same key + different body => 422.
  const claim = await claimKey(key, fingerprint(body));
  if (claim.replay) return claim.replay;

  try {
    const result = await attemptBooking(body);
    if (result.status === 429) {
      await releaseKey(key); // being rate limited isn't a final answer; let a later retry run
    } else {
      await saveResponse(key, result);
    }
    return result;
  } catch (err) {
    await releaseKey(key).catch(() => {});
    throw err;
  }
}

// One booking attempt. Expected failures (400/404/409/429) return as results, not
// exceptions, so they can be saved for idempotent replay.
async function attemptBooking(body) {
  try {
    // Level 5: count every attempt for this email, valid or not.
    const email = normalizeEmail(body?.email);
    if (email) {
      const limit = await takeBookingAttempt(email);
      if (!limit.allowed) {
        throw new HttpError(429, 'too many booking attempts for this email, try again later', {
          'Retry-After': String(limit.retryAfter),
        });
      }
    }

    return await insertBooking(parseNewBooking(body)); // Level 2 validation
  } catch (err) {
    if (err instanceof HttpError) {
      return { status: err.status, body: { error: err.message }, headers: err.headers };
    }
    throw err;
  }
}

async function insertBooking({ slotId, name, email }) {
  const { rows } = await query('SELECT start_at <= now() AS started FROM slots WHERE id = $1', [
    slotId,
  ]);
  if (rows.length === 0) throw new HttpError(404, 'slot not found');
  if (rows[0].started) throw new HttpError(400, 'slot has already started');

  const booking = {
    id: newBookingId(),
    slot_id: slotId,
    name,
    email,
    status: 'confirmed',
    created_at: new Date().toISOString(),
  };

  try {
    await query(
      `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [booking.id, booking.slot_id, booking.name, booking.email, booking.status, booking.created_at]
    );
  } catch (err) {
    // Level 3: the unique index allows only one confirmed booking per slot.
    // If two requests race, Postgres lets exactly one insert through.
    if (err.code === '23505' && err.constraint === 'bookings_one_confirmed_per_slot') {
      throw new HttpError(409, 'slot is already booked');
    }
    if (err.code === '23503') throw new HttpError(404, 'slot not found'); // slots were just reset
    throw err;
  }

  return { status: 201, body: booking };
}

// Booking id doubles as the reference shown at reception: BK-XXXX-XXXX-XXXX.
// The alphabet skips I, L, O, U to avoid mix-ups; 60 random bits make it unguessable.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newBookingId() {
  const chars = [...randomBytes(12)].map((byte) => ALPHABET[byte & 31]).join('');
  return `BK-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

function idempotencyKeyFrom(req) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim() === '') return null;
  if (key.length > 255) throw new HttpError(400, 'Idempotency-Key is too long (max 255 characters)');
  return key;
}

// Get Booking
export async function getBooking({ params }) {
  const { rows } = await query(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`, [params.id]);
  if (rows.length === 0) throw new HttpError(404, 'booking not found');
  return { status: 200, body: rows[0] };
}

// Cancel Booking
export async function cancelBooking({ params }) {
  // Only flips confirmed -> cancelled, so two cancels at once can't both succeed.
  const { rows } = await query(
    `UPDATE bookings SET status = 'cancelled'
      WHERE id = $1 AND status = 'confirmed'
      RETURNING ${BOOKING_COLUMNS}`,
    [params.id]
  );
  if (rows.length === 1) return { status: 200, body: rows[0] };

  const existing = await query('SELECT 1 FROM bookings WHERE id = $1', [params.id]);
  if (existing.rows.length === 0) throw new HttpError(404, 'booking not found');
  throw new HttpError(409, 'booking is already cancelled');
}

// List Booking
export async function listBookings({ url }) {
  const email = normalizeEmail(url.searchParams.get('email'));
  if (!email) throw new HttpError(400, 'email query parameter is required');
  const limit = parseLimit(url.searchParams.get('limit'));
  const after = decodeCursor(url.searchParams.get('cursor'));

  // Keyset pagination: "everything after the last row you saw", ordered oldest first.
  // Fetch one extra row to know whether another page exists.
  const { rows } = await query(
    `SELECT ${BOOKING_COLUMNS}
       FROM bookings
      WHERE email = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::text))
      ORDER BY created_at, id
      LIMIT $4`,
    [email, after?.createdAt ?? null, after?.id ?? null, limit + 1]
  );

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  return {
    status: 200,
    body: { bookings: page, next_cursor: hasMore ? encodeCursor(last) : null },
  };
}

function parseLimit(raw) {
  if (raw === null) return 10;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'limit must be an integer from 1 to 50');
  const limit = Number(raw);
  if (limit < 1 || limit > 50) throw new HttpError(400, 'limit must be an integer from 1 to 50');
  return limit;
}

// The cursor is opaque to clients: base64url of [created_at, id] of the last row seen.
function encodeCursor(booking) {
  return Buffer.from(JSON.stringify([booking.created_at, booking.id])).toString('base64url');
}

function decodeCursor(raw) {
  if (raw === null || raw === '') return null;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof createdAt === 'string' && typeof id === 'string' && !Number.isNaN(Date.parse(createdAt))) {
      return { createdAt, id };
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid cursor');
}
