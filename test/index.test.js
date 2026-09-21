import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The package's own entry point.
 *
 * Nothing else here imports it: the CLI reaches into src/ directly, and so do
 * these tests. A name in a re-export that the source module does not provide
 * is a link-time error, so a barrel that has drifted from its sources throws
 * for anyone importing the package as a library while the command itself goes
 * on working — which is exactly how it survives a release. Its sibling `nuls`
 * shipped two versions that way.
 *
 * Importing it here is the whole point of the test.
 */
test('the package entry point can be imported', async () => {
  const module = await import('../src/index.js');
  assert.ok(module, 'importing the entry point must not throw');
});

test('every name the entry point exports is actually defined', async () => {
  const module = await import('../src/index.js');
  const missing = Object.entries(module)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);

  assert.deepEqual(missing, [], `re-exported but undefined: ${missing.join(', ')}`);
});
