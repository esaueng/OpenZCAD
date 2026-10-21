import {
  appendFileSync,
  linkSync,
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
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import {
  privateArtifactPaths,
  privatePlaywrightOutput
} from './support/privateArtifacts';

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

it.each(['same-path', 'symlink', 'hard-link'])(
  'refuses a %s sample alias of the input before appending any bytes',
  (alias) => {
    const { repository, outside } = fixture();
    const source = join(outside, 'source.step');
    const original = Buffer.from('dummy private STEP input\n');
    writeFileSync(source, original);
    const output =
      alias === 'same-path' ? source : join(outside, 'samples.jsonl');
    if (alias === 'symlink') symlinkSync(source, output);
    if (alias === 'hard-link') linkSync(source, output);
    expect(() => {
      const paths = privateArtifactPaths(output, repository, [source]);
      appendFileSync(paths.output, '{"phase":"start"}\n');
    }).toThrow('source input');
    expect(readFileSync(source)).toEqual(original);
  }
);

it.each(['same-path', 'symlink', 'hard-link'])(
  'refuses a %s backup or artifact alias of the protected input',
  (alias) => {
    const { repository, outside } = fixture();
    const source = join(outside, 'source.step');
    const original = Buffer.from('dummy private STEP input\n');
    writeFileSync(source, original);
    const target =
      alias === 'same-path'
        ? source
        : join(outside, 'private-session.openzcad');
    if (alias === 'symlink') symlinkSync(source, target);
    if (alias === 'hard-link') linkSync(source, target);
    const paths = privateArtifactPaths(
      join(outside, 'samples.jsonl'),
      repository,
      [source]
    );
    expect(() => {
      writeFileSync(
        paths.artifact(
          alias === 'same-path' ? 'source.step' : 'private-session.openzcad'
        ),
        'replacement'
      );
    }).toThrow('source input');
    expect(readFileSync(source)).toEqual(original);
  }
);

it('rejects cleanup ancestors of an input, including derived-directory symlinks', () => {
  const { directory, repository, outside } = fixture();
  const sourceDirectory = join(outside, 'sources');
  mkdirSync(sourceDirectory);
  const source = join(sourceDirectory, 'source.step');
  const original = Buffer.from('dummy private STEP input\n');
  writeFileSync(source, original);
  symlinkSync(sourceDirectory, join(outside, 'h02-build-enabled'), 'dir');
  const paths = privateArtifactPaths(
    join(outside, 'samples.jsonl'),
    repository,
    [source]
  );
  expect(() => paths.artifact('h02-build-enabled')).toThrow('source input');
  expect(() => paths.artifact('sources')).toThrow('source input');
  expect(() =>
    privateArtifactPaths(sourceDirectory, repository, [source])
  ).toThrow('source input');
  const alias = join(directory, 'source-alias.step');
  symlinkSync(source, alias);
  expect(
    privateArtifactPaths(join(outside, 'samples.jsonl'), repository, [alias])
      .inputs
  ).toEqual([source]);
  expect(paths.artifact('safe-build')).toBe(join(outside, 'safe-build'));
  expect(readFileSync(source)).toEqual(original);
});

it('fails closed on missing or dangling declared source inputs', () => {
  const { repository, outside } = fixture();
  const source = join(outside, 'missing.step');
  const alias = join(outside, 'dangling.step');
  symlinkSync(source, alias);
  for (const input of [source, alias])
    expect(() =>
      privateArtifactPaths(join(outside, 'samples.jsonl'), repository, [input])
    ).toThrow('cannot be resolved');
});

it('canonicalizes a relative source before a package changes working directory', () => {
  const { repository, outside } = fixture();
  const source = join(outside, 'source.step');
  writeFileSync(source, 'dummy private STEP input');
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(outside);
  try {
    const paths = privateArtifactPaths(
      join(outside, 'samples.jsonl'),
      repository,
      ['source.step']
    );
    expect(paths.inputs).toEqual([source]);
    cwd.mockReturnValue(join(repository, 'apps', 'web'));
    expect(
      privateArtifactPaths(paths.output, repository, paths.inputs).inputs
    ).toEqual([source]);
  } finally {
    cwd.mockRestore();
  }
});

it('validates actual runner artifact directories before a private input is read', () => {
  const { directory, repository, outside } = fixture();
  const source = join(outside, 'source.step');
  writeFileSync(source, 'dummy private STEP input');
  const paths = privateArtifactPaths(
    join(outside, 'samples.jsonl'),
    repository,
    [source]
  );
  expect(() =>
    paths.artifactDirectory(join(repository, 'test-results'))
  ).toThrow('outside the repository');
  expect(() => paths.artifactDirectory(outside)).toThrow('source input');
  expect(() => paths.artifactDirectory(paths.output)).toThrow(
    'overlap the sample'
  );
  expect(() => paths.artifactDirectory('relative-artifacts')).toThrow(
    'absolute'
  );
  const externalArtifacts = join(directory, 'separate-artifacts');
  expect(paths.artifactDirectory(externalArtifacts)).toBe(externalArtifacts);
});

it.each(['directory', 'worktree-file'])(
  'keeps sample and artifact writes outside an unrelated Git checkout (%s)',
  (kind) => {
    const { directory, repository, outside } = fixture();
    const unrelated = join(directory, 'another-repo');
    mkdirSync(unrelated);
    if (kind === 'directory') {
      mkdirSync(join(unrelated, '.git'));
      writeFileSync(join(unrelated, '.git', 'HEAD'), 'ref: refs/heads/main');
    } else writeFileSync(join(unrelated, '.git'), 'gitdir: dummy');
    expect(() =>
      privateArtifactPaths(join(unrelated, 'new', 'samples.jsonl'), repository)
    ).toThrow('outside Git checkouts');
    symlinkSync(unrelated, join(outside, 'linked-repo'), 'dir');
    const paths = privateArtifactPaths(
      join(outside, 'samples.jsonl'),
      repository
    );
    expect(() => paths.artifact('linked-repo/artifacts')).toThrow(
      'outside Git checkouts'
    );
  }
);

it('checks CLI cleanup overrides while selecting an external private default', () => {
  const { directory, repository, outside } = fixture();
  const sources = join(directory, 'sources');
  mkdirSync(sources);
  const source = join(sources, 'source.step');
  writeFileSync(source, 'dummy private STEP input');
  const paths = privateArtifactPaths(
    join(outside, 'samples.jsonl'),
    repository,
    [source]
  );
  expect(privatePlaywrightOutput(paths, [], undefined)).toBe(
    join(outside, 'h02-private-playwright-artifacts')
  );
  for (const argv of [['--output', sources], [`--output=${sources}`]])
    expect(() => privatePlaywrightOutput(paths, argv, undefined)).toThrow(
      'source input'
    );
  const artifacts = join(directory, 'separate-artifacts');
  expect(
    privatePlaywrightOutput(paths, ['--output', artifacts], undefined)
  ).toBe(artifacts);
  expect(
    privatePlaywrightOutput(paths, [`--output=${artifacts}`], undefined)
  ).toBe(artifacts);
  expect(() =>
    privatePlaywrightOutput(paths, ['--last-failed-file', source], undefined)
  ).toThrow('source input');
  expect(() => privatePlaywrightOutput(paths, [], source)).toThrow(
    'source input'
  );
});

it.each(['--reporter', '--add-reporter'])(
  'rejects unsupported private %s outputs before a reporter can write',
  (option) => {
    const { repository, outside } = fixture();
    const paths = privateArtifactPaths(
      join(outside, 'samples.jsonl'),
      repository
    );
    for (const reporter of [
      'html',
      'blob',
      'json',
      'junit',
      './custom-reporter.ts'
    ]) {
      expect(() =>
        privatePlaywrightOutput(paths, [option, reporter], undefined)
      ).toThrow('stdout reporters');
      expect(() =>
        privatePlaywrightOutput(paths, [`${option}=${reporter}`], undefined)
      ).toThrow('stdout reporters');
    }
    expect(() =>
      privatePlaywrightOutput(paths, [option, 'list,dot,line,null'], undefined)
    ).not.toThrow();
  }
);

it.each(['matched', 'sustained'])(
  'rejects an actual %s Playwright cleanup override before it can remove the source',
  (mode) => {
    const { directory, outside } = fixture();
    const sources = join(directory, 'sources');
    mkdirSync(sources);
    const source = join(sources, 'source.step');
    const original = Buffer.from('dummy private STEP input\n');
    writeFileSync(source, original);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('../node_modules/@playwright/test/cli.js', import.meta.url)
        ),
        'test',
        '--config',
        fileURLToPath(new URL('../playwright.config.ts', import.meta.url)),
        '--output',
        sources,
        '--list'
      ],
      {
        env: {
          ...process.env,
          OZ_PERF: mode === 'matched' ? '1' : '',
          H02_SESSION_PROBE: mode === 'sustained' ? '1' : '',
          OZ_PERF_HOLDER_STEP: source,
          OZ_PERF_OUT: join(outside, 'samples.jsonl')
        },
        encoding: 'utf8',
        timeout: 10_000
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source input');
    expect(readFileSync(source)).toEqual(original);
  },
  15_000
);
