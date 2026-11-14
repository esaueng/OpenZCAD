/**
 * Checks every installed file of the paired Remus packages against
 * `remus-checksums.json` (see `scripts/remus-artifacts.mjs` for the format).
 * Every Vite build runs the same check (`apps/web/vite.config.ts`), so the
 * root build, filtered web builds and desktop builds all fail on a changed,
 * missing or unlisted file, or a manifest for another Remus commit.
 *
 * Regenerating after a Remus bump: `.github/workflows/update-remus.yml` runs
 * `node scripts/verify-remus-artifacts.mjs --record` after its frozen install,
 * and commits the result with the manifest and lockfile. By hand, after
 * `pnpm install --frozen-lockfile` on the bumped lockfile, run the same
 * command with an authenticated `gh` (requests always go to github.com).
 * Recording takes the expected file list from the pinned commit's upstream
 * tree and the package's `files` list, refuses any installed file that is
 * missing, extra or differs from its upstream blob, and refuses a manifest
 * that drops a previously pinned file unless `--allow-shrink` is passed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MANIFEST,
  installedPackageDirs,
  recordRemusManifest,
  remusPin,
  verifyRemusArtifacts
} from './remus-artifacts.mjs';

const args = process.argv.slice(2);
const unknown = args.filter(
  (arg) => arg !== '--record' && arg !== '--allow-shrink'
);
if (unknown.length > 0) throw new Error(`Unknown option ${unknown.join(' ')}.`);
if (args.includes('--allow-shrink') && !args.includes('--record'))
  throw new Error('--allow-shrink only applies to --record.');

if (args.includes('--record')) {
  const commit = remusPin(readFileSync('pnpm-lock.yaml', 'utf8'));
  const manifest = recordRemusManifest({
    commit,
    packageDirs: installedPackageDirs('.'),
    previous: existsSync(MANIFEST)
      ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
      : null,
    allowShrink: args.includes('--allow-shrink')
  });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}
const { commit, files } = verifyRemusArtifacts({ repoRoot: '.' });
console.log(`Paired Remus package files (${files}) verified at ${commit}.`);
