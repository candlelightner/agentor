import { isDeepStrictEqual } from 'node:util';

/** Legacy shares omit io.cache. Permit only the SQLite-capable replacement,
 * keeping every source, path, access mode and other device field exact. */
export function sameIncusDevice(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  if (!actual) return false;
  if (expected.type === 'disk' && expected.path && expected.path !== '/' && expected['io.cache'] === 'unsafe') {
    if (actual['io.cache'] !== undefined && actual['io.cache'] !== 'unsafe') return false;
    const actualFields = { ...actual }, expectedFields = { ...expected };
    delete actualFields['io.cache']; delete expectedFields['io.cache'];
    return isDeepStrictEqual(actualFields, expectedFields);
  }
  return isDeepStrictEqual(actual, expected);
}

export function sameIncusDevices(actual: Record<string, Record<string, string>>, expected: Record<string, Record<string, string>>): boolean {
  return Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, device]) => sameIncusDevice(actual[key], device));
}
