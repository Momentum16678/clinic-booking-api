// Small HTTP helpers shared by every route.

/** An error that should be returned to the client as {"error": message}. */
export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// CORS: lets browser-based tools (e.g. a Swagger "Try it out" button) call the API.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key',
  'Access-Control-Expose-Headers': 'Retry-After, Idempotency-Replayed',
};

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
    ...headers,
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export function sendPreflight(res) {
  res.writeHead(204, { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' });
  res.end();
}

const MAX_BODY_BYTES = 100_000;

/**
 * Reads and parses a JSON request body. Returns {} for an empty body.
 * Works with a plain Node request and with Vercel's request, which may
 * already have parsed the body into req.body.
 */
export async function readJsonBody(req) {
  if ('body' in req) {
    let body;
    try {
      body = req.body; // Vercel parses lazily and throws on invalid JSON
    } catch {
      throw new HttpError(400, 'request body is not valid JSON');
    }
    if (body === undefined || body === '') return {};
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') return parseJson(body);
    return body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body is too large');
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(text) {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
