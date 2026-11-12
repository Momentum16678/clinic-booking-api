// Postgres connection pool, transactions, and the schema.
import pg from 'pg';
import { HttpError } from './http.js';
import { demoSlots } from './demoSlots.js';

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new HttpError(500, 'server misconfigured: DATABASE_URL is not set');
    }
    // Small pool: on serverless hosts each instance gets its own pool.
    pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
    pool.on('error', (err) => console.error('idle database client error', err));
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

// Runs fn inside BEGIN/COMMIT and rolls back if it throws.
export async function withTransaction(fn) {
  const client = await getPool().connect();
  let failed = null;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    failed = err;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release(failed && !(failed instanceof HttpError) ? failed : undefined);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text NOT NULL,
  start_at  timestamptz NOT NULL,   -- used for sorting and "has it started?"
  end_at    timestamptz NOT NULL,
  start_raw text NOT NULL,          -- the exact strings we were given, returned unchanged
  end_raw   text NOT NULL
);
CREATE INDEX IF NOT EXISTS slots_start_idx ON slots (start_at, id);

CREATE TABLE IF NOT EXISTS bookings (
  id         text PRIMARY KEY,
  slot_id    text NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text NOT NULL,
  status     text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL
);
-- Level 3: the database itself refuses a second confirmed booking for a slot,
-- so two requests arriving at the same instant can't both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
-- Level 4: "list a person's bookings, oldest first" walks this index.
CREATE INDEX IF NOT EXISTS bookings_email_created_idx ON bookings (email, created_at, id);

-- Level 4: one row per Idempotency-Key, holding the response we sent for it.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           text PRIMARY KEY,
  request_hash  text NOT NULL,
  status_code   integer,            -- NULL while the first request is still running
  response_body text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Level 5: recent booking attempts per email, for the rate limit.
CREATE TABLE IF NOT EXISTS booking_attempts (
  id           bigserial PRIMARY KEY,
  email        text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_idx ON booking_attempts (email, attempted_at);
`;

// Inserts slots ({id, provider, start, end}) using the given client.
export async function insertSlots(client, slots) {
  if (slots.length === 0) return;
  const rows = slots.map((s) => ({
    id: s.id,
    provider: s.provider,
    start_at: new Date(s.start).toISOString(),
    end_at: new Date(s.end).toISOString(),
    start_raw: s.start,
    end_raw: s.end,
  }));
  await client.query(
    `INSERT INTO slots (id, provider, start_at, end_at, start_raw, end_raw)
     SELECT id, provider, start_at, end_at, start_raw, end_raw
     FROM jsonb_to_recordset($1::jsonb)
       AS x(id text, provider text, start_at timestamptz, end_at timestamptz, start_raw text, end_raw text)`,
    [JSON.stringify(rows)]
  );
}

let schemaReady = null;

// Creates the tables on first use (once per instance), and seeds demo slots
// into a brand-new database so the web page has something to show.
export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = withTransaction(async (client) => {
      // Lock so two instances starting at once don't race each other.
      await client.query('SELECT pg_advisory_xact_lock(7262021)');
      const { rows } = await client.query(
        "SELECT to_regclass('public.slots') IS NOT NULL AS already_exists"
      );
      await client.query(SCHEMA);
      if (!rows[0].already_exists) await insertSlots(client, demoSlots());
    }).catch((err) => {
      schemaReady = null; // try again on the next request
      throw err;
    });
  }
  return schemaReady;
}
