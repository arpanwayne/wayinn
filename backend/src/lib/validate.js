import { badRequest } from './errors.js';

/** Parse with a zod schema or throw a 400 with field errors. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    // Name the fields in the message itself so the user sees what to fix, not just "Validation failed".
    const pretty = (k) => (k === '_' ? '' : `${k.split('.').pop().replace(/_(paise|id)$/, '').replace(/_/g, ' ')}: `);
    const msg = Object.entries(fields).slice(0, 4).map(([k, m]) => `${pretty(k)}${m}`).join('; ');
    throw badRequest(`Please check: ${msg}`, fields);
  }
  return r.data;
}

export const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid id');
  return n;
};
