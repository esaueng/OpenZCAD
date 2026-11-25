/**
 * The account's first-use pins on the Worker (migration 0069, ADR-024
 * amendment 2026-11-25): one opaque sealed record per account, stored by
 * compare-and-set on its revision, whose sealed sequence must rise with
 * every write, and erased with the profile.
 */
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '@openzcad/crypto';
import { newServer, rows } from './support/e2ee-documents';

const ALICE = 'user_alice';
const BOB = 'user_bob';
const ROUTE = '/api/e2ee/first-use-pins';

/** A sealed-record-shaped value (version 1, a commitment, `sequence`). */
function record(sequence: number, fill = 1): string {
  const bytes = new Uint8Array(1 + 32 + 4 + 12 + 16 + 8).fill(fill);
  bytes[0] = 1;
  new DataView(bytes.buffer).setUint32(33, sequence);
  return toBase64Url(bytes);
}

function server() {
  const srv = newServer([]);
  for (const id of [ALICE, BOB]) {
    srv.db
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .run(id, `${id}@example.com`, '2026-11-25T00:00:00.000Z');
  }
  return srv;
}

describe('the first-use pins route', () => {
  it('stores one record per account by revision, and never lowers its sequence', async () => {
    const srv = server();
    const get = async (user: string): Promise<unknown> =>
      (await srv.call('GET', ROUTE, { user })).json() as Promise<unknown>;
    expect(await get(ALICE)).toMatchObject({
      revision: 0,
      sequence: 0,
      record: null
    });
    const first = await srv.call('PUT', ROUTE, {
      user: ALICE,
      body: { expectedRevision: 0, record: record(1) }
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ revision: 1, sequence: 1 });
    // Another account sees nothing of it.
    expect(await get(BOB)).toMatchObject({ revision: 0, record: null });
    // A stale revision, or a sequence that does not rise, is a conflict
    // answered with the current copy.
    for (const body of [
      { expectedRevision: 0, record: record(2) },
      { expectedRevision: 1, record: record(1, 2) }
    ]) {
      const refused = await srv.call('PUT', ROUTE, { user: ALICE, body });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        code: 'E2EE_FIRST_USE_PINS_CONFLICT',
        details: { current: { revision: 1, sequence: 1, record: record(1) } }
      });
    }
    const next = await srv.call('PUT', ROUTE, {
      user: ALICE,
      body: { expectedRevision: 1, record: record(5) }
    });
    expect(await next.json()).toMatchObject({ revision: 2, sequence: 5 });
  });

  it('refuses what is not a sealed record', async () => {
    const srv = server();
    for (const value of [
      '',
      'not base64!',
      record(0),
      toBase64Url(new Uint8Array(8))
    ]) {
      const refused = await srv.call('PUT', ROUTE, {
        user: ALICE,
        body: { expectedRevision: 0, record: value }
      });
      expect(refused.status).toBe(400);
    }
    const tooLarge = await srv.call('PUT', ROUTE, {
      user: ALICE,
      body: { expectedRevision: 0, record: 'A'.repeat(128 * 1024 + 4) }
    });
    expect(tooLarge.status).toBe(413);
    expect(rows(srv, 'SELECT user_id FROM e2ee_first_use_pins')).toEqual([]);
  });
});
