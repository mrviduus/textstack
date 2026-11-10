// Alone so the RN host (library.mjs via hostStorage) does not pull in store.mjs's hash tables.
/**
 * A v4 UUID (ADR-031 rule 3: client ids, never renumbered) from getRandomValues: crypto.randomUUID needs
 * a secure context, which the page at origin "null" may not be. Hermes has no `crypto`: the RN host
 * passes Expo's uuid instead (createV2Storage's required `newId`).
 */
export function uuidV4() {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')
}
