import { HttpError } from '../lib/errors.js';

const PG_MESSAGES = {
  stays_no_overlap: 'This room is already booked for some of these nights. Choose another room or dates.',
  folio_lines_room_night_uq: 'Room charge for this night is already posted.',
  users_email_uq: 'A user with this email already exists.',
};

export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // Postgres constraint violations → friendly 409/400
  if (err.code === '23P01' || err.code === '23505') {
    const msg = PG_MESSAGES[err.constraint] || 'This record conflicts with an existing one.';
    return res.status(409).json({ error: msg, constraint: err.constraint });
  }
  if (err.code === '23503') return res.status(400).json({ error: 'Referenced record does not exist.' });
  if (err.code === '23514') return res.status(400).json({ error: 'Invalid value.', constraint: err.constraint });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
