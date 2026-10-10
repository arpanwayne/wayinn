import { badRequest } from './errors.js';

/** Parse with a zod schema or throw a 400 with field errors. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    throw badRequest('Validation failed', fields);
  }
  return r.data;
}

export const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid id');
  return n;
};
