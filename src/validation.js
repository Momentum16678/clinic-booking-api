// Level 2: turn away bookings with missing or invalid details.
import { HttpError, isPlainObject } from './http.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates a POST /bookings body and returns the cleaned-up values:
 * name and email trimmed, email lower-cased.
 */
export function parseNewBooking(body) {
  if (!isPlainObject(body)) throw new HttpError(400, 'request body must be a JSON object');

  const slotId = requireString(body.slot_id, 'slot_id');
  const name = requireString(body.name, 'name').trim();
  const email = normalizeEmail(requireString(body.email, 'email'));

  if (name.length > 200) throw new HttpError(400, 'name is too long');
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, 'email is not a valid email address');
  }
  return { slotId, name, email };
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function requireString(value, field) {
  if (value === undefined || value === null) throw new HttpError(400, `${field} is required`);
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  if (value.trim() === '') throw new HttpError(400, `${field} must not be empty`);
  return value;
}
