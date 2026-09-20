/**
 * Order names the same way on every machine.
 *
 * localeCompare answers according to the machine's locale and ICU build, so
 * the same workspace could list in one order here and another order on a
 * colleague's computer — awkward for output meant to be diffed or scripted
 * against. Code point order is the order git and sort already print in, and
 * it is the same everywhere.
 */
export const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
