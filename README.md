# Ìlera Clinic booking

A clinic appointment booking API and the web page that uses it. Built for Task 1 of the Koya Cohort 4 assessment, following the [technical spec](https://koyaacademy.com/assessment-api) exactly.

- **API base URL:** `https://clinic-booking-api-gamma.vercel.app/api`
- **Web page:** `https://clinic-booking-api-gamma.vercel.app`

All five levels are implemented. `scripts/check.mjs` runs 60 end-to-end checks against any deployment (see [Testing](#testing)).

## Stack

| Piece | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 20+, no framework | The API is six routes; a 40-line router keeps every line easy to follow. One dependency (`pg`). |
| Database | Postgres (Neon) | Constraints and transactions make the concurrency guarantees hold across every server instance, not just inside one process. |
| Hosting | Vercel | HTTPS by default, static page served from the CDN, and no server that goes to sleep on the free plan. |
| Web page | Plain HTML, CSS and JavaScript | No build step; loads fast on a phone. |

## How each level works

**Level 1 – list, book, look up** (`src/slots.js`, `src/bookings.js`)
`POST /reset` replaces all slots in one transaction. Slots keep the exact `start`/`end` strings they were given and are returned unchanged, sorted by the parsed time. `available` is computed live: a slot is unavailable while it has a confirmed booking.

**Level 2 – API key and validation** (`src/auth.js`, `src/validation.js`)
Every `/api` request is checked for `X-API-Key` before anything else (constant-time comparison, so timing doesn't leak the key). Booking bodies are validated in a fixed order: required, non-empty strings → valid email → slot exists (404) → slot hasn't started (400). Name and email are trimmed; email is stored lower-case.

**Level 3 – no double booking, cancellation**
A partial unique index allows only one *confirmed* booking per slot:

```sql
CREATE UNIQUE INDEX bookings_one_confirmed_per_slot ON bookings (slot_id) WHERE status = 'confirmed';
```

If 25 requests for the same slot arrive at the same instant, Postgres lets exactly one insert through and the rest get `23505`, which becomes a 409. No read-then-write gap, no in-memory locks. Cancelling is a single `UPDATE … WHERE status = 'confirmed'`, so it frees the slot (the index no longer covers that row) and a second cancel gets 409.

**Level 4 – idempotent retries, pagination** (`src/idempotency.js`)
The first request with an `Idempotency-Key` claims it with `INSERT … ON CONFLICT DO NOTHING` (atomic, thanks to the primary key), runs, and saves its status and body. Retries with the same body get the saved response, and identical concurrent retries wait briefly for the first to finish. A different body gets 422. Bodies are compared by a hash of canonical JSON, so key order and whitespace don't matter. Error responses (400/404/409) are replayed too; a 429 or a crash releases the key so a later retry can run.

`GET /bookings?email=` uses keyset pagination: the cursor is an opaque base64url of the last row's `(created_at, id)`, and the next page is `WHERE (created_at, id) > cursor`. Unlike offsets, pages don't skip or repeat rows when bookings are added in between.

**Level 5 – rate limit** (`src/rateLimit.js`)
A sliding window of 5 attempts per email per 60 seconds, stored in Postgres so it holds across every serverless instance. A per-email advisory lock serialises the check-and-record step, so a burst of simultaneous requests can't all slip under the limit. Every attempt counts (failed ones included), keyed on the normalised email. `Retry-After` is the whole seconds until the oldest attempt leaves the window.

## Judgment calls

- **`/reset` is a clean slate.** It also clears saved idempotency responses (they point at deleted bookings) and rate-limit history.
- **Idempotent replays don't count towards the rate limit.** A retry is the same attempt, not a new one, so a client recovering from a dropped connection isn't punished.
- **Rejected (429) attempts aren't recorded**, so `Retry-After` is accurate: wait that long and the next attempt goes through.
- **Booking ids are short references** (`BK-7F3K-9Q2M-XD4P`): 60 random bits from an alphabet without I/L/O/U, easy to read out at a reception desk and not guessable.
- **The web page never sees the API key.** It calls `/web/*` routes on the same server, which run the same functions (validation, 409s, idempotency, rate limit) without the key check. `/reset` and "list bookings by email" are deliberately not exposed there: without patient accounts, anyone could list anyone's bookings.
- **Vercel rewrites carry the route in the query.** The function can't see the original URL, so `vercel.json` sends `/api/*` and `/web/*` as `?scope=...&path=...` and `src/app.js` rebuilds the real path before routing.

## Project layout

```
vercel.json           Rewrites /api/* and /web/* to the single function below
api/index.js          Vercel function entry
server.js             Plain Node server for local dev or hosts like Render
src/app.js            Routing, API-key check, error handling
src/db.js             Pool, transactions, schema (created automatically on first request)
src/slots.js          POST /reset, GET /slots
src/bookings.js       Create, get, cancel, list
src/validation.js     Booking body rules
src/idempotency.js    Idempotency-Key claim / replay
src/rateLimit.js      5 attempts per email per minute
src/demoSlots.js      Two weeks of demo slots (seeded into a new database)
public/               The web page
scripts/check.mjs     End-to-end checks for all five levels
scripts/seed.mjs      Reset to the demo slots
```

## Running locally

```bash
npm install
cp .env.example .env   # set DATABASE_URL (any Postgres) and API_KEY
npm run dev            # http://localhost:3000
```

Tables are created on the first request, and a new database gets demo slots.

## Deploying (Vercel + Neon)

1. Push this repo to GitHub.
2. In Vercel, **Add New → Project**, import the repo. Leave the framework preset as **Other** with no build command.
3. In the project's **Storage** tab, create a **Neon** Postgres database and connect it. Leave the **Custom Prefix** empty so `DATABASE_URL` is set. Leave the database-branch boxes unticked.
4. In **Settings → Environment Variables**, add `API_KEY` with a long random value:
   `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
5. Redeploy so the new variables apply. Use the production domain (`<project>.vercel.app`); preview URLs can require a Vercel login.

## Testing

```bash
node scripts/check.mjs https://<your-project>.vercel.app/api <API_KEY>
```

This runs 60 checks across all five levels, including 25 simultaneous bookings for one slot, 10 simultaneous retries with one idempotency key, and a burst of 10 attempts against the rate limit. It calls `/reset`, so it deletes existing bookings, and re-seeds the demo slots when it finishes.

## What I'd add next

- Expire idempotency keys after 24 hours with a scheduled cleanup.
- A per-IP limit alongside the per-email one, since someone spamming can rotate emails.
- Patient sign-in, so the page could safely show "my bookings".
