import { GhError, ghJson } from './gh.js';

/**
 * Listing repositories through GitHub's REST API, a page at a time and several
 * pages at once.
 *
 * `gh repo list` asks GraphQL for the whole listing in one call. That call
 * cannot say how far along it is, it gets slower the more fields are asked
 * for, and on a large organisation it intermittently fails outright — GitHub
 * answers 502 when the query takes too long to resolve.
 *
 * REST costs one request per hundred repositories, but those requests are
 * numbered rather than chained, so they can be made in parallel. Measured
 * against github.com, a thousand repositories of a large organisation took
 * ~11s through `gh repo list` (when it did not 502), ~45s through paged
 * GraphQL, and ~3s this way.
 */

/** GitHub caps a REST page at 100, so this is the largest useful page. */
export const PAGE_SIZE = 100;

/**
 * How many pages to have in flight. High enough to hide the round trip,
 * low enough to stay well clear of GitHub's secondary rate limits, which
 * punish bursts rather than volume.
 */
export const CONCURRENCY = 8;

/** Attempts per page, for the failures that are worth trying again. */
const ATTEMPTS = 3;

const isNotFound = (error) => /\b404\b|not found/i.test(error.message);

/**
 * Failures that say "later" rather than "no": a rate limit GitHub wants us to
 * back off from, or a gateway that gave up on a request it may yet serve.
 */
const isTransient = (error) => /\b(429|502|503|504)\b|rate limit|timeout/i.test(error.message);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(operation, { attempts = ATTEMPTS, delay = 500 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      // Backing off doubles each time: a burst that tripped a secondary limit
      // only clears if we actually stop for a moment.
      await wait(delay * 2 ** (attempt - 1));
    }
  }
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight, keeping the
 * results in the order the items were given rather than the order they landed.
 */
export async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * A repository as GitHub's REST API returns it, in the nested shape the rest
 * of repwrk reads. Keeping one shape means `normalize` does not have to know
 * which API a record came from.
 */
export function toNode(row) {
  return {
    name: row.name,
    nameWithOwner: row.full_name,
    owner: { login: row.owner?.login ?? row.full_name?.split('/')[0] },
    url: row.html_url,
    sshUrl: row.ssh_url,
    description: row.description,
    primaryLanguage: row.language ? { name: row.language } : null,
    defaultBranchRef: row.default_branch ? { name: row.default_branch } : null,
    isArchived: Boolean(row.archived),
    isFork: Boolean(row.fork),
    isPrivate: Boolean(row.private),
    visibility: row.visibility,
    updatedAt: row.updated_at,
    pushedAt: row.pushed_at,
  };
}

/**
 * Filters GitHub can apply itself. The organisation endpoint spends a single
 * `type` parameter on fork-ness and visibility both, so it can serve one or
 * the other but not both — whatever it cannot do is done here afterwards,
 * which is why every facet is checked locally regardless.
 */
function typeParam({ scope, kind, visibility }) {
  if (scope !== 'org') return null;
  if (kind === 'source') return 'sources';
  if (kind === 'fork') return 'forks';
  if (visibility === 'public' || visibility === 'private') return visibility;
  return null;
}

/**
 * Work out where a listing comes from and roughly how big it is, before
 * fetching any of it.
 *
 * The count is what lets a progress meter have a denominator from the first
 * moment. It is a plan, not a promise: GitHub reports private repositories
 * only to those who can see them, so the real listing may run longer, and
 * `fetchRepos` keeps reading past the plan rather than trusting it.
 *
 * This is also where a mistyped owner or team is caught, which it must be:
 * every listing endpoint answers a name it does not know with 404, and a 404
 * swallowed here would read downstream as "no repositories matched".
 */
export async function planListing({ owner, team, kind, visibility, request = ghJson }) {
  if (team) {
    let meta;
    try {
      meta = await request(['api', `orgs/${owner}/teams/${team}`]);
    } catch (error) {
      if (isNotFound(error)) {
        throw new GhError(
          `the team "${team}" was not found in ${owner}. Check the team's URL slug — it is ` +
            'not always the display name — and that your token carries the read:org scope: ' +
            '`gh auth refresh -s read:org`',
        );
      }
      throw error;
    }
    return { path: `orgs/${owner}/teams/${team}/repos`, query: [], expected: meta.repos_count ?? 0 };
  }

  if (!owner) {
    const meta = await request(['api', 'user']);
    return {
      path: 'user/repos',
      // Without an owner the account's own repositories are the listing, which
      // is what `gh repo list` shows with no argument.
      query: ['affiliation=owner'],
      expected: (meta.public_repos ?? 0) + (meta.total_private_repos ?? 0),
    };
  }

  let meta;
  try {
    meta = await request(['api', `users/${owner}`]);
  } catch (error) {
    if (isNotFound(error)) {
      throw new GhError(
        `the owner "${owner}" was not recognised as either a GitHub user or an organisation`,
      );
    }
    throw error;
  }

  // One request settles both questions: whether this is an organisation, and
  // how many repositories to expect.
  if (meta.type === 'Organization') {
    const type = typeParam({ scope: 'org', kind, visibility });
    return {
      path: `orgs/${owner}/repos`,
      query: type ? [`type=${type}`] : [],
      expected: (meta.public_repos ?? 0) + (meta.total_private_repos ?? 0),
    };
  }

  // `users/{login}/repos` answers with public repositories only — including
  // when the login is your own, where it quietly leaves out every private
  // repository you have. Naming yourself must not show you less than naming
  // nobody did, so your own account is listed the way no owner at all is.
  const viewer = await request(['api', 'user']);
  if (viewer.login?.toLowerCase() === owner.toLowerCase()) {
    return {
      path: 'user/repos',
      query: ['affiliation=owner'],
      expected: (viewer.public_repos ?? 0) + (viewer.total_private_repos ?? 0),
    };
  }

  // Somebody else's account: their public repositories are all there is to see.
  return { path: `users/${owner}/repos`, query: [], expected: meta.public_repos ?? 0 };
}

/**
 * Fetch every repository of a listing, reporting each page as it lands.
 *
 * The planned pages are fetched together; if the last of them comes back full
 * there was more than the plan accounted for, and the reading continues in
 * batches until a page comes back short. That is what makes an undercounted
 * plan — an organisation whose private repositories we cannot count — slow
 * rather than wrong.
 */
export async function fetchRepos({
  owner,
  team,
  kind = 'all',
  visibility,
  limit = Infinity,
  pageSize = PAGE_SIZE,
  concurrency = CONCURRENCY,
  onPage,
  request = ghJson,
} = {}) {
  const plan = await planListing({ owner, team, kind, visibility, request });
  const wanted = Math.min(plan.expected, limit);

  const url = (page) =>
    [`${plan.path}?per_page=${pageSize}&page=${page}`, ...plan.query].join('&');

  const pages = [];
  let fetched = 0;
  let truncated = false;

  const readPage = async (page) => {
    const rows = await withRetry(() => request(['api', url(page)]));
    // A listing endpoint answers with an array. Anything else would compare
    // against the page size as NaN, which reads as "this page was full" and
    // asks for the next one forever.
    if (!Array.isArray(rows)) {
      throw new GhError(`GitHub returned a repository listing in an unexpected shape`);
    }
    fetched += rows.length;
    // The plan can understate — GitHub does not always count private
    // repositories for us — so the meter grows rather than pretending to be
    // finished at a total that has already been passed.
    onPage?.({ fetched, total: Math.max(wanted, fetched) });
    return rows;
  };

  // Pages go out in waves rather than all at once. A count can overstate as
  // easily as understate — an organisation reports its forks in the total even
  // when the listing was asked to leave them out — and a plan fired off whole
  // would spend a request on every page the overstatement invented. A wave
  // spends at most one wave's worth before the short page ends it, and costs
  // nothing in speed: either way the pages go out `concurrency` at a time.
  //
  // A listing of nothing is still one request: the count may be wrong, and a
  // repository we were told about is worth more than a request we saved.
  const planned = Math.max(1, Math.ceil(wanted / pageSize));
  let from = 1;

  while (true) {
    const remaining = planned - from + 1;
    const batch = Math.max(1, Math.min(concurrency, remaining > 0 ? remaining : concurrency));
    const numbers = Array.from({ length: batch }, (_, index) => from + index);

    const wave = await pool(numbers, concurrency, readPage);
    pages.push(...wave);

    const last = wave.at(-1) ?? [];
    const total = pages.reduce((sum, rows) => sum + rows.length, 0);

    if (total >= limit) {
      truncated = last.length === pageSize;
      break;
    }
    // A short page is the end of the listing; a full one means there is more
    // than the plan accounted for, so read on past it.
    if (last.length < pageSize) break;

    from += batch;
  }

  const nodes = pages
    .flat()
    .slice(0, limit === Infinity ? undefined : limit)
    .map(toNode);

  return { nodes, total: Math.max(plan.expected, nodes.length), truncated };
}

/**
 * Fill in the per-repository language breakdown that only `uses` needs.
 *
 * REST does not carry it in a listing, and it is one request per repository,
 * so it is fetched for the repositories that survived every other filter
 * rather than for the whole listing.
 */
export async function attachLanguages(repos, { concurrency = CONCURRENCY, request = ghJson } = {}) {
  const breakdowns = await pool(repos, concurrency, (repo) =>
    withRetry(() => request(['api', `repos/${repo.nameWithOwner}/languages`])).catch(() => ({})),
  );

  return repos.map((repo, index) => ({
    ...repo,
    languages: Object.entries(breakdowns[index] ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name),
  }));
}
