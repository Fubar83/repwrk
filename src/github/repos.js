import { GhError } from './gh.js';
import { attachLanguages, fetchRepos } from './rest.js';
import { matches, matchesAny } from '../glob.js';
import { byName } from '../order.js';

/** Keys of a normalised repo record — also the valid values for `--field`. */
export const REPO_FIELDS = [
  'name',
  'nameWithOwner',
  'owner',
  'url',
  'sshUrl',
  'defaultBranch',
  'description',
  'language',
  'languages',
  'visibility',
  'isPrivate',
  'isArchived',
  'isFork',
  'updatedAt',
  'pushedAt',
];

/**
 * Flatten GitHub's nested objects into a flat record, so every field is
 * printable and downstream tools get a stable shape.
 */
export function normalize(repo) {
  return {
    name: repo.name,
    nameWithOwner: repo.nameWithOwner,
    owner: repo.owner?.login ?? repo.nameWithOwner?.split('/')[0] ?? '',
    url: repo.url,
    sshUrl: repo.sshUrl,
    defaultBranch: repo.defaultBranchRef?.name ?? null,
    description: repo.description ?? '',
    language: repo.primaryLanguage?.name ?? null,
    // GitHub returns these unordered; largest first is the useful reading order.
    languages: (repo.languages ?? [])
      .slice()
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
      .map((entry) => entry.node?.name)
      .filter(Boolean),
    visibility: (repo.visibility ?? (repo.isPrivate ? 'PRIVATE' : 'PUBLIC')).toLowerCase(),
    isPrivate: repo.isPrivate,
    isArchived: repo.isArchived,
    isFork: repo.isFork,
    updatedAt: repo.updatedAt,
    pushedAt: repo.pushedAt,
  };
}

/**
 * A pattern containing a slash is matched against `owner/name`, otherwise
 * against the bare repository name — decided per pattern, not per call.
 */
function matchesPattern(repo, pattern) {
  return matches(pattern.includes('/') ? repo.nameWithOwner : repo.name, pattern);
}

/**
 * No include patterns means "everything"; any exclude match wins over an include.
 *
 * Repeating a pattern widens the selection: `--filter companyA* --filter
 * *packages.internal*` keeps a repository matching either. Narrowing is what
 * the other axes are for, and they combine as AND — a name filter and a
 * language filter given together must both hold.
 *
 * `language` matches a repository's primary language, `uses` matches any
 * language GitHub detected in it. Both accept globs and are case-insensitive,
 * so `C#` and `c#` are the same and `Type*` matches TypeScript.
 */
export function selectRepos(repos, { patterns = [], exclude = [], language = [], uses = [] } = {}) {
  return repos.filter((repo) => {
    if (!(patterns.length === 0 || patterns.some((p) => matchesPattern(repo, p)))) return false;
    if (exclude.some((p) => matchesPattern(repo, p))) return false;
    if (language.length > 0 && !matchesAny(repo.language ?? '', language)) return false;
    if (uses.length > 0 && !(repo.languages ?? []).some((name) => matchesAny(name, uses))) {
      return false;
    }
    return true;
  });
}

/**
 * Facets GitHub either cannot filter on, or cannot be asked to filter on for
 * every scope: a team's repository connection accepts none of these arguments,
 * and no connection has one for archived state at all. Applying them here as
 * well makes the result identical whichever scope produced it.
 */
export function matchesFacets(repo, { archived = 'exclude', kind = 'all', visibility } = {}) {
  if (archived === 'exclude' && repo.isArchived) return false;
  if (archived === 'only' && !repo.isArchived) return false;
  if (kind === 'source' && repo.isFork) return false;
  if (kind === 'fork' && !repo.isFork) return false;
  if (visibility && repo.visibility !== visibility) return false;
  return true;
}

/**
 * List repositories for `owner` (the authenticated account when omitted), or
 * only those one `team` inside that organisation can reach.
 *
 * `archived` is one of 'exclude' (default), 'include' or 'only'.
 * `kind` is one of 'all' (default), 'source' (no forks) or 'fork'.
 *
 * `language` reads the primary language, which every listing carries anyway
 * and which is therefore free. `uses` reads the full language breakdown, which
 * is a request per repository, so it is fetched last — for the repositories
 * that survived every other filter rather than for the whole listing.
 *
 * `onProgress` is called after each page with `{ fetched, total }` — what lets
 * a caller draw a meter over a listing that takes a while.
 *
 * Returns `{ repos, total, truncated }`. Without an explicit `limit` the whole
 * listing is fetched and `truncated` is false: an incomplete answer that looks
 * complete is the one failure no filter downstream can recover from, and
 * GitHub offers no server-side name filter that could make a shortcut safe —
 * its only one is the search index, which demonstrably omits matches.
 */
export async function listRepos({
  owner,
  team,
  patterns = [],
  exclude = [],
  language = [],
  uses = [],
  archived = 'exclude',
  kind = 'all',
  visibility,
  limit,
  onProgress,
  request,
} = {}) {
  if (team && !owner) {
    throw new GhError('a team belongs to an organisation, so --team needs --owner as well');
  }

  const passthrough = request ? { request } : {};

  const { nodes, total, truncated } = await fetchRepos({
    owner,
    team,
    kind,
    visibility,
    limit: limit ?? Infinity,
    onPage: onProgress,
    ...passthrough,
  });

  // Everything cheap first, so the one expensive lookup is asked about as few
  // repositories as possible.
  const cheap = selectRepos(
    nodes.map(normalize).filter((repo) => matchesFacets(repo, { archived, kind, visibility })),
    { patterns, exclude, language },
  );

  const withLanguages = uses.length > 0 ? await attachLanguages(cheap, passthrough) : cheap;

  const repos = selectRepos(withLanguages, { uses }).sort((a, b) =>
    byName(a.nameWithOwner, b.nameWithOwner),
  );

  return { repos, total, truncated };
}
