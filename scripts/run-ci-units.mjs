import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  listRootUnitFiles,
  unitTestInclude,
  validateUnitFiles
} from './unit-suites.mjs';
import { changedPaths } from './ci-selection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = fileURLToPath(import.meta.url);

export const UNIT_ROOT_WEIGHTS_PATH = 'test/unit-root-weights.json';
/** Conservative fallback seconds for an unmeasured root unit file. */
export const DEFAULT_UNIT_WEIGHT_SECONDS = 2;

export function relatedFiles(project, data, cwd) {
  if (!Array.isArray(data))
    throw new Error('Vitest file inventory is not an array.');
  const files = data.map((entry) => {
    const file = typeof entry === 'string' ? entry : entry.file;
    if (typeof file !== 'string')
      throw new Error('Vitest inventory lacks a file.');
    const name = relative(cwd, isAbsolute(file) ? file : resolve(cwd, file))
      .split(sep)
      .join('/');
    if (name.startsWith('../') || isAbsolute(name))
      throw new Error('Vitest inventory escaped the project.');
    return name;
  });
  return files.length ? validateUnitFiles(project, [...new Set(files)]) : [];
}

export function selectedFiles(project, related, env = process.env) {
  return validateUnitFiles(project, [
    ...new Set([
      ...unitTestInclude(project, {
        ...env,
        OPENZCAD_UNIT_SUITE: 'smoke',
        OPENZCAD_UNIT_FILES: undefined
      }),
      ...related
    ])
  ]);
}

/** @param {string} value like `2/3` */
export function parseUnitShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(value ?? ''));
  if (!match) throw new Error(`Expected a shard like 2/3, got "${value}".`);
  const shard = Number(match[1]);
  const total = Number(match[2]);
  if (shard > total) throw new Error(`Shard ${shard} exceeds total ${total}.`);
  return { shard, total };
}

export function extractShardArg(args) {
  let shard = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--shard=')) {
      if (shard) throw new Error('Duplicate --shard argument.');
      shard = parseUnitShard(arg.slice('--shard='.length));
    } else if (arg === '--shard') {
      if (shard) throw new Error('Duplicate --shard argument.');
      shard = parseUnitShard(args[++i]);
    } else {
      rest.push(arg);
    }
  }
  return { shard, rest };
}

export function validateUnitWeights(weights) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights))
    throw new Error('Unit weights must be an object.');
  for (const [file, seconds] of Object.entries(weights)) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
      throw new Error(`Invalid unit weight: ${file}`);
  }
  return weights;
}

export function readUnitWeights(path = resolve(root, UNIT_ROOT_WEIGHTS_PATH)) {
  if (!existsSync(path)) return {};
  return validateUnitWeights(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Longest-processing-time-first assignment: heaviest unit file into the
 * lightest shard. Ties break on file path so every shard computes the exact
 * same partition deterministically.
 */
export function partitionUnitFiles(files, weights, total) {
  if (!Number.isInteger(total) || total < 1)
    throw new Error(`Shard total must be a positive integer, got ${total}.`);
  const seconds = (file) => {
    const weight = weights[file];
    return typeof weight === 'number' && Number.isFinite(weight) && weight >= 0
      ? weight
      : DEFAULT_UNIT_WEIGHT_SECONDS;
  };
  const ordered = [...files].sort(
    (a, b) => seconds(b) - seconds(a) || a.localeCompare(b)
  );
  const shards = Array.from({ length: total }, () => ({
    files: [],
    seconds: 0
  }));
  for (const file of ordered) {
    let lightest = shards[0];
    for (const shard of shards) {
      if (shard.seconds < lightest.seconds) lightest = shard;
    }
    lightest.files.push(file);
    lightest.seconds += seconds(file);
  }
  for (const shard of shards) shard.files.sort((a, b) => a.localeCompare(b));
  return shards;
}

const ROOT_TEST_SUFFIX = /(?:^|\/)((?:test|packages\/[^/]+\/src)\/.+\.test\.ts)$/;

/** Extract per-file durations (in seconds, rounded to 0.1s) from Vitest JSON reports. */
export function weightsFromVitestReports(reports, rootDir = root) {
  const totals = {};
  for (const report of reports) {
    for (const entry of report?.testResults ?? []) {
      const raw = typeof entry?.name === 'string' ? entry.name.split('\\').join('/') : '';
      if (!raw) continue;
      let file;
      if (isAbsolute(raw)) {
        const rel = relative(rootDir, raw).split(sep).join('/');
        if (!rel.startsWith('../') && !isAbsolute(rel)) file = rel;
      }
      if (!file) {
        const match = ROOT_TEST_SUFFIX.exec(raw);
        if (match) file = match[1];
      }
      if (!file) continue;
      const start = Number(entry.startTime);
      const end = Number(entry.endTime);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      totals[file] = Math.round(((end - start) / 1000) * 10) / 10;
    }
  }
  return Object.fromEntries(
    Object.keys(totals)
      .sort((a, b) => a.localeCompare(b))
      .map((file) => [file, totals[file]])
  );
}

/** Merge fresh measurements into checked-in weights, pruning deleted test files. */
export function mergeUnitWeights(current, measured, files) {
  const next = {};
  for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
    const value = measured[file] ?? current[file];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      next[file] = value;
    }
  }
  return next;
}

/**
 * Resolve Vitest test files affected by explicit changed file paths without
 * invoking Vitest's Git VCS provider (which uses a three-dot diff that fails
 * on shallow CI clones lacking a merge base).
 */
export async function discoverRelatedFiles(cwd, changedAbsolutePaths) {
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', {
    config: 'vitest.full.config.ts',
    root: cwd,
    watch: false,
    related: changedAbsolutePaths,
    passWithNoTests: true
  });
  try {
    const specs = await vitest.getRelevantTestSpecifications();
    return specs.map((spec) => spec.moduleId);
  } finally {
    await vitest.close();
  }
}

export function runUnits(args, env = process.env, execute = spawnSync) {
  const project = args[0];
  if (!['root', 'web'].includes(project))
    throw new Error('Expected root or web project.');
  const cwd = project === 'root' ? root : resolve(root, 'apps/web');
  const packagePath = fileURLToPath(import.meta.resolve('vitest/package.json'));
  const cli = resolve(
    dirname(packagePath),
    JSON.parse(readFileSync(packagePath, 'utf8')).bin.vitest
  );
  let suite = env.OPENZCAD_UNIT_SUITE ?? 'full';
  if (!['smoke', 'full'].includes(suite))
    throw new Error('Unknown CI unit suite.');
  const temporary = mkdtempSync(resolve(tmpdir(), 'openzcad-ci-units-'));
  let files;
  try {
    if (suite === 'smoke') {
      try {
        if (!/^[0-9a-f]{40}$/.test(env.CI_BASE_SHA ?? ''))
          throw new Error('Missing exact CI base.');
        const changed = changedPaths(env.CI_BASE_SHA, root);
        let related = [];
        if (changed.length > 0) {
          const changedFile = resolve(temporary, 'changed.json');
          const inventory = resolve(temporary, 'related.json');
          writeFileSync(
            changedFile,
            JSON.stringify(changed.map((file) => resolve(root, file)))
          );
          const listed = execute(
            process.execPath,
            [selfPath, '--list-related', project, changedFile, inventory],
            {
              cwd,
              env: {
                ...env,
                OPENZCAD_UNIT_SUITE: 'full',
                OPENZCAD_UNIT_FILES: undefined
              },
              stdio: 'inherit'
            }
          );
          if (listed.error || listed.status !== 0)
            throw new Error('Affected-test discovery failed.');
          related = relatedFiles(
            project,
            JSON.parse(readFileSync(inventory, 'utf8')),
            cwd
          );
        }
        files = selectedFiles(project, related, env);
      } catch (error) {
        console.error(
          `Affected-test discovery requires full validation: ${error.message}`
        );
        suite = 'full';
      }
    }

    const { shard, rest } = extractShardArg(args.slice(1));
    let runFiles = files;
    let shardMeta;
    let vitestArgs = args.slice(1);
    let configFile =
      suite === 'full' ? 'vitest.full.config.ts' : 'vitest.config.ts';

    if (shard && project === 'root') {
      const candidateFiles =
        suite === 'smoke' && files ? files : listRootUnitFiles(root);
      const weights = readUnitWeights();
      const partitions = partitionUnitFiles(
        candidateFiles,
        weights,
        shard.total
      );
      const assigned = partitions[shard.shard - 1];
      if (!assigned.files.length) {
        throw new Error(
          `Unit shard ${shard.shard}/${shard.total} would run no test files.`
        );
      }
      runFiles = assigned.files;
      configFile = 'vitest.config.ts';
      vitestArgs = rest;
      shardMeta = {
        shard: `${shard.shard}/${shard.total}`,
        totalFiles: candidateFiles.length,
        estimatedSeconds: Math.round(assigned.seconds)
      };
      console.error(
        `[ci-units] root suite=${suite} shard=${shardMeta.shard} files=${runFiles.length}/${candidateFiles.length} est=${shardMeta.estimatedSeconds}s`
      );
    } else {
      console.error(
        `[ci-units] ${project} suite=${suite} files=${runFiles ? runFiles.length : 'complete project'}`
      );
    }

    const report = env.CI_UNIT_REPORT;
    if (report)
      writeFileSync(
        `${report}.selection.json`,
        JSON.stringify(
          {
            project,
            suite,
            ...(shardMeta ?? {}),
            base: env.CI_BASE_SHA ?? null,
            files: runFiles ?? 'complete project'
          },
          null,
          2
        )
      );
    const command = [
      cli,
      'run',
      '--config',
      configFile,
      ...vitestArgs
    ];
    if (report)
      command.push(
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${report}`
      );
    const result = execute(process.execPath, command, {
      cwd,
      env: {
        ...env,
        OPENZCAD_UNIT_SUITE: suite,
        OPENZCAD_UNIT_FILES: runFiles
          ? JSON.stringify({ [project]: runFiles })
          : undefined
      },
      stdio: 'inherit'
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '--list-related') {
    const [project, changedFile, outputFile] = rest;
    if (!['root', 'web'].includes(project) || !changedFile || !outputFile) {
      throw new Error(
        'Usage: run-ci-units.mjs --list-related <root|web> <changed.json> <output.json>'
      );
    }
    const cwd = project === 'root' ? root : resolve(root, 'apps/web');
    const changedAbsolutePaths = JSON.parse(readFileSync(changedFile, 'utf8'));
    const discovered = await discoverRelatedFiles(cwd, changedAbsolutePaths);
    writeFileSync(outputFile, JSON.stringify(discovered));
  } else if (command === '--update-weights') {
    if (!rest.length) {
      throw new Error(
        'Pass at least one Vitest JSON report to --update-weights.'
      );
    }
    const reports = rest.map((file) => JSON.parse(readFileSync(file, 'utf8')));
    const allRoot = listRootUnitFiles(root);
    const weightsPath = resolve(root, UNIT_ROOT_WEIGHTS_PATH);
    const next = mergeUnitWeights(
      readUnitWeights(weightsPath),
      weightsFromVitestReports(reports, root),
      allRoot
    );
    writeFileSync(weightsPath, `${JSON.stringify(next, null, 2)}\n`);
    const smokeRoot = unitTestInclude('root', {
      CI: 'true',
      OPENZCAD_UNIT_SUITE: 'smoke',
      OPENZCAD_UNIT_FILES: undefined
    });
    for (const [label, list] of [
      ['smoke', smokeRoot],
      ['full', allRoot]
    ]) {
      const balanced = partitionUnitFiles(list, next, 3);
      console.error(
        `${label} (3 shards): ${balanced.map((s) => `${Math.round(s.seconds)}s (${s.files.length} files)`).join(' | ')}`
      );
    }
  } else {
    process.exitCode = runUnits(process.argv.slice(2));
  }
}
