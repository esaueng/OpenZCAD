import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { privateArtifactPaths } from './support/privateArtifacts';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'h02-private-paths-'));
  directories.push(directory);
  const repository = join(directory, 'repo');
  const outside = join(directory, 'private');
  mkdirSync(repository);
  mkdirSync(outside);
  return { directory, repository, outside };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('keeps external samples and nested new artifacts in their canonical directory', () => {
  const { directory, repository, outside } = fixture();
  const alias = join(directory, 'external-alias');
  symlinkSync(outside, alias, 'dir');
  const paths = privateArtifactPaths(
    join(alias, 'new', 'session.jsonl'),
    repository
  );
  expect(paths.output).toBe(join(outside, 'new', 'session.jsonl'));
  expect(paths.artifact('reports/nested/artifact.json')).toBe(
    join(outside, 'new', 'reports', 'nested', 'artifact.json')
  );
  expect(() => paths.artifact('../escape.json')).toThrow('output directory');
  expect(() => paths.artifact('.')).toThrow('overlap the sample');
});

it('rejects a repository sample symlink even when its target is external', () => {
  const { repository, outside } = fixture();
  const destination = join(outside, 'session.jsonl');
  writeFileSync(destination, 'dummy sample');
  const output = join(repository, 'external-output.jsonl');
  symlinkSync(destination, output);
  expect(() => privateArtifactPaths(output, repository)).toThrow(
    'outside the repository'
  );
});

it('protects the whole checkout when a package command uses another working directory', () => {
  const { outside } = fixture();
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(outside);
  try {
    expect(() =>
      privateArtifactPaths(
        fileURLToPath(new URL('../private-session.jsonl', import.meta.url))
      )
    ).toThrow('outside the repository');
  } finally {
    cwd.mockRestore();
  }
});

it('rejects output and parent symlinks into the repository', () => {
  const { directory, repository, outside } = fixture();
  const target = join(repository, 'source.jsonl');
  writeFileSync(target, 'dummy source');
  const output = join(outside, 'session.jsonl');
  symlinkSync(target, output);
  expect(() => privateArtifactPaths(output, repository)).toThrow(
    'outside the repository'
  );
  const alias = join(directory, 'repo-alias');
  symlinkSync(repository, alias, 'dir');
  expect(() =>
    privateArtifactPaths(join(alias, 'new', 'sample.jsonl'), repository)
  ).toThrow('outside the repository');
});

it('resolves a valid external output-file symlink before deriving artifacts', () => {
  const { directory, repository, outside } = fixture();
  const targetDirectory = join(directory, 'other-private');
  mkdirSync(targetDirectory);
  const destination = join(targetDirectory, 'session.jsonl');
  writeFileSync(destination, 'dummy sample');
  const output = join(outside, 'linked-session.jsonl');
  symlinkSync(destination, output);
  const paths = privateArtifactPaths(output, repository);
  expect(paths.output).toBe(destination);
  expect(paths.artifact('private-session.openzcad')).toBe(
    join(targetDirectory, 'private-session.openzcad')
  );
});

it('rejects derived artifact symlinks and dangling links before writing', () => {
  const { repository, outside } = fixture();
  const paths = privateArtifactPaths(
    join(outside, 'session.jsonl'),
    repository
  );
  const target = join(repository, 'source.openzcad');
  writeFileSync(target, 'dummy source');
  symlinkSync(target, join(outside, 'private-session.openzcad'));
  symlinkSync(repository, join(outside, 'browser-artifacts'), 'dir');
  symlinkSync(join(repository, 'missing'), join(outside, 'dangling'));
  expect(() => paths.artifact('private-session.openzcad')).toThrow(
    'outside the repository'
  );
  expect(() => paths.artifact('browser-artifacts/nested/error.json')).toThrow(
    'outside the repository'
  );
  expect(() => paths.artifact('dangling')).toThrow('cannot be resolved');
  expect(readFileSync(target, 'utf8')).toBe('dummy source');
});

it('rejects cleanup targets that contain the checkout while permitting shared sample parents', () => {
  const { directory, outside } = fixture();
  const repository = join(outside, 'nested-repo');
  mkdirSync(repository);
  const paths = privateArtifactPaths(
    join(directory, 'samples.jsonl'),
    repository
  );
  symlinkSync(outside, join(directory, 'h02-artifacts'), 'dir');
  expect(() => paths.artifact('h02-artifacts')).toThrow(
    'overlap the repository'
  );
  expect(() => paths.artifact('private')).toThrow('overlap the repository');
  expect(paths.artifact('other-artifacts')).toBe(
    join(directory, 'other-artifacts')
  );
});

it.each(['h02-build-enabled', 'h02-private-session-artifacts'])(
  'rejects a sample named exactly like the %s artifact',
  (name) => {
    const { repository, outside } = fixture();
    const paths = privateArtifactPaths(join(outside, name), repository);
    expect(() => paths.artifact(name)).toThrow('overlap the sample');
  }
);

it('rejects artifact targets both below and above the canonical sample path', () => {
  const { repository, outside } = fixture();
  const paths = privateArtifactPaths(
    join(outside, 'samples.jsonl'),
    repository
  );
  expect(() => paths.artifact('samples.jsonl/child')).toThrow(
    'overlap the sample'
  );
  const nested = privateArtifactPaths(
    join(outside, 'reports', 'samples.jsonl'),
    repository
  );
  expect(() => nested.artifact('.')).toThrow('overlap the sample');
  expect(() => nested.artifact('..')).toThrow('overlap the sample');
  expect(nested.artifact('other-artifacts')).toBe(
    join(outside, 'reports', 'other-artifacts')
  );
});

it('rejects relative sample paths and refuses overwriting a prior private backup', () => {
  const { repository, outside } = fixture();
  expect(() => privateArtifactPaths('session.jsonl', repository)).toThrow(
    'absolute'
  );
  const paths = privateArtifactPaths(
    join(outside, 'session.jsonl'),
    repository
  );
  const backup = paths.artifact('private-session.openzcad');
  writeFileSync(backup, 'first dummy backup', { flag: 'wx', mode: 0o600 });
  expect(() =>
    writeFileSync(paths.artifact('private-session.openzcad'), 'replacement', {
      flag: 'wx',
      mode: 0o600
    })
  ).toThrow();
  expect(readFileSync(backup, 'utf8')).toBe('first dummy backup');
});
