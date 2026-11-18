import { expect, it } from 'vitest';
import {
  checkDeclaration,
  kernelComparisonBase,
  kernelPin
} from '../scripts/kernel-pin-declaration.mjs';

const lock = (sha: string) =>
  `resolution: https://codeload.github.com/esaueng/remus/tar.gz/${sha}`;
const before = lock('a'.repeat(40));
const after = lock('b'.repeat(40));

it('requires a declared paired kernel update and responds to label removal', () => {
  expect(() =>
    checkDeclaration(before, after, { event: 'pull_request' })
  ).toThrow('kernel-bump');
  expect(
    checkDeclaration(before, after, {
      event: 'pull_request',
      labels: ['kernel-bump']
    }).current
  ).toBe('b'.repeat(40));
  expect(() =>
    checkDeclaration(before, after, { event: 'pull_request', labels: [] })
  ).toThrow('kernel-bump');
  expect(
    checkDeclaration(before, after, {
      event: 'pull_request',
      headRef: 'automation/remus-next'
    }).current
  ).toBe('b'.repeat(40));
  expect(
    checkDeclaration(before, after, { event: 'merge_group' }).current
  ).toBe('b'.repeat(40));
  expect(
    checkDeclaration(before, before, { event: 'pull_request' }).current
  ).toBe('a'.repeat(40));
});

it('refuses missing baselines and split package pins', () => {
  expect(() => kernelPin('')).toThrow('exactly one');
  expect(() => kernelPin(before + after)).toThrow('exactly one');
  expect(() => checkDeclaration('', after, { event: 'pull_request' })).toThrow(
    'exactly one'
  );
});

const staleBase = '1'.repeat(40);
const checkoutBase = '2'.repeat(40);
const prHead = '3'.repeat(40);
const event = {
  pull_request: { base: { sha: staleBase }, head: { sha: prHead } }
};
const rawCommit = (...parents: string[]) =>
  [
    'tree ' + '4'.repeat(40),
    ...parents.map((sha) => 'parent ' + sha),
    '',
    'Synthetic merge commit'
  ].join('\n');

it('uses the base of the tested merge even when the PR event has an older pin', () => {
  const base = kernelComparisonBase(
    'pull_request',
    event,
    rawCommit(checkoutBase, prHead)
  );
  expect(base).toBe(checkoutBase);
  const baselineLock = base === checkoutBase ? after : before;
  expect(
    checkDeclaration(baselineLock, after, { event: 'pull_request' }).current
  ).toBe('b'.repeat(40));
  expect(() =>
    checkDeclaration(baselineLock, before, { event: 'pull_request' })
  ).toThrow('kernel-bump');
});

it('rejects a bare PR head or a merge with the wrong PR parent', () => {
  expect(() =>
    kernelComparisonBase('pull_request', event, rawCommit(checkoutBase))
  ).toThrow('checked PR merge');
  expect(() =>
    kernelComparisonBase(
      'pull_request',
      event,
      rawCommit(checkoutBase, staleBase)
    )
  ).toThrow('checked PR merge');
});

it('uses the queue event base and refuses a missing queue base', () => {
  expect(
    kernelComparisonBase(
      'merge_group',
      { merge_group: { base_sha: checkoutBase } },
      ''
    )
  ).toBe(checkoutBase);
  expect(() => kernelComparisonBase('merge_group', {}, '')).toThrow(
    'Missing exact kernel comparison base'
  );
});
