import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachLanguages, fetchRepos, planListing, pool, toNode } from '../src/github/rest.js';
import { listRepos, matchesFacets, normalize } from '../src/github/repos.js';
import { GhError } from '../src/github/gh.js';

/** A repository as GitHub's REST API returns one. */
const row = (name, extra = {}) => ({
  name,
  full_name: `acme/${name}`,
  owner: { login: 'acme' },
  html_url: `https://github.com/acme/${name}`,
  ssh_url: `git@github.com:acme/${name}.git`,
  description: null,
  language: 'C#',
  default_branch: 'main',
  archived: false,
  fork: false,
  private: false,
  visibility: 'public',
  updated_at: '2026-09-01T10:00:00Z',
  pushed_at: '2026-09-01T10:00:00Z',
  ...extra,
});

const pathOf = (args) => args[1];
const pageOf = (args) => Number(new URL(`https://x/${pathOf(args)}`).searchParams.get('page'));

/**
 * A fake `gh api`, serving `entries` from a listing endpoint and answering the
 * metadata request that plans it. `type` decides whether the owner looks like
 * an organisation, and `counted` lets a test understate what metadata reports,
 * which is what happens when private repositories cannot be counted.
 */
function fakeGitHub(entries, { type = 'Organization', counted, teamRepos } = {}) {
  const calls = [];

  const request = async (args) => {
    calls.push(args);
    const path = pathOf(args);

    // Anchored: "users/someone" is the metadata request, "users/someone/repos?…"
    // is a page of the listing, and confusing the two makes the fake lie.
    if (path === 'user') return { public_repos: counted ?? entries.length, total_private_repos: 0 };
    if (/^users\/[^/?]+$/.test(path)) {
      return { type, public_repos: counted ?? entries.length, total_private_repos: 0 };
    }
    if (/^orgs\/[^/]+\/teams\/[^/]+$/.test(path)) {
      if (teamRepos === 'missing') throw new GhError('Not Found (HTTP 404)');
      return { repos_count: teamRepos ?? entries.length };
    }
    if (/\/languages$/.test(path)) {
      const name = path.split('/')[2];
      return entries.find((entry) => (entry.name ?? entry) === name)?.langs ?? {};
    }

    // Serve exactly the page the request asked for, so the fake can never
    // disagree with the caller about how big a page is.
    const query = new URL(`https://x/${path}`).searchParams;
    const perPage = Number(query.get('per_page'));
    const start = (Number(query.get('page')) - 1) * perPage;
    return entries
      .slice(start, start + perPage)
      .map((entry) => (typeof entry === 'string' ? row(entry) : entry));
  };

  return { request, calls };
}

const names = (repos) => repos.map((repo) => repo.name);
const listingCalls = (calls) => calls.filter((args) => /\/repos\?/.test(pathOf(args)));

test('a listing is fetched as numbered pages, not a chain of cursors', async () => {
  const { request, calls } = fakeGitHub(['a', 'b', 'c', 'd', 'e']);
  const { nodes, truncated } = await fetchRepos({ owner: 'acme', request, pageSize: 2 });

  assert.deepEqual(names(nodes), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(truncated, false);
  assert.deepEqual(listingCalls(calls).map(pageOf).sort(), [1, 2, 3]);
});

test('pages are fetched together, and the result keeps the listing order', async () => {
  // Pages land out of order when several are in flight; the result must not.
  const { request } = fakeGitHub(['a', 'b', 'c', 'd', 'e', 'f']);
  const delayed = async (args) => {
    const page = pageOf(args);
    if (Number.isFinite(page)) await new Promise((r) => setTimeout(r, (4 - page) * 10));
    return request(args);
  };

  const { nodes } = await fetchRepos({ owner: 'acme', request: delayed, concurrency: 3, pageSize: 2 });
  assert.deepEqual(names(nodes), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('no more than the given number of pages are ever in flight', async () => {
  const { request } = fakeGitHub(Array.from({ length: 20 }, (_, i) => `r${i}`));
  let inFlight = 0;
  let peak = 0;
  const counting = async (args) => {
    if (!Number.isFinite(pageOf(args))) return request(args);
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return request(args);
  };

  await fetchRepos({ owner: 'acme', request: counting, concurrency: 3, pageSize: 2 });
  assert.ok(peak <= 3, `at most 3 pages at once, saw ${peak}`);
});

test('progress is reported as each page lands, against the planned total', async () => {
  const { request } = fakeGitHub(['a', 'b', 'c', 'd', 'e']);
  const seen = [];
  await fetchRepos({ owner: 'acme', request, concurrency: 1, pageSize: 2, onPage: (p) => seen.push(p) });

  assert.deepEqual(seen, [
    { fetched: 2, total: 5 },
    { fetched: 4, total: 5 },
    { fetched: 5, total: 5 },
  ]);
});

// GitHub reports private repositories only to those who can see them, so the
// planned page count can be short. Trusting it would silently drop the rest.
test('a listing longer than its plan is read to the end anyway', async () => {
  const { request } = fakeGitHub(['a', 'b', 'c', 'd', 'e', 'f', 'g'], { counted: 2 });
  const { nodes } = await fetchRepos({ owner: 'acme', request, concurrency: 2, pageSize: 2 });

  assert.deepEqual(names(nodes), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('an overstated plan stops at the end of the listing', async () => {
  const { request, calls } = fakeGitHub(['a', 'b'], { counted: 500 });
  const { nodes } = await fetchRepos({ owner: 'acme', request, pageSize: 2, concurrency: 4 });

  assert.deepEqual(names(nodes), ['a', 'b']);
  assert.ok(
    listingCalls(calls).length <= 4,
    `a wrong count must not become wasted requests, spent ${listingCalls(calls).length}`,
  );
});

test('an empty listing still costs one request, since the count may be wrong', async () => {
  const { request, calls } = fakeGitHub([], { counted: 0 });
  const { nodes } = await fetchRepos({ owner: 'acme', request });

  assert.deepEqual(nodes, []);
  assert.equal(listingCalls(calls).length, 1);
});

test('a limit stops the walk early and says the listing was cut short', async () => {
  const { request } = fakeGitHub(['a', 'b', 'c', 'd', 'e']);
  const { nodes, truncated } = await fetchRepos({ owner: 'acme', request, limit: 3, pageSize: 2 });

  assert.deepEqual(names(nodes), ['a', 'b', 'c']);
  assert.equal(truncated, true);
});

test('an owner GitHub does not know is an error, not an empty listing', async () => {
  const request = async () => {
    throw new GhError('Not Found (HTTP 404)');
  };
  await assert.rejects(
    fetchRepos({ owner: 'no-such-org', request }),
    (error) => error instanceof GhError && /was not recognised/.test(error.message),
  );
});

test('a team that cannot be seen names the slug and the scope it needs', async () => {
  const { request } = fakeGitHub(['a'], { teamRepos: 'missing' });
  await assert.rejects(
    fetchRepos({ owner: 'acme', team: 'payments', request }),
    /the team "payments" was not found in acme[\s\S]*read:org/,
  );
});

test('the endpoint follows from what the owner turned out to be', async () => {
  const org = fakeGitHub(['a']);
  await fetchRepos({ owner: 'acme', request: org.request });
  assert.match(pathOf(listingCalls(org.calls)[0]), /^orgs\/acme\/repos\?/);

  const user = fakeGitHub(['a'], { type: 'User' });
  await fetchRepos({ owner: 'someone', request: user.request });
  assert.match(pathOf(listingCalls(user.calls)[0]), /^users\/someone\/repos\?/);

  const team = fakeGitHub(['a']);
  await fetchRepos({ owner: 'acme', team: 'payments', request: team.request });
  assert.match(pathOf(listingCalls(team.calls)[0]), /^orgs\/acme\/teams\/payments\/repos\?/);
});

test('with no owner the account itself is the listing', async () => {
  const { request, calls } = fakeGitHub(['mine']);
  const { repos } = await listRepos({ request });

  assert.deepEqual(names(repos), ['mine']);
  assert.match(pathOf(listingCalls(calls)[0]), /^user\/repos\?.*affiliation=owner/);
});

test('filters GitHub can apply are pushed into the request', async () => {
  const sources = fakeGitHub(['a']);
  await fetchRepos({ owner: 'acme', kind: 'source', request: sources.request });
  assert.match(pathOf(listingCalls(sources.calls)[0]), /type=sources/);

  // A user listing has no such parameter, so nothing may be pushed to one.
  const user = fakeGitHub(['a'], { type: 'User' });
  await fetchRepos({ owner: 'someone', kind: 'source', request: user.request });
  assert.ok(!pathOf(listingCalls(user.calls)[0]).includes('type=sources'));
});

test('facets are applied here too, whatever the endpoint did', async () => {
  const fork = normalize(toNode(row('tool', { fork: true })));
  assert.equal(matchesFacets(fork, { kind: 'source' }), false);
  assert.equal(matchesFacets(fork, { kind: 'fork' }), true);
});

test('archived repositories are dropped here, as no endpoint can filter them', async () => {
  const entries = () => ['live', row('old', { archived: true })];

  const { repos } = await listRepos({ owner: 'acme', request: fakeGitHub(entries()).request });
  assert.deepEqual(names(repos), ['live']);

  const only = await listRepos({
    owner: 'acme',
    archived: 'only',
    request: fakeGitHub(entries()).request,
  });
  assert.deepEqual(names(only.repos), ['old']);

  const both = await listRepos({
    owner: 'acme',
    archived: 'include',
    request: fakeGitHub(entries()).request,
  });
  assert.deepEqual(names(both.repos), ['live', 'old']);
});

test('repeated filters are OR-ed across a paged listing', async () => {
  const { request } = fakeGitHub([
    'companyA-api',
    'unrelated',
    'shared.packages.internal.core',
    'companyA-web',
    'other',
  ]);
  const { repos } = await listRepos({
    owner: 'acme',
    patterns: ['companyA*', '*packages.internal*'],
    request,
  });

  assert.deepEqual(names(repos), ['companyA-api', 'companyA-web', 'shared.packages.internal.core']);
});

test('a name filter and a language filter must both hold', async () => {
  const { request } = fakeGitHub([
    row('companyA-api', { language: 'C#' }),
    row('companyA-web', { language: 'TypeScript' }),
    row('other-api', { language: 'C#' }),
  ]);
  const { repos } = await listRepos({
    owner: 'acme',
    patterns: ['companyA*'],
    language: ['C#'],
    request,
  });
  assert.deepEqual(names(repos), ['companyA-api']);
});

// The breakdown is a request per repository, so it must never be asked about
// repositories that a cheaper filter has already ruled out.
test('language breakdowns are fetched only for what survived every other filter', async () => {
  const entries = [
    { ...row('companyA-api'), name: 'companyA-api', langs: { 'C#': 90, Shell: 10 } },
    { ...row('companyA-web'), name: 'companyA-web', langs: { TypeScript: 100 } },
    { ...row('other'), name: 'other', langs: { 'C#': 100 } },
  ];

  const plain = fakeGitHub(entries);
  await listRepos({ owner: 'acme', patterns: ['companyA*'], request: plain.request });
  assert.equal(
    plain.calls.filter((args) => /\/languages$/.test(pathOf(args))).length,
    0,
    'nothing asks for a breakdown unless --uses does',
  );

  const used = fakeGitHub(entries);
  const { repos } = await listRepos({
    owner: 'acme',
    patterns: ['companyA*'],
    uses: ['shell'],
    request: used.request,
  });

  assert.deepEqual(names(repos), ['companyA-api']);
  assert.equal(
    used.calls.filter((args) => /\/languages$/.test(pathOf(args))).length,
    2,
    'only the two repositories the name filter kept',
  );
});

test('a breakdown is ordered largest first', async () => {
  const request = async () => ({ Shell: 10, 'C#': 90 });
  const [repo] = await attachLanguages([{ nameWithOwner: 'acme/api' }], { request });
  assert.deepEqual(repo.languages, ['C#', 'Shell']);
});

test('a team needs an owner to be looked up in', async () => {
  await assert.rejects(listRepos({ team: 'payments' }), /--team needs --owner/);
});

test('a team listing is planned from the team, not the organisation', async () => {
  const { request, calls } = fakeGitHub(['a', 'b'], { teamRepos: 2 });
  const { repos } = await listRepos({ owner: 'acme', team: 'payments', request });

  assert.deepEqual(names(repos), ['a', 'b']);
  assert.ok(
    !calls.some((args) => pathOf(args) === 'users/acme'),
    'the organisation is never enumerated when a team was named',
  );
});

test('planning reports where a listing comes from and how big it looks', async () => {
  const { request } = fakeGitHub(['a', 'b', 'c']);
  assert.deepEqual(await planListing({ owner: 'acme', request }), {
    path: 'orgs/acme/repos',
    query: [],
    expected: 3,
  });
});

test('the pool keeps results in the order the items were given', async () => {
  const out = await pool([30, 10, 20], 3, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(out, [30, 10, 20]);
});

test('a transient failure is retried, and a real one is not', async () => {
  let attempts = 0;
  const flaky = async (args) => {
    if (/\/repos\?/.test(pathOf(args))) {
      attempts += 1;
      if (attempts < 3) throw new GhError('HTTP 502: 502 Bad Gateway');
      return [row('a')];
    }
    return { type: 'Organization', public_repos: 1, total_private_repos: 0 };
  };

  const { nodes } = await fetchRepos({ owner: 'acme', request: flaky });
  assert.deepEqual(names(nodes), ['a']);
  assert.equal(attempts, 3, 'a 502 is worth another try');

  const broken = async (args) => {
    if (/\/repos\?/.test(pathOf(args))) throw new GhError('HTTP 401: Bad credentials');
    return { type: 'Organization', public_repos: 1, total_private_repos: 0 };
  };
  await assert.rejects(fetchRepos({ owner: 'acme', request: broken }), /Bad credentials/);
});

// A listing endpoint answers with an array. Anything else compares against the
// page size as NaN, which reads as "that page was full" and asks forever.
test('a listing endpoint answering with anything but an array is refused', async () => {
  const request = async (args) =>
    /\/repos\?/.test(pathOf(args))
      ? { message: 'something unexpected' }
      : { type: 'Organization', public_repos: 1, total_private_repos: 0 };

  await assert.rejects(fetchRepos({ owner: 'acme', request }), /unexpected shape/);
});

// `users/{login}/repos` answers with public repositories only, even when the
// login is your own — naming yourself must not show less than naming nobody.
test('your own account is listed the way no owner at all is', async () => {
  const seen = [];
  const request = async (args) => {
    const path = pathOf(args);
    seen.push(path);
    if (path === 'users/me') return { type: 'User', public_repos: 1 };
    if (path === 'user') return { login: 'Me', public_repos: 1, total_private_repos: 1 };
    return [row('open'), row('secret', { private: true, visibility: 'private' })];
  };

  // Spelled with different case, because GitHub logins are not case-sensitive.
  const { repos } = await listRepos({ owner: 'me', request });
  assert.deepEqual(names(repos), ['open', 'secret']);
  assert.ok(
    seen.some((path) => /^user\/repos\?.*affiliation=owner/.test(path)),
    'the authenticated listing is the one that carries private repositories',
  );
});

test('another account shows only what it makes public', async () => {
  const seen = [];
  const request = async (args) => {
    const path = pathOf(args);
    seen.push(path);
    if (path === 'users/someone') return { type: 'User', public_repos: 1 };
    if (path === 'user') return { login: 'Me', public_repos: 1, total_private_repos: 1 };
    return [row('theirs')];
  };

  const { repos } = await listRepos({ owner: 'someone', request });
  assert.deepEqual(names(repos), ['theirs']);
  assert.ok(seen.some((path) => /^users\/someone\/repos\?/.test(path)));
});

test('a meter whose plan was short grows instead of sitting at full', async () => {
  const { request } = fakeGitHub(['a', 'b', 'c', 'd'], { counted: 2 });
  const seen = [];
  await fetchRepos({ owner: 'acme', request, pageSize: 2, concurrency: 1, onPage: (p) => seen.push(p) });

  assert.deepEqual(seen, [
    { fetched: 2, total: 2 },
    { fetched: 4, total: 4 },
    { fetched: 4, total: 4 },
  ]);
});
