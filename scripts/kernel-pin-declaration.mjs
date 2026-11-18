import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function kernelPin(lockfile) {
  const pins = [
    ...new Set(
      [
        ...lockfile.matchAll(
          /codeload\.github\.com\/esaueng\/remus\/tar\.gz\/([0-9a-f]{40})/g
        )
      ].map((m) => m[1])
    )
  ];
  if (pins.length !== 1)
    throw new Error(
      'Expected exactly one paired Remus commit in the lockfile.'
    );
  return pins[0];
}

export function checkDeclaration(
  base,
  head,
  { event, headRef = '', labels = [] }
) {
  const previous = kernelPin(base);
  const current = kernelPin(head);
  if (
    previous !== current &&
    event === 'pull_request' &&
    !headRef.startsWith('automation/remus-') &&
    !labels.includes('kernel-bump')
  )
    throw new Error(
      'The Remus pin changed; declare it with the kernel-bump label.'
    );
  return { previous, current };
}

export function kernelComparisonBase(eventName, event, checkedCommit) {
  let base;
  if (eventName === 'pull_request') {
    // A PR run tests GitHub's synthetic merge. Its first parent is the
    // base actually used, which may be newer than the event's base SHA.
    const headers = checkedCommit.split('\n\n', 1)[0];
    const parents = [...headers.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(
      ([, sha]) => sha
    );
    if (parents.length !== 2 || parents[1] !== event.pull_request?.head?.sha)
      throw new Error(
        'Kernel declaration requires the checked PR merge commit.'
      );
    base = parents[0];
  } else if (eventName === 'merge_group') {
    base = event.merge_group?.base_sha;
  }
  if (!/^[0-9a-f]{40}$/.test(base ?? ''))
    throw new Error('Missing exact kernel comparison base.');
  return base;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const eventName = process.env.GITHUB_EVENT_NAME;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
  if (head !== process.env.GITHUB_SHA)
    throw new Error('Kernel declaration requires the exact CI checkout.');
  // Git's raw commit headers include parents even in the shallow checkout.
  const checkedCommit =
    eventName === 'pull_request'
      ? execFileSync('git', ['cat-file', 'commit', head], { encoding: 'utf8' })
      : '';
  const base = kernelComparisonBase(eventName, event, checkedCommit);
  execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', base], {
    stdio: 'inherit'
  });
  console.log(
    checkDeclaration(
      execFileSync('git', ['show', `${base}:pnpm-lock.yaml`], {
        encoding: 'utf8'
      }),
      readFileSync('pnpm-lock.yaml', 'utf8'),
      {
        event: eventName,
        headRef: event.pull_request?.head.ref,
        labels: event.pull_request?.labels?.map((l) => l.name)
      }
    )
  );
}
