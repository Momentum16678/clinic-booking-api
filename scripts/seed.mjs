// Replaces all slots with two weeks of demo slots (and deletes all bookings).
//   node scripts/seed.mjs https://your-app.vercel.app/api YOUR_API_KEY
import { demoSlots } from '../src/demoSlots.js';

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000/api').replace(/\/+$/, '');
const KEY = process.argv[3] || process.env.API_KEY;
if (!KEY) {
  console.error('Usage: node scripts/seed.mjs <base-url> <api-key>');
  process.exit(2);
}

const res = await fetch(`${BASE}/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
  body: JSON.stringify({ slots: demoSlots() }),
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
