import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? files(`${directory}/${entry.name}`) : `${directory}/${entry.name}`,
      ),
    )
  ).flat();
}
const sources = (await Promise.all(['src', 'shared', 'api', 'server', 'public'].map(files))).flat();
for (const file of sources.filter((name) => name.endsWith('.js'))) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status) {
    process.stderr.write(check.stderr);
    process.exit(check.status);
  }
  const content = await readFile(file, 'utf8');
  if (
    /127\.0\.0\.1:47831|localhost:47831|invalid-diagnostic-key|dummy-test-key|mock-system-secret|QUOTA_BRIDGE|__test|__debug/.test(
      content,
    )
  ) {
    throw new Error(`Legacy or debug code in ${file}`);
  }
}
console.log(`Checked ${sources.length} source files; no desktop bridge or debug entry points.`);
