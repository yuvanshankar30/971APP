#!/usr/bin/env node
// Packages autocam/fusion/runner/ into a ready-to-install zip at
// static/downloads/SpartanRoboticsAutoCAM.zip, served by the Fusion AutoCAM
// setup page (src/routes/autocam/fusion/setup/+page.svelte).
//
// Runs as an npm prebuild/predev hook (see package.json), not committed to
// git (static/downloads/ is gitignored) - regenerated fresh from whatever
// autocam/fusion/runner/ actually contains every time, so it can never go
// stale the way a manually-committed zip would. Only static/ survives into
// the production runtime image (see Dockerfile's multi-stage copy - the raw
// source tree does not), so this has to produce a real file under static/
// before the Vite build runs, not serve one dynamically at request time.
//
// The zip's own top-level folder is already named SpartanRoboticsAutoCAM,
// matching what Fusion requires (see docs/team-setup-guide.md) - a user
// unzips straight into their AddIns folder with no manual rename step.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const runnerSrc = join(repoRoot, 'autocam', 'fusion', 'runner');
const outDir = join(repoRoot, 'static', 'downloads');
const outFile = join(outDir, 'SpartanRoboticsAutoCAM-FusionAddIn.zip');
const manifestFile = join(outDir, 'SpartanRoboticsAutoCAM-FusionAddIn.manifest.json');

function releaseVersion() {
  if (process.env.K_REVISION) return process.env.K_REVISION;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return JSON.parse(readFileSync(join(runnerSrc, 'runner_release.json'), 'utf8')).version;
  }
}

if (!existsSync(runnerSrc)) {
  console.error(`build-fusion-runner-zip: ${runnerSrc} not found, skipping`);
  process.exit(0);
}

const stagingRoot = mkdtempSync(join(tmpdir(), 'fusion-runner-zip-'));
const stagingDir = join(stagingRoot, 'SpartanRoboticsAutoCAM');

try {
  // __pycache__ is local build noise and does not belong in a real install.
  cpSync(runnerSrc, stagingDir, {
    recursive: true,
    filter: (src) => !/(^|\/)__pycache__(\/|$)/.test(src.slice(runnerSrc.length))
  });

  // The add-in itself (SpartanRoboticsAutoCAM.py's _ENV_PATH) only ever
  // reads a file literally named ".env" - .env.example alone (the repo's
  // own real-secrets-safe reference copy, gitignored as .env is) leaves a
  // fresh install with nothing to actually read until a user manually
  // renames/copies it themselves, undocumented. Shipping a real .env
  // (still with blank/placeholder values - never real secrets, same
  // "replace-with-..." pattern .env.example already uses) means a fresh
  // unzip already has the right file in place; the add-in's own
  // first-run prompt still fills in the one value (API_KEY) that has no
  // sensible blank default.
  const envExamplePath = join(stagingDir, '.env.example');
  if (existsSync(envExamplePath)) {
    copyFileSync(envExamplePath, join(stagingDir, '.env'));
  }

  // A deployed build's Git revision is the release version. This means any
  // merged Runner/config/template change naturally produces a new remote
  // version for installed add-ins to detect, without a manual version bump.
  writeFileSync(join(stagingDir, 'runner_release.json'), JSON.stringify({ version: releaseVersion() }, null, 2) + '\n');

  mkdirSync(outDir, { recursive: true });
  rmSync(outFile, { force: true });
  execFileSync('zip', ['-r', '-q', outFile, 'SpartanRoboticsAutoCAM'], { cwd: stagingRoot, stdio: 'inherit' });
  const release = JSON.parse(readFileSync(join(stagingDir, 'runner_release.json'), 'utf8'));
  const sha256 = createHash('sha256').update(readFileSync(outFile)).digest('hex');
  writeFileSync(manifestFile, JSON.stringify({
    version: release.version,
    sha256,
    downloadUrl: '/downloads/SpartanRoboticsAutoCAM-FusionAddIn.zip'
  }, null, 2) + '\n');
  console.log(`build-fusion-runner-zip: wrote ${outFile}`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
