/**
 * Narrowing helpers for JSON that arrived from somewhere else.
 *
 * RDAP payloads vary between registries in ways the specification permits — RFC
 * 9083 uses no RFC 2119 keywords for most members, so every field is optional in
 * practice and several registries return shapes their own documentation does not
 * describe. Reading them through these helpers means a surprising payload
 * produces a missing field rather than a thrown `TypeError`.
 */

/**
 * @param value Any decoded JSON value.
 * @returns The value as an object, or `null` if it is not one (arrays included).
 * @throws Never.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * @param value Any decoded JSON value.
 * @returns The value as an array, or `null` if it is not one.
 * @throws Never.
 */
export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * @param value Any decoded JSON value.
 * @returns The value as a non-empty string, or `null`.
 * @throws Never.
 */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Reads a value that a registry may return as either a string or a number.
 *
 * @param value Any decoded JSON value.
 * @returns The value as a string, or `null`.
 * @throws Never.
 */
export function asScalarString(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Normalises a timestamp to ISO 8601 in UTC.
 *
 * RDAP `eventDate` is nominally RFC 3339, but registries emit offsets rather
 * than `Z`, fractional seconds, and in at least one case a bare date. Parsing
 * leniently and re-emitting in one form is what lets the schemas require a `Z`.
 *
 * @param value A timestamp in any form the `Date` constructor accepts.
 * @returns The ISO 8601 UTC form, or `null` when absent or unparseable.
 * @throws Never.
 */
export function toIsoUtc(value: unknown): string | null {
  const text = asString(value);
  if (text === null) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
