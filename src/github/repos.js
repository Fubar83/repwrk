import { GhError, ghJson, runGh } from './gh.js';
import { matches, matchesAny } from '../glob.js';
import { byName } from '../order.js';

/**
 * How many repositories to ask `gh` for. Reaching it means GitHub had more to
 * give, which `listRepos` reports as `truncated`.
 */
export const LIST_LIMIT = 1000;

/** Fields requested from `gh repo list --json`. */
const GH_FIELDS = [
  'name',
  'nameWithOwner',
  'owner',
  'url',
  'sshUrl',
  'description',
  'primaryLanguage',
  'languages',
  'defaultBranchRef',
  'isArchived',
  'isFork',
  'isPrivate',
  'visibility',
  'updatedAt',
  'pushedAt',
];

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
 * Flatten gh's nested objects into a flat record, so every field is printable
 * with `--field` and downstream tools get a stable shape.
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
    // gh returns these unordered; largest first is the useful reading order.
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
 * `language` matches a repository's primary language, `uses` matches any language
 * GitHub detected in it. Both accept globs and are case-insensitive, so `C#` and
 * `c#` are the same and `Type*` matches TypeScript. Given together, both must hold.
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
 * `gh repo list` reports an unknown owner as an error — unless --archived or
 * --no-archived is passed, where it quietly returns an empty list and exit 0.
 * We always pass one of those, so a mistyped owner would silently look like
 * "no repositories" and feed an empty list into whatever comes next in the
 * pipeline. Confirm the owner exists before reporting an empty result.
 */
async function assertOwnerExists(owner) {
  try {
    await runGh(['api', `users/${owner}`, '--silent']);
  } catch (error) {
    if (error instanceof GhError && /404|not found/i.test(error.message)) {
      throw new GhError(
        `the owner "${owner}" was not recognised as either a GitHub user or an organisation`,
        1,
      );
    }
    throw error;
  }
}

/**
 * List repositories for `owner` (the authenticated user when omitted),
 * keeping those matching `patterns` and dropping those matching `exclude`.
 *
 * `archived` is one of 'exclude' (default), 'include' or 'only'.
 * `kind` is one of 'all' (default), 'source' (no forks) or 'fork'.
 *
 * Returns `{ repos, truncated }`; `truncated` is true when GitHub returned
 * exactly `limit` repositories, meaning there may be more behind the limit.
 */
export async function listRepos({
  owner,
  patterns = [],
  exclude = [],
  language = [],
  uses = [],
  archived = 'exclude',
  kind = 'all',
  visibility,
  limit = LIST_LIMIT,
} = {}) {
  const args = ['repo', 'list'];
  if (owner) args.push(owner);
  args.push('--limit', String(limit), '--json', GH_FIELDS.join(','));

  if (archived === 'only') args.push('--archived');
  else if (archived === 'exclude') args.push('--no-archived');

  if (kind === 'source') args.push('--source');
  else if (kind === 'fork') args.push('--fork');

  if (visibility) args.push('--visibility', visibility);

  const raw = await ghJson(args);
  if (owner && raw.length === 0) await assertOwnerExists(owner);

  const repos = selectRepos(raw.map(normalize), { patterns, exclude, language, uses }).sort(
    (a, b) => byName(a.nameWithOwner, b.nameWithOwner),
  );

  return { repos, truncated: raw.length === limit };
}
