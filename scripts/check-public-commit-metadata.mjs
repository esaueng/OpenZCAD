#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_NAMES = new Set([
  'default',
  'first last',
  'name',
  'root',
  'runner',
  'ubuntu',
  'unknown',
  'user',
  'your name',
  'your name here',
]);

export function validateIdentity(name, email) {
  const problems = [];
  const normalizedName = name.trim().toLowerCase();
  if (!name.trim() || name !== name.trim() || /[\u0000-\u001f\u007f]/u.test(name)) {
    problems.push('name is blank or contains control characters');
  } else if (DEFAULT_NAMES.has(normalizedName)) {
    problems.push('name is an obvious placeholder');
  }

  const normalizedEmail = email.toLowerCase();
  const match = /^([^\s@<>]+)@([^\s@<>]+)$/u.exec(normalizedEmail);
  if (!match) {
    problems.push('email is malformed');
  } else if (
    !match[1] ||
    !(['users.noreply.github.com', 'noreply.github.com'].includes(match[2]) || normalizedEmail === 'noreply@github.com')
  ) {
    problems.push('email must use a GitHub noreply domain');
  }

  return problems;
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!['--base', '--head'].includes(key) || !args[index + 1]) {
      throw new Error('Usage: check-public-commit-metadata.mjs --base <ref> --head <ref>');
    }
    values[key.slice(2)] = args[++index];
  }
  if (!values.base || !values.head) {
    throw new Error('Usage: check-public-commit-metadata.mjs --base <ref> --head <ref>');
  }
  return values;
}

function readCommits(base, head) {
  const format = '%H%x00%an%x00%ae%x00%cn%x00%ce%x00%x1e';
  const output = execFileSync('git', ['log', `--format=${format}`, '--no-decorate', `${base}..${head}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.split('\x1e').filter((record) => record.trim()).map((record) => {
    const fields = record.replace(/^\n/u, '').split('\x00');
    if (fields.length < 5) throw new Error('could not parse commit metadata');
    return { hash: fields[0], authorName: fields[1], authorEmail: fields[2], committerName: fields[3], committerEmail: fields[4] };
  });
}

export function validateCommits(commits) {
  const findings = [];
  for (const commit of commits) {
    for (const [label, name, email] of [
      ['author', commit.authorName, commit.authorEmail],
      ['committer', commit.committerName, commit.committerEmail],
    ]) {
      for (const problem of validateIdentity(name, email)) {
        findings.push(`${commit.hash.slice(0, 12)}: ${label} ${problem}`);
      }
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { base, head } = parseArgs(process.argv.slice(2));
    const findings = validateCommits(readCommits(base, head));
    if (findings.length) {
      console.error(`Commit metadata check failed (${findings.length} issue(s)):`);
      for (const finding of findings) console.error(`- ${finding}`);
      process.exitCode = 1;
    } else {
      console.log('Commit metadata check passed.');
    }
  } catch {
    console.error('Commit metadata check could not inspect the requested range.');
    process.exitCode = 1;
  }
}
