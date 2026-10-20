import type { ZodType } from 'zod';
import { invalidBody } from './errors.js';

/** Parses a request body with zod; a failure becomes a 400 INVALID_BODY. */
export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidBody();
  return result.data;
}
