// Promotes the stable (production) channel to a commit that beta already ran.
//
//   pnpm promote:stable <sha> --dry-run                            (preview)
//   gh workflow run promote-stable.yml --ref main -f commit=<sha>  (release)
//
// Workers Builds deploys the openzcad-stable Worker from the `stable` branch,
// so moving that branch is the release. Only the Promote stable workflow can
// move it (a ruleset restricts updates to its deploy key), so a real push
// runs only in GitHub Actions; locally the script plans and dry-runs. It
// only ever fast-forwards: the target must already be on origin/main
// (merged through the queue, deployed to beta), and the current
// origin/stable must be its ancestor. Nothing is
// committed to `stable` directly, so it never drifts from main.
// docs/release-channels.md describes the channels.
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const MIGRATIONS_DIR = 'apps/web/migrations';

function realGit(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(
      `git ${args.join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`
    );
  }
}

function isAncestor(git, ancestor, descendant) {
  return (
    git(['merge-base', '--is-ancestor', ancestor, descendant], {
      allowFailure: true
    }) !== null
  );
}

/**
 * Works out what promoting `target` would do, or why it must not happen.
 * Returns { target, current, commits, migrations } or throws.
 */
export function planPromotion(target, { git = realGit } = {}) {
  if (!target) {
    throw new Error(
      'Name the commit to promote, e.g. pnpm promote:stable <sha>. Use a commit beta has run.'
    );
  }
  if (!/^[0-9a-f]{7,40}$/i.test(target)) {
    throw new Error(
      `${target} is not a commit SHA; name the commit, not a ref`
    );
  }
  git(['fetch', '--quiet', 'origin', 'main']);
  git(['fetch', '--quiet', 'origin', 'stable'], { allowFailure: true });
  const sha = git(['rev-parse', '--verify', `${target}^{commit}`], {
    allowFailure: true
  });
  if (!sha) throw new Error(`${target} is not a commit`);
  if (!isAncestor(git, sha, 'origin/main')) {
    throw new Error(
      `${sha} is not on origin/main; stable only takes commits that merged to main`
    );
  }
  const current = git(['rev-parse', '--verify', 'origin/stable^{commit}'], {
    allowFailure: true
  });
  if (current && current === sha) {
    return { target: sha, current, commits: [], migrations: [] };
  }
  if (current && !isAncestor(git, current, sha)) {
    throw new Error(
      `origin/stable (${current}) is not an ancestor of ${sha}; promotion only fast-forwards`
    );
  }
  // The first promotion creates the branch; listing all history helps nobody.
  const commits = (
    git([
      'log',
      '--format=%h %s',
      ...(current ? [`${current}..${sha}`] : ['-1', sha])
    ]) ?? ''
  )
    .split('\n')
    .filter(Boolean);
  const migrations = current
    ? (
        git([
          'diff',
          '--name-only',
          '--diff-filter=A',
          current,
          sha,
          '--',
          MIGRATIONS_DIR
        ]) ?? ''
      )
        .split('\n')
        .filter(Boolean)
    : [];
  return { target: sha, current, commits, migrations };
}

export const PROMOTE_COMMAND =
  'gh workflow run promote-stable.yml --ref main -f commit=<sha>';

export function promote(
  target,
  {
    git = realGit,
    dryRun = false,
    log = console.log,
    environment = process.env
  } = {}
) {
  if (!dryRun && environment.GITHUB_ACTIONS !== 'true') {
    throw new Error(
      `Only the Promote stable workflow can move stable. Run: ${PROMOTE_COMMAND.replace('<sha>', target ?? '<sha>')} (or add --dry-run here to preview).`
    );
  }
  const plan = planPromotion(target, { git });
  if (plan.commits.length === 0) {
    log(`stable is already at ${plan.target}.`);
    return plan;
  }
  log(
    `Promoting stable ${plan.current ?? '(new branch)'} -> ${plan.target}: ${plan.commits.length} commit(s).`
  );
  for (const line of plan.commits.slice(0, 50)) log(`  ${line}`);
  if (plan.commits.length > 50) log(`  … and ${plan.commits.length - 50} more`);
  if (plan.migrations.length) {
    log('The stable deploy applies these D1 migrations to openzcad-stable:');
    for (const file of plan.migrations) log(`  ${file}`);
  }
  if (dryRun) {
    log('Dry run: nothing pushed.');
    return plan;
  }
  git(['push', 'origin', `${plan.target}:refs/heads/stable`]);
  log('Pushed. Workers Builds now deploys openzcad-stable from stable.');
  return plan;
}

if (process.argv[1]?.endsWith('promote-stable.mjs')) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const target = args.find((arg) => !arg.startsWith('--'));
  try {
    promote(target, { dryRun });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
