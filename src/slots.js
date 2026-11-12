// Level 1: replace all slots (POST /reset) and list them (GET /slots).
import { query, withTransaction, insertSlots } from './db.js';
import { HttpError, isPlainObject } from './http.js';

export async function resetSlots({ body }) {
  const slots = parseSlots(body);

  await withTransaction(async (client) => {
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM idempotency_keys');
    await client.query('DELETE FROM booking_attempts');
    await client.query('DELETE FROM slots');
    await insertSlots(client, slots);
  });

  return { status: 200, body: { ok: true, slots: slots.length } };
}

export async function listSlots({ url }) {
  const provider = url.searchParams.get('provider');

  const { rows } = await query(
    `SELECT s.id, s.provider, s.start_raw AS start, s.end_raw AS "end",
            NOT EXISTS (
              SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
            ) AS available
       FROM slots s
      WHERE $1::text IS NULL OR s.provider = $1
      ORDER BY s.start_at, s.id`,
    [provider]
  );

  return { status: 200, body: { slots: rows } };
}

function parseSlots(body) {
  if (!isPlainObject(body) || !Array.isArray(body.slots)) {
    throw new HttpError(400, 'body must be {"slots": [...]}');
  }
  const seen = new Set();
  body.slots.forEach((slot, i) => {
    const where = `slots[${i}]`;
    if (!isPlainObject(slot)) throw new HttpError(400, `${where} must be an object`);
    for (const field of ['id', 'provider', 'start', 'end']) {
      if (typeof slot[field] !== 'string' || slot[field].trim() === '') {
        throw new HttpError(400, `${where}.${field} must be a non-empty string`);
      }
    }
    for (const field of ['start', 'end']) {
      if (Number.isNaN(Date.parse(slot[field]))) {
        throw new HttpError(400, `${where}.${field} must be a date-time`);
      }
    }
    if (seen.has(slot.id)) throw new HttpError(400, `duplicate slot id "${slot.id}"`);
    seen.add(slot.id);
  });
  return body.slots;
}
