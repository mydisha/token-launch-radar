// Token launch radar (token-radar-01). Node 22, standard library only.
//
// Reads the sealed snapshot, values every protocol that records no token against what the market pays for
// protocols that do, ranks them, writes board.json and the dashboard's data, copies dashboard/ and
// screenshots/ and ends with dossier.json. The run is deterministic: no clock, no randomness.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript } from './lib/board.ts';
import { parseSnapshot, SnapshotError } from './lib/model.ts';
import { dashboardIssue, screenshotsIssue } from './lib/outcheck.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1]! : fallback;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`radar: ${message}\n`);
  process.exit(code);
}

const inputPath = option('input', '/input');
const snapshotFile = inputPath.endsWith('.json') ? inputPath : join(inputPath, 'snapshot.json');
if (!existsSync(snapshotFile)) fail(`no snapshot at ${snapshotFile}; pass --input <file or folder>`, 2);
const outDir = option('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

let built;
try {
  const snapshot = parseSnapshot(readFileSync(snapshotFile, 'utf8'));
  built = { snapshot, ...buildRadar(snapshot) };
} catch (e) {
  if (e instanceof SnapshotError) fail(e.message, 2);
  throw e;
}
const { snapshot, rows, radar } = built;

const issue = boardIssue(rows, snapshot);
if (issue !== null) fail(`the board fails the gate: ${issue}`);

const dashboardDir = join(here, 'dashboard');
const shotsDir = join(here, 'screenshots');
const dashProblem = dashboardIssue(dashboardDir);
if (dashProblem !== null) fail(`dashboard: ${dashProblem}`);
const shotProblem = screenshotsIssue(shotsDir);
if (shotProblem !== null) fail(`screenshots: ${shotProblem}`);

// Start from an empty output folder so a rerun writes exactly the same files.
rmSync(join(outDir, 'dashboard'), { recursive: true, force: true });
rmSync(join(outDir, 'screenshots'), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));
cpSync(dashboardDir, join(outDir, 'dashboard'), { recursive: true });
cpSync(shotsDir, join(outDir, 'screenshots'), { recursive: true });

// The dossier goes last: the scorer rebuilds it from this folder and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

process.stdout.write(
  `radar: ${radar.counts.protocols} protocols, ${radar.counts.watchlist} on the watchlist, ${radar.counts.board} ranked ` +
    `(${radar.counts.early} beyond the watchlist), valued against ${radar.counts.live} live-token comparables\n`,
);
