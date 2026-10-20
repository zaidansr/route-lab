import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);

test('CLI launches the full demo and shuts down all resources on its duration limit', { timeout: 8000 }, async () => {
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const { stdout, stderr } = await run(process.execPath, [cli, 'demo', '--dashboard-port', '0', '--app-port', '0', '--duration-ms', '700'], { timeout: 5000, windowsHide: true });
  assert.match(stdout, /RouteLab is running/);
  assert.match(stdout, /Dashboard: http:\/\/127\.0\.0\.1:\d+/);
  assert.match(stdout, /Opt-in UDP endpoint: 127\.0\.0\.1:\d+/);
  assert.equal(stderr, '');
});
