// The request handler: routing, API-key check, JSON responses.
//
// Two route groups share the same booking logic:
//   /api/*  the public API from the spec. Every request needs X-API-Key.
//   /web/*  what the web page calls. It never sees the API key; the server
//           calls the same functions directly. /reset is NOT exposed here.
import { HttpError, sendJson, sendPreflight, readJsonBody } from './http.js';
import { requireApiKey } from './auth.js';
import { ensureSchema } from './db.js';
import { resetSlots, listSlots } from './slots.js';
import { createBooking, getBooking, cancelBooking, listBookings } from './bookings.js';

const apiRoutes = [
  route('POST', '/reset', resetSlots, { body: true }),
  route('GET', '/slots', listSlots),
  route('POST', '/bookings', createBooking, { body: true }),
  route('GET', '/bookings', listBookings),
  route('GET', '/bookings/:id', getBooking),
  route('DELETE', '/bookings/:id', cancelBooking),
];

const webRoutes = [
  route('GET', '/slots', listSlots),
  route('POST', '/bookings', createBooking, { body: true }),
  route('GET', '/bookings/:id', getBooking),
  route('DELETE', '/bookings/:id', cancelBooking),
];

export async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return sendPreflight(res);

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    let routes;
    let subPath;
    if (path === '/api' || path.startsWith('/api/')) {
      requireApiKey(req); // Level 2, checked before anything else
      routes = apiRoutes;
      subPath = path.slice('/api'.length) || '/';
    } else if (path.startsWith('/web/')) {
      routes = webRoutes;
      subPath = path.slice('/web'.length);
    } else {
      throw new HttpError(404, 'not found');
    }

    const match = findRoute(routes, req.method, subPath);
    const body = match.route.body ? await readJsonBody(req) : undefined;

    await ensureSchema();
    const result = await match.route.fn({ req, url, params: match.params, body });
    sendJson(res, result.status, result.body, result.headers);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message }, err.headers);
    } else {
      console.error(err);
      sendJson(res, 500, { error: 'internal server error' });
    }
  }
}

// ---------------------------------------------------------------- tiny router

function route(method, pattern, fn, options = {}) {
  return { method, parts: pattern.split('/').filter(Boolean), fn, body: Boolean(options.body) };
}

function findRoute(routes, method, path) {
  const segments = path.split('/').filter(Boolean);
  let pathExists = false;

  for (const r of routes) {
    const params = matchParts(r.parts, segments);
    if (!params) continue;
    pathExists = true;
    if (r.method === method) return { route: r, params };
  }
  if (pathExists) throw new HttpError(405, 'method not allowed');
  throw new HttpError(404, 'not found');
}

function matchParts(parts, segments) {
  if (parts.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
    else if (parts[i] !== segments[i]) return null;
  }
  return params;
}
