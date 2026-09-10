#!/usr/bin/env node
// Release invariant: the downloadable Fusion add-in contains every checked-in
// Runner source file (except per-machine runtime state) byte-for-byte. Keep
// this separate from the build script so CI and a developer can verify an
// existing artifact without rebuilding it first.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runnerDir = join(repoRoot, 'autocam', 'fusion', 'runner');
const archive = join(repoRoot, 'static', 'downloads', 'SpartanRoboticsAutoCAM-FusionAddIn.zip');
const archiveRoot = 'SpartanRoboticsAutoCAM/';

function isRuntimeFile(relativePath) {
  return relativePath === '.env'
    || relativePath === '.overridepath'
    || relativePath === 'deps'
    || relativePath.startsWith('deps/')
    || relativePath === 'temp'
    || relativePath.startsWith('temp/')
    || relativePath.split('/').includes('__pycache__')
    || relativePath.endsWith('.pyc')
    || relativePath === '.DS_Store';
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    const filePath = relative(runnerDir, fullPath).split('\\').join('/');
    if (isRuntimeFile(filePath)) continue;
    if (entry.isDirectory()) files.push(...sourceFiles(fullPath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files.sort();
}

function hash(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function fail(message) {
  console.error(`verify-fusion-runner-zip: ${message}`);
  process.exit(1);
}

if (!existsSync(runnerDir)) fail(`Runner source not found: ${runnerDir}`);
if (!existsSync(archive)) fail(`Package not found: ${archive}. Run the package build first.`);

const source = sourceFiles(runnerDir);
const archived = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
  .split('\n')
  .filter((entry) => entry.startsWith(archiveRoot) && !entry.endsWith('/'))
  .map((entry) => entry.slice(archiveRoot.length))
  .sort();
const expected = new Set(source);
const actual = new Set(archived);
const missing = [...expected].filter((path) => !actual.has(path));
const unexpected = [...actual].filter((path) => !expected.has(path));
if (missing.length || unexpected.length) {
  fail(`file set differs from source; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
}

for (const filePath of source) {
  // The release version is intentionally rewritten for every package.
  if (filePath === 'runner_release.json') continue;
  const packaged = execFileSync('unzip', ['-p', archive, `${archiveRoot}${filePath}`]);
  const checkedIn = readFileSync(join(runnerDir, filePath));
  if (hash(packaged) !== hash(checkedIn)) fail(`${filePath} differs from Runner source`);
}

const release = JSON.parse(execFileSync('unzip', ['-p', archive, `${archiveRoot}runner_release.json`], { encoding: 'utf8' }));
if (!release.version) fail('packaged runner_release.json has no version');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'static', 'downloads', 'SpartanRoboticsAutoCAM-FusionAddIn.manifest.json'), 'utf8'));
if (manifest.downloadUrl !== `/downloads/SpartanRoboticsAutoCAM-FusionAddIn.zip?v=${encodeURIComponent(release.version)}`) {
  fail('manifest download URL is not pinned to its release version');
}

console.log(`verify-fusion-runner-zip: ${source.length} Runner files match ${archive}`);
