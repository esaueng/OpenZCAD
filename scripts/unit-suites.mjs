import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

export const ROOT_FULL_INCLUDE = [
  'test/**/*.test.ts',
  'packages/*/src/**/*.test.ts'
];
const repository = new URL('../', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('../test/unit-ci-files.json', import.meta.url), 'utf8')
);

/** Enumerate every root Vitest file matching ROOT_FULL_INCLUDE, sorted. */
export function listRootUnitFiles(rootDir = fileURLToPath(repository)) {
  const files = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      // Vitest's include glob follows symlinks; so must the shard inventory.
      const kind = entry.isSymbolicLink()
        ? statSync(full, { throwIfNoEntry: false })
        : entry;
      if (!kind) continue;
      if (kind.isDirectory()) visit(full);
      else if (kind.isFile() && entry.name.endsWith('.test.ts')) {
        files.push(relative(rootDir, full).split(sep).join('/'));
      }
    }
  };
  visit(join(rootDir, 'test'));
  const packagesDir = join(rootDir, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(packagesDir, entry.name, 'src'));
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/** Local runs and kernel qualification retain full coverage by default. */
export function resolveUnitSuite(env = process.env) {
  const overlay = env.REMUS_WASM_PKG || env.REMUS_WASM_IO_PKG;
  const suite =
    env.OPENZCAD_UNIT_SUITE ?? (env.CI && !overlay ? 'smoke' : 'full');
  if (suite !== 'smoke' && suite !== 'full') {
    throw new Error(`Unknown unit suite "${suite}"; use smoke or full.`);
  }
  return suite;
}

/** Fail on stale, duplicate or out-of-project entries before Vitest starts. */
export function validateUnitFiles(project, files) {
  if (project !== 'root' && project !== 'web')
    throw new Error(`Unknown unit project "${project}".`);
  if (!Array.isArray(files) || files.length === 0)
    throw new Error(`${project} unit smoke suite is empty.`);
  const pattern =
    project === 'root'
      ? /^(?:test\/|packages\/[^/]+\/src\/)[A-Za-z0-9._/-]+\.test\.ts$/
      : /^(?:src|worker)\/[A-Za-z0-9._/-]+\.test\.tsx?$/;
  const seen = new Set();
  const base =
    project === 'root' ? repository : new URL('apps/web/', repository);
  for (const file of files) {
    if (
      typeof file !== 'string' ||
      !pattern.test(file) ||
      file.split('/').some((part) => part === '..' || part === '.' || !part)
    ) {
      throw new Error(`Invalid ${project} unit smoke path: ${file}`);
    }
    if (seen.has(file))
      throw new Error(`Duplicate ${project} unit smoke path: ${file}`);
    seen.add(file);
    if (!existsSync(fileURLToPath(new URL(file, base))))
      throw new Error(`Missing ${project} unit smoke file: ${file}`);
  }
  return [...files];
}

export function unitTestInclude(project, env = process.env) {
  if (project !== 'root' && project !== 'web')
    throw new Error(`Unknown unit project "${project}".`);
  if (env.OPENZCAD_UNIT_FILES) {
    const selection = JSON.parse(env.OPENZCAD_UNIT_FILES);
    return validateUnitFiles(project, selection[project]);
  }
  if (resolveUnitSuite(env) === 'full')
    return project === 'root' ? [...ROOT_FULL_INCLUDE] : undefined;
  return validateUnitFiles(project, manifest[project]);
}
