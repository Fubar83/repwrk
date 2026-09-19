import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize, selectRepos } from '../src/github/repos.js';

/** `languages` mirrors gh's shape: unordered [{ size, node: { name } }]. */
const repo = (name, primary, languages = []) =>
  normalize({
    name,
    nameWithOwner: `Fubar83/${name}`,
    owner: { login: 'Fubar83' },
    primaryLanguage: primary ? { name: primary } : null,
    languages: languages.map(([langName, size]) => ({ size, node: { name: langName } })),
    isArchived: false,
    isFork: false,
    isPrivate: false,
  });

const names = (repos) => repos.map((r) => r.name);

const corpus = [
  repo('api', 'C#', [
    ['PowerShell', 6709],
    ['C#', 78090],
  ]),
  repo('site', 'TypeScript', [
    ['TypeScript', 50000],
    ['C#', 120],
  ]),
  repo('scripts', 'PowerShell', [['PowerShell', 900]]),
  repo('empty', null, []),
];

test('languages are ordered largest first, not as gh returned them', () => {
  assert.deepEqual(corpus[0].languages, ['C#', 'PowerShell']);
});

test('--language matches the primary language only', () => {
  assert.deepEqual(names(selectRepos(corpus, { language: ['C#'] })), ['api']);
});

test('--uses matches any language present, however small', () => {
  assert.deepEqual(names(selectRepos(corpus, { uses: ['C#'] })), ['api', 'site']);
});

test('language matching is case-insensitive', () => {
  assert.deepEqual(names(selectRepos(corpus, { language: ['c#'] })), ['api']);
  assert.deepEqual(names(selectRepos(corpus, { uses: ['powershell'] })), ['api', 'scripts']);
});

test('language patterns accept globs', () => {
  assert.deepEqual(names(selectRepos(corpus, { language: ['Type*'] })), ['site']);
});

test('repeated language flags are OR-ed', () => {
  assert.deepEqual(names(selectRepos(corpus, { language: ['C#', 'PowerShell'] })), [
    'api',
    'scripts',
  ]);
});

test('a repo with no language is never matched by a language filter', () => {
  assert.deepEqual(names(selectRepos(corpus, { language: ['C#', 'TypeScript', 'PowerShell'] })), [
    'api',
    'site',
    'scripts',
  ]);
  assert.deepEqual(selectRepos([repo('empty', null, [])], { uses: ['C#'] }), []);
});

test('language and name filters combine as AND', () => {
  assert.deepEqual(names(selectRepos(corpus, { patterns: ['s*'], uses: ['C#'] })), ['site']);
});

test('language and uses given together must both hold', () => {
  assert.deepEqual(selectRepos(corpus, { language: ['C#'], uses: ['TypeScript'] }), []);
  assert.deepEqual(names(selectRepos(corpus, { language: ['C#'], uses: ['PowerShell'] })), ['api']);
});

test('no language filter leaves the list untouched', () => {
  assert.equal(selectRepos(corpus).length, corpus.length);
});
