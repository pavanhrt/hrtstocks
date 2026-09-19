// Deterministic, seeded shuffle -- fixes "always processes alphabetically-early
// symbols first, alphabetically-late ones are perpetually the ones starved
// when coverage is incomplete" (the universe was previously built and
// iterated in whatever order index-constituent CSVs happen to list, which is
// effectively alphabetical). Seeding by run_date makes a given day's
// processing order reproducible (useful for debugging/tests) while still
// varying day to day, so no symbol is permanently first or last.
//
// Pure, no external dependency -- Deno and Node's crypto both have better
// PRNGs available, but a hash+PRNG this simple is enough for "fair rotation,"
// doesn't need cryptographic properties, and is trivially portable/testable.

/** FNV-1a, a small well-known non-cryptographic string hash. */
export function fnv1aHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 -- a small, fast, deterministic PRNG seeded by a 32-bit integer. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle of `items`, deterministic for a given `seed` string
 * (same seed always produces the same permutation; a different seed almost
 * always produces a different one). Does not mutate `items`.
 */
export function seededShuffle(items, seed) {
  const rng = mulberry32(fnv1aHash(seed));
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
