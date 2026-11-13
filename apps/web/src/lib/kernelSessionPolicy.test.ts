import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { describe, expect, it } from 'vitest';
import { persistsKernelSession } from './kernelSessionPolicy';

const LOCAL = 'user_local_browser';
const ACCOUNT = 'user_account';

function decide(
  ownerUserId: string,
  options: { shareSession?: boolean; accountUserId?: string } = {}
) {
  return persistsKernelSession({
    document: createProjectDocument('Bracket', toUserId(ownerUserId)),
    shareSession: options.shareSession ?? false,
    localUserId: LOCAL,
    accountUserId: options.accountUserId
  });
}

describe('persistsKernelSession', () => {
  it('persists the user’s own local project, signed out or in', () => {
    expect(decide(LOCAL)).toBe(true);
    expect(decide(ACCOUNT, { accountUserId: ACCOUNT })).toBe(true);
    expect(decide(LOCAL, { accountUserId: ACCOUNT })).toBe(true);
  });

  it('never persists a shared link’s model, even the owner’s own', () => {
    // ADR-024: a share is ephemeral until the visitor makes a copy.
    expect(decide('user_owner', { shareSession: true })).toBe(false);
    expect(decide(LOCAL, { shareSession: true })).toBe(false);
    expect(
      decide(ACCOUNT, { shareSession: true, accountUserId: ACCOUNT })
    ).toBe(false);
  });

  it('never persists someone else’s project (a member, viewer or editor)', () => {
    expect(decide('user_owner', { accountUserId: ACCOUNT })).toBe(false);
    expect(decide('user_owner')).toBe(false);
    expect(
      persistsKernelSession({
        document: null,
        shareSession: false,
        localUserId: LOCAL,
        accountUserId: ACCOUNT
      })
    ).toBe(false);
  });
});

describe('the workspace applies it to its broadcast', () => {
  // Source assertions, as `test/section-sees-what-was-drawn.test.ts` does:
  // App has no render harness, and this wiring is one edit from dropped.
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

  it('passes the decision on its only broadcast sync', () => {
    expect(app.match(/geometry\.sync\(/g)).toHaveLength(1);
    expect(app).toContain(
      'geometry.sync(doc, lineageDemand, { persistSession });'
    );
    const decision = app.slice(
      app.indexOf('const persistSession = persistsKernelSession({'),
      app.indexOf('geometry.sync(doc, lineageDemand, { persistSession });')
    );
    expect(decision).toContain(
      'shareSession: Boolean(shareSession || shareSessionRef.current)'
    );
    expect(decision).toContain('accountUserId: session?.userId');
    expect(decision).toContain('localUserId,');
  });
});
