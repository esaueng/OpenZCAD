import { expect, it } from 'vitest';
import {
  checkDeclaration,
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
