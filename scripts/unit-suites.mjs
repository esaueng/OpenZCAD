import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT_FULL_INCLUDE = [
  'test/**/*.test.ts',
  'packages/*/src/**/*.test.ts'
];
const repository = new URL('../', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('../test/unit-ci-files.json', import.meta.url), 'utf8')
);

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
  if (resolveUnitSuite(env) === 'full')
    return project === 'root' ? [...ROOT_FULL_INCLUDE] : undefined;
  return validateUnitFiles(project, manifest[project]);
}
