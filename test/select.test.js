import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globToRegExp, isGlob } from '../src/glob.js';
import { normalize, selectRepos } from '../src/github/repos.js';

const repo = (name, extra = {}) =>
  normalize({
    name,
    nameWithOwner: `Fubar83/${name}`,
    owner: { login: 'Fubar83' },
    url: `https://github.com/Fubar83/${name}`,
    sshUrl: `git@github.com:Fubar83/${name}.git`,
    description: null,
    primaryLanguage: { name: 'C#' },
    defaultBranchRef: { name: 'main' },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    visibility: 'PUBLIC',
    updatedAt: '2026-09-01T10:00:00Z',
    pushedAt: '2026-09-01T10:00:00Z',
    ...extra,
  });

const names = (repos) => repos.map((r) => r.name);

test('glob is anchored and case-insensitive', () => {
  assert.ok(globToRegExp('fubar-*').test('fubar-api'));
  assert.ok(globToRegExp('fubar-*').test('FUBAR-Api'));
  assert.ok(!globToRegExp('fubar-*').test('my-fubar-api'));
  assert.ok(globToRegExp('*fubar-*').test('my-fubar-api'));
});

test('? matches exactly one character', () => {
  assert.ok(globToRegExp('svc-?').test('svc-1'));
  assert.ok(!globToRegExp('svc-?').test('svc-12'));
});

test('regex metacharacters in a pattern are literal', () => {
  assert.ok(globToRegExp('web.api').test('web.api'));
  assert.ok(!globToRegExp('web.api').test('webxapi'));
});

test('isGlob only sees * and ?', () => {
  assert.ok(isGlob('fubar-*'));
  assert.ok(isGlob('svc-?'));
  assert.ok(!isGlob('Fubar83'));
});

test('no patterns keeps everything', () => {
  const repos = [repo('fubar-api'), repo('other')];
  assert.deepEqual(names(selectRepos(repos)), ['fubar-api', 'other']);
});

test('patterns are OR-ed', () => {
  const repos = [repo('fubar-api'), repo('fubar-web'), repo('other')];
  assert.deepEqual(names(selectRepos(repos, { patterns: ['fubar-api', '*-web'] })), [
    'fubar-api',
    'fubar-web',
  ]);
});

test('exclude wins over include', () => {
  const repos = [repo('fubar-api'), repo('fubar-api-legacy')];
  assert.deepEqual(names(selectRepos(repos, { patterns: ['fubar-*'], exclude: ['*-legacy'] })), [
    'fubar-api',
  ]);
});

test('a pattern with a slash matches owner/name', () => {
  const repos = [repo('fubar-api')];
  assert.deepEqual(names(selectRepos(repos, { patterns: ['Fubar83/fubar-*'] })), ['fubar-api']);
  assert.deepEqual(selectRepos(repos, { patterns: ['other-org/*'] }), []);
});

test('the match subject is decided per pattern, not per call', () => {
  const repos = [repo('fubar-api'), repo('widget')];
  const selected = selectRepos(repos, { patterns: ['Fubar83/fubar-*', 'widget'] });
  assert.deepEqual(names(selected), ['fubar-api', 'widget']);
});

test('normalize flattens gh nested fields', () => {
  const r = repo('fubar-api', { description: null, visibility: 'PRIVATE', isPrivate: true });
  assert.equal(r.owner, 'Fubar83');
  assert.equal(r.language, 'C#');
  assert.equal(r.defaultBranch, 'main');
  assert.equal(r.description, '');
  assert.equal(r.visibility, 'private');
});

test('normalize tolerates missing optional objects', () => {
  const r = normalize({
    name: 'bare',
    nameWithOwner: 'Fubar83/bare',
    isPrivate: true,
    isArchived: false,
    isFork: false,
  });
  assert.equal(r.owner, 'Fubar83');
  assert.equal(r.language, null);
  assert.equal(r.defaultBranch, null);
  assert.equal(r.visibility, 'private');
});
