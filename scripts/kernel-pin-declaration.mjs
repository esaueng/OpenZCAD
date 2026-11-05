import { execFileSync } from 'node:child_process';
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

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha;
  if (!/^[0-9a-f]{40}$/.test(base ?? ''))
    throw new Error('Missing exact kernel comparison base.');
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
        event: process.env.GITHUB_EVENT_NAME,
        headRef: event.pull_request?.head.ref,
        labels: event.pull_request?.labels?.map((l) => l.name)
      }
    )
  );
}
