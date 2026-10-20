import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
test('Both dashboard scripts compile without browser execution', async () => {
  for (const name of ['index.html', 'game.html']) {
    const html = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    new Script(scripts[0][1], { filename: name });
  }
});
