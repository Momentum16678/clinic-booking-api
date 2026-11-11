#!/usr/bin/env node
// End-to-end checks for all five levels, run against any deployment.
//
//   node scripts/check.mjs https://your-app.vercel.app/api YOUR_API_KEY
//   (or set BASE_URL and API_KEY)
//
// WARNING: this calls POST /reset, which deletes every booking. When it finishes
// it re-seeds the demo slots so the web page has something to show.
import { demoSlots } from '../src/demoSlots.js';

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000/api').replace(/\/+$/, '');
const KEY = process.argv[3] || process.env.API_KEY;
if (!KEY) {
  console.error('Usage: node scripts/check.mjs <base-url> <api-key>');
  process.exit(2);
}

const RUN = Date.now().toString(36);
const email = (tag) => `${tag}-${RUN}@example.com`;
let passed = 0;
let failed = 0;

async function call(method, path, { body, key = KEY, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (key !== null) h['X-API-Key'] = key;
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? `\n      got: ${JSON.stringify(detail)}` : ''}`);
  }
}

const isError = (r) => r.body && typeof r.body.error === 'string';
const iso = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');

function fixtureSlots() {
  const slots = [];
  // Deliberately out of order, to check sorting.
  for (let i = 30; i >= 1; i--) {
    slots.push({
      id: `s${i}`,
      provider: i % 2 ? 'Dr Ade' : 'Dr Bello',
      start: iso(60 * 24 + i * 30),
      end: iso(60 * 24 + i * 30 + 30),
    });
  }
  slots.push({ id: 'past', provider: 'Dr Ade', start: iso(-120), end: iso(-90) });
  slots.push({ id: 'ongoing', provider: 'Dr Ade', start: iso(-10), end: iso(20) });
  return slots;
}

async function level1() {
  console.log('\nLevel 1: list slots, book one, look up a booking');
  const slots = fixtureSlots();
  const reset = await call('POST', '/reset', { body: { slots } });
  check('POST /reset returns 200', reset.status === 200, reset);

  const list = await call('GET', '/slots');
  const got = list.body?.slots ?? [];
  check('GET /slots returns 200 with every slot', list.status === 200 && got.length === slots.length, list.status);
  const sorted = got.every((s, i) => i === 0 || Date.parse(got[i - 1].start) <= Date.parse(s.start));
  check('slots are sorted earliest start first', sorted);
  const s1 = got.find((s) => s.id === 's1');
  const sent = slots.find((s) => s.id === 's1');
  check('slot fields come back exactly as sent', s1 && s1.provider === sent.provider && s1.start === sent.start && s1.end === sent.end, s1);
  check('slots have available: true before booking', got.every((s) => s.available === true));

  const filtered = await call('GET', '/slots?provider=' + encodeURIComponent('Dr Bello'));
  check('?provider= filters by exact match', filtered.body?.slots?.length === 15 && filtered.body.slots.every((s) => s.provider === 'Dr Bello'), filtered.body?.slots?.length);

  const b = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada Obi', email: email('l1') } });
  check('POST /bookings returns 201 with a confirmed booking', b.status === 201 && b.body?.status === 'confirmed' && b.body?.slot_id === 's1' && typeof b.body?.id === 'string', b);
  check('booking has created_at', typeof b.body?.created_at === 'string' && !Number.isNaN(Date.parse(b.body.created_at)), b.body);

  const fetched = await call('GET', `/bookings/${b.body?.id}`);
  check('GET /bookings/{id} returns the booking', fetched.status === 200 && fetched.body?.id === b.body?.id && fetched.body?.email === b.body?.email, fetched);
  const missing = await call('GET', '/bookings/does-not-exist');
  check('GET /bookings/{unknown} returns 404 {"error"}', missing.status === 404 && isError(missing), missing);

  const after = await call('GET', '/slots');
  check('booked slot shows available: false', after.body?.slots?.find((s) => s.id === 's1')?.available === false);
}

async function level2() {
  console.log('\nLevel 2: API key and validation');
  const noKey = await call('GET', '/slots', { key: null });
  check('missing X-API-Key returns 401 {"error"}', noKey.status === 401 && isError(noKey), noKey);
  const badKey = await call('GET', '/slots', { key: 'wrong-key' });
  check('wrong X-API-Key returns 401', badKey.status === 401, badKey.status);
  const badKeyPost = await call('POST', '/bookings', { key: 'wrong', body: { slot_id: 's2', name: 'X', email: email('l2k') } });
  check('wrong key can\'t book', badKeyPost.status === 401, badKeyPost.status);

  const cases = [
    ['missing slot_id', { name: 'Ada', email: email('l2a') }],
    ['missing name', { slot_id: 's2', email: email('l2b') }],
    ['missing email', { slot_id: 's2', name: 'Ada' }],
    ['empty name', { slot_id: 's2', name: '', email: email('l2c') }],
    ['whitespace-only name', { slot_id: 's2', name: '   ', email: email('l2d') }],
    ['empty slot_id', { slot_id: '', name: 'Ada', email: email('l2e') }],
    ['invalid email', { slot_id: 's2', name: 'Ada', email: 'not-an-email' }],
    ['email without domain dot', { slot_id: 's2', name: 'Ada', email: 'ada@example' }],
    ['email that is a number', { slot_id: 's2', name: 'Ada', email: 42 }],
  ];
  for (const [label, body] of cases) {
    const r = await call('POST', '/bookings', { body });
    check(`${label} returns 400`, r.status === 400 && isError(r), r);
  }
  const badJson = await call('POST', '/bookings', { raw: '{"slot_id": "s2",' });
  check('malformed JSON returns 400', badJson.status === 400 && isError(badJson), badJson);

  const unknown = await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'Ada', email: email('l2f') } });
  check('unknown slot returns 404', unknown.status === 404 && isError(unknown), unknown);
  const past = await call('POST', '/bookings', { body: { slot_id: 'past', name: 'Ada', email: email('l2g') } });
  check('slot in the past returns 400', past.status === 400 && isError(past), past);
  const ongoing = await call('POST', '/bookings', { body: { slot_id: 'ongoing', name: 'Ada', email: email('l2h') } });
  check('slot that has started (not ended) returns 400', ongoing.status === 400, ongoing);

  const messy = await call('POST', '/bookings', { body: { slot_id: 's2', name: '  Ada Obi  ', email: `  ${email('L2-Trim').toUpperCase()}  ` } });
  check('name and email are trimmed, email lower-cased', messy.status === 201 && messy.body?.name === 'Ada Obi' && messy.body?.email === email('l2-trim'), messy.body);
}

async function level3() {
  console.log('\nLevel 3: no double booking, cancellation');
  const first = await call('POST', '/bookings', { body: { slot_id: 's3', name: 'Ada', email: email('l3a') } });
  const second = await call('POST', '/bookings', { body: { slot_id: 's3', name: 'Bayo', email: email('l3b') } });
  check('booking a taken slot returns 409', first.status === 201 && second.status === 409 && isError(second), second);

  const racers = await Promise.all(
    Array.from({ length: 25 }, (_, i) => call('POST', '/bookings', { body: { slot_id: 's4', name: `Racer ${i}`, email: email(`race${i}`) } }))
  );
  const wins = racers.filter((r) => r.status === 201).length;
  const conflicts = racers.filter((r) => r.status === 409).length;
  check('25 simultaneous requests for one slot: exactly 1 wins, 24 get 409', wins === 1 && conflicts === 24, { wins, conflicts, others: racers.filter((r) => ![201, 409].includes(r.status)).map((r) => r.status) });

  const cancel = await call('DELETE', `/bookings/${first.body?.id}`);
  check('DELETE /bookings/{id} returns 200 with status cancelled', cancel.status === 200 && cancel.body?.status === 'cancelled' && cancel.body?.id === first.body?.id, cancel);
  const slots = await call('GET', '/slots');
  check('cancelled slot is available again', slots.body?.slots?.find((s) => s.id === 's3')?.available === true);
  const again = await call('DELETE', `/bookings/${first.body?.id}`);
  check('cancelling twice returns 409', again.status === 409 && isError(again), again);
  const unknown = await call('DELETE', '/bookings/does-not-exist');
  check('cancelling an unknown booking returns 404', unknown.status === 404, unknown);
  const rebook = await call('POST', '/bookings', { body: { slot_id: 's3', name: 'Chidi', email: email('l3c') } });
  check('a freed slot can be booked again', rebook.status === 201, rebook);
  const lookup = await call('GET', `/bookings/${first.body?.id}`);
  check('the cancelled booking still reads as cancelled', lookup.body?.status === 'cancelled', lookup.body);
}

async function level4() {
  console.log('\nLevel 4: idempotent retries, pagination');
  const body = { slot_id: 's5', name: 'Ada', email: email('l4idem') };
  const key = `key-${RUN}-1`;
  const a = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': key } });
  const b = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': key } });
  check('same key + same body returns the same status and booking id', a.status === 201 && b.status === 201 && a.body?.id === b.body?.id, [a, b]);
  const mine = await call('GET', `/bookings?email=${encodeURIComponent(body.email)}`);
  check('only one booking was created', mine.body?.bookings?.length === 1, mine.body);
  const reordered = await call('POST', '/bookings', { body: { email: body.email, name: 'Ada', slot_id: 's5' }, headers: { 'Idempotency-Key': key } });
  check('same body with keys in a different order still counts as the same', reordered.status === 201 && reordered.body?.id === a.body?.id, reordered);
  const different = await call('POST', '/bookings', { body: { ...body, name: 'Someone Else' }, headers: { 'Idempotency-Key': key } });
  check('same key + different body returns 422', different.status === 422 && isError(different), different);

  const ckey = `key-${RUN}-2`;
  const cbody = { slot_id: 's6', name: 'Bayo', email: email('l4conc') };
  const parallel = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/bookings', { body: cbody, headers: { 'Idempotency-Key': ckey } })));
  const ids = new Set(parallel.map((r) => r.body?.id));
  check('10 simultaneous retries with one key: all 201, one booking id', parallel.every((r) => r.status === 201) && ids.size === 1, parallel.map((r) => r.status));

  const fkey = `key-${RUN}-3`;
  const fbody = { slot_id: 's6', name: 'Late', email: email('l4fail') };
  const f1 = await call('POST', '/bookings', { body: fbody, headers: { 'Idempotency-Key': fkey } });
  const f2 = await call('POST', '/bookings', { body: fbody, headers: { 'Idempotency-Key': fkey } });
  check('a retried failure (409) replays the same status', f1.status === 409 && f2.status === 409, [f1.status, f2.status]);

  const rkey = `key-${RUN}-4`;
  const rbody = { slot_id: 's7', name: 'Retry', email: email('l4retry') };
  const retries = [];
  for (let i = 0; i < 7; i++) retries.push(await call('POST', '/bookings', { body: rbody, headers: { 'Idempotency-Key': rkey } }));
  check('retries with the same key don\'t use up the rate limit', retries.every((r) => r.status === 201), retries.map((r) => r.status));

  // Pagination: 5 bookings for one email (the most the rate limit allows per minute).
  const pemail = email('l4page');
  const created = [];
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/bookings', { body: { slot_id: `s${10 + i}`, name: 'Pager', email: pemail } });
    created.push(r.body?.id);
  }
  const seen = [];
  let cursor = null;
  let pages = 0;
  let lastPageNull = false;
  do {
    const q = `/bookings?email=${encodeURIComponent(pemail.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await call('GET', q);
    if (page.status !== 200) {
      check('paging works', false, page);
      break;
    }
    pages++;
    seen.push(...page.body.bookings.map((x) => x.id));
    cursor = page.body.next_cursor;
    if (cursor === null) lastPageNull = true;
  } while (cursor && pages < 10);
  check('paging with limit=2 gives 3 pages, oldest first, nothing missed or repeated', pages === 3 && JSON.stringify(seen) === JSON.stringify(created), { pages, seen, created });
  check('last page has next_cursor: null', lastPageNull);
  const def = await call('GET', `/bookings?email=${encodeURIComponent(pemail)}`);
  check('default limit returns all 5 with next_cursor null', def.body?.bookings?.length === 5 && def.body?.next_cursor === null, def.body?.next_cursor);
  for (const bad of ['0', '51', 'abc', '2.5', '-1']) {
    const r = await call('GET', `/bookings?email=${encodeURIComponent(pemail)}&limit=${bad}`);
    check(`limit=${bad} returns 400`, r.status === 400 && isError(r), r.status);
  }
  const ok50 = await call('GET', `/bookings?email=${encodeURIComponent(pemail)}&limit=50`);
  check('limit=50 is accepted', ok50.status === 200, ok50.status);
  const badCursor = await call('GET', `/bookings?email=${encodeURIComponent(pemail)}&cursor=garbage`);
  check('a made-up cursor returns 400', badCursor.status === 400, badCursor.status);
  const noEmail = await call('GET', '/bookings');
  check('missing email returns 400', noEmail.status === 400, noEmail.status);
}

async function level5() {
  console.log('\nLevel 5: rate limit (5 attempts per email per minute)');
  const spam = email('l5spam');
  const results = [];
  // Mix of failures and successes: all of them count.
  const bodies = [
    { slot_id: 'nope', name: 'S', email: spam },
    { slot_id: 's20', name: '', email: spam },
    { slot_id: 's20', name: 'S', email: spam },
    { slot_id: 's20', name: 'S', email: spam },
    { slot_id: 's21', name: 'S', email: spam },
    { slot_id: 's22', name: 'S', email: spam },
  ];
  for (const body of bodies) results.push(await call('POST', '/bookings', { body }));
  const sixth = results[5];
  check('the first 5 attempts (failures included) are let through', results.slice(0, 5).every((r) => r.status !== 429), results.map((r) => r.status));
  const retry = Number(sixth.headers.get('retry-after'));
  check('the 6th attempt returns 429', sixth.status === 429 && isError(sixth), sixth);
  check('429 has Retry-After in whole seconds (1–60)', Number.isInteger(retry) && retry >= 1 && retry <= 60, sixth.headers.get('retry-after'));
  const upper = await call('POST', '/bookings', { body: { slot_id: 's22', name: 'S', email: spam.toUpperCase() } });
  check('the same email in different case is still limited', upper.status === 429, upper.status);
  const other = await call('POST', '/bookings', { body: { slot_id: 's22', name: 'Other', email: email('l5other') } });
  check('other emails are not affected', other.status === 201, other.status);

  const burst = email('l5burst');
  const parallel = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/bookings', { body: { slot_id: `nope-${i}`, name: 'B', email: burst } })));
  const limited = parallel.filter((r) => r.status === 429).length;
  check('10 simultaneous attempts: exactly 5 get through, 5 get 429', limited === 5, parallel.map((r) => r.status));
}

const started = Date.now();
console.log(`Checking ${BASE}`);
try {
  await level1();
  await level2();
  await level3();
  await level4();
  await level5();
} finally {
  const seed = await call('POST', '/reset', { body: { slots: demoSlots() } }).catch(() => null);
  console.log(`\nRe-seeded demo slots: ${seed?.status === 200 ? 'yes' : 'NO'}`);
}
console.log(`\n${passed} passed, ${failed} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
process.exit(failed ? 1 : 0);
