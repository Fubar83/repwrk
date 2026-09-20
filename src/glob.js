/**
 * Shell-style glob matching for repository names.
 *
 * Supports `*` (any run of characters) and `?` (exactly one character).
 * Patterns are anchored and case-insensitive, so `fubar-*` matches
 * `fubar-api` but not `my-fubar-api` — write `*fubar-*` for that.
 */

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

export function globToRegExp(pattern) {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(REGEXP_SPECIALS, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

export function matches(value, pattern) {
  return globToRegExp(pattern).test(value);
}

/** An empty pattern list matches everything, so "no filter given" needs no special case. */
export function matchesAny(value, patterns) {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => matches(value, pattern));
}

export function isGlob(value) {
  return value.includes('*') || value.includes('?');
}

/**
 * Path globs, for matching paths inside a repository.
 *
 * Differs from the name globs above in that `/` is a boundary:
 *   `*`   matches within one path segment
 *   `?`   matches one character within a segment
 *   `**\/` matches any number of leading segments
 *
 * So `**\/*lambda/package.json` matches `services/foo-lambda/package.json`
 * and `foo-lambda/package.json`, but `*lambda` alone matches neither.
 */
export function pathGlobToRegExp(pattern) {
  // git spells a path with no leading ./ and no trailing /, so a pattern
  // carrying either would match nothing at all. Both are how people type a
  // directory, so read them as the directory they mean.
  const cleaned = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  let source = '';
  let index = 0;

  while (index < cleaned.length) {
    const char = cleaned[index];

    if (char === '*' && cleaned[index + 1] === '*') {
      if (cleaned[index + 2] === '/') {
        // `**/` may also stand for no segments at all.
        source += '(?:[^/]+/)*';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    source += char.replace(REGEXP_SPECIALS, '\\$&');
    index += 1;
  }

  return new RegExp(`^${source}$`, 'i');
}

export function matchesPath(value, pattern) {
  return pathGlobToRegExp(pattern).test(value);
}
