import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unitTestInclude, validateUnitFiles } from './unit-suites.mjs';
import { changedPaths } from './ci-selection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
        changedPaths(env.CI_BASE_SHA, root);
        const inventory = resolve(temporary, 'related.json');
        const listed = execute(
          process.execPath,
          [
            cli,
            'list',
            '--config',
            'vitest.full.config.ts',
            '--changed',
            env.CI_BASE_SHA,
            '--filesOnly',
            `--json=${inventory}`
          ],
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
        files = selectedFiles(
          project,
          relatedFiles(
            project,
            JSON.parse(readFileSync(inventory, 'utf8')),
            cwd
          ),
          env
        );
      } catch (error) {
        console.error(
          `Affected-test discovery requires full validation: ${error.message}`
        );
        suite = 'full';
      }
    }
    const report = env.CI_UNIT_REPORT;
    if (report)
      writeFileSync(
        `${report}.selection.json`,
        JSON.stringify(
          {
            project,
            suite,
            base: env.CI_BASE_SHA ?? null,
            files: files ?? 'complete project'
          },
          null,
          2
        )
      );
    const command = [
      cli,
      'run',
      '--config',
      suite === 'full' ? 'vitest.full.config.ts' : 'vitest.config.ts',
      ...args.slice(1)
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
        OPENZCAD_UNIT_FILES: files
          ? JSON.stringify({ [project]: files })
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
)
  process.exitCode = runUnits(process.argv.slice(2));
