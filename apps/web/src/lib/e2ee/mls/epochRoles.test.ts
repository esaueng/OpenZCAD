// @vitest-environment node
// The committed MLS WASM is read from disk, which needs Node’s file URLs.
import { beforeAll, describe, expect, it } from 'vitest';
import { inProcessMls } from '../../../../../../packages/mls/src/test-support';
import {
  EpochRecordError,
  parseEpochContext,
  projectGroupId,
  ROLES_EXTENSION_TYPE
} from './epochRoles';
import { createMlsLoader } from './loader';
import { MlsProjectSessions } from './projectSessions';
import { memoryMlsSessionStore } from './sessionStore';
import { testAccount, type TestAccount } from './testFixtures';

let alice: TestAccount;
let bob: TestAccount;

beforeAll(async () => {
  alice = await testAccount('user_alice', ['alice_laptop']);
  bob = await testAccount('user_bob', ['bob_laptop']);
});

const sessions = () =>
  new MlsProjectSessions(
    memoryMlsSessionStore(),
    createMlsLoader(async () => inProcessMls())
  );

/** Every epoch's archived record of a group: create, then add Bob. */
async function records() {
  const mls = sessions();
  const ref = {
    userId: alice.userId,
    deviceId: 'alice_laptop',
    projectId: 'proj_roles'
  };
  const directory = { lists: [alice.list, bob.list], certifications: [] };
  const created = await mls.createGroup(
    ref,
    alice.devices.get('alice_laptop')!,
    directory
  );
  await mls.commit(ref, directory, {
    setRoles: [{ userId: bob.userId, role: 'editor' }]
  });
  const added = await mls.confirmCommit(ref, directory);
  await mls.commit(ref, directory, {
    setRoles: [{ userId: bob.userId, role: 'viewer' }]
  });
  const demoted = await mls.confirmCommit(ref, directory);
  const status = await mls.status(ref);
  return { mls, created, added, demoted, status };
}

describe('epoch roles from archived records (slice 5-2)', () => {
  it('reads each epoch’s roles as the session held them', async () => {
    const { mls, created, added, demoted, status } = await records();
    const read = async (record: Uint8Array | null) =>
      parseEpochContext((await mls.decodeEpochRecord(record!)).groupContext);
    const zero = await read(created.epochRecord);
    expect(zero.epoch).toBe(0);
    expect(zero.groupId).toEqual(projectGroupId('proj_roles'));
    expect(zero.roles.users).toEqual([
      { userId: 'user_alice', role: 'owner', since: 0 }
    ]);
    const one = await read(added.epochRecord);
    expect(one.epoch).toBe(1);
    expect(one.roles.users).toEqual([
      { userId: 'user_alice', role: 'owner', since: 0 },
      { userId: 'user_bob', role: 'editor', since: 1 }
    ]);
    const two = await read(demoted.epochRecord);
    expect(two.epoch).toBe(2);
    // The parser agrees with the engine's own view of the current epoch.
    expect(two.roles).toEqual(status.roles);
    expect(two.roles.users[1]).toEqual({
      userId: 'user_bob',
      role: 'viewer',
      since: 2
    });
  });

  it('refuses anything that does not decode exactly', async () => {
    const { mls, added } = await records();
    const context = (await mls.decodeEpochRecord(added.epochRecord!))
      .groupContext;
    // A trailing byte.
    expect(() => parseEpochContext(new Uint8Array([...context, 0]))).toThrow(
      EpochRecordError
    );
    // Cut short.
    expect(() => parseEpochContext(context.subarray(0, 40))).toThrow(
      EpochRecordError
    );
    // The roles extension renamed away: the last extension in the vector.
    const at = context.lastIndexOf(ROLES_EXTENSION_TYPE >> 8);
    const renamed = new Uint8Array(context);
    renamed[at] = 0xf1;
    expect(() => parseEpochContext(renamed)).toThrow(
      /no roles extension|roles/
    );
  });
});
