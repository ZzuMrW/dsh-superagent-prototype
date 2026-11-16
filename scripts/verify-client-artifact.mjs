#!/usr/bin/env node
/** Build-output module test, run in the source checkout with its pinned dependencies.
 * No DOM, renderer, screenshot, browser profile or network is used. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const dependencies = createRequire(new URL('../package.json', import.meta.url));
const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
let declaration;
runInNewContext(code, {
  window: { __ModuleLoader__: { load: value => { assert.equal(declaration, undefined, 'One module factory only'); declaration = value; } } },
  AbortController, AbortSignal, URL, TextEncoder, TextDecoder, Promise, console, setTimeout, clearTimeout, queueMicrotask,
});
assert.equal(declaration.id, 'dsh-superagent');
const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis']);
const required = new Set();
const plugin = declaration.factory(specifier => {
  assert.ok(allowed.has(specifier), 'Unexpected browser runtime dependency: ' + specifier);
  required.add(specifier);
  return dependencies(specifier);
});
assert.equal(typeof plugin.apply, 'function');
assert.ok(code.includes('file resource provider'), 'Native file provider must be in the built artifact');
console.log(JSON.stringify({ passed: true, id: declaration.id, externals: [...required], singleFactory: true, nativeProviderBundled: true, browserVisualVerified: false }));
