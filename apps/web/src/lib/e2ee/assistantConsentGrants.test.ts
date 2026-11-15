import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSISTANT_ALLOW_PENDING_PREFIX,
  ASSISTANT_GRANT_PREFIX,
  ASSISTANT_STOP_PREFIX,
  assistantGrant,
  assistantGrantCurrent,
  beginAssistantAllow,
  completeAssistantAllow,
  raiseAssistantConsentFloor,
  resetAssistantGrantMemoryForTests,
  stopAssistantGrant,
  withdrawAssistantAllow
} from './assistantConsentGrants';

const RECORD = { sequence: 3, route: 'v2|deployment|p|m|d', copyVersion: 1 };

/** Storage that can refuse writes or reads, as full or blocked storage does. */
function storage() {
  const values = new Map<string, string>();
  const faults = { write: false, read: false, remove: false };
  return {
    faults,
    values,
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      if (faults.read) throw new Error('blocked');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (faults.write) throw new Error('QuotaExceededError');
      values.set(key, value);
    },
    removeItem(key: string) {
      if (faults.remove) throw new Error('blocked');
      values.delete(key);
    }
  };
}

beforeEach(() => resetAssistantGrantMemoryForTests());

describe('this device’s assistant grants', () => {
  it('grants only the Allow clicked last, and only if no Stop came after it', () => {
    const store = storage();
    const first = beginAssistantAllow('u', 'p', store)!;
    const second = beginAssistantAllow('u', 'p', store)!;
    expect(completeAssistantAllow(first, RECORD, store)).toBeNull();
    const grant = completeAssistantAllow(second, RECORD, store)!;
    expect(grant).toMatchObject(RECORD);
    expect(
      assistantGrantCurrent(
        { userId: 'u', projectId: 'p', ...RECORD, grant: grant.id },
        store
      )
    ).toBe(true);

    const inFlight = beginAssistantAllow('u', 'p', store)!;
    stopAssistantGrant('u', 'p', store);
    expect(assistantGrant('u', 'p', store)).toBeNull();
    expect(completeAssistantAllow(inFlight, RECORD, store)).toBeNull();
    expect(assistantGrant('u', 'p', store)).toBeNull();
    // An Allow clicked after the Stop goes through.
    const later = beginAssistantAllow('u', 'p', store)!;
    expect(completeAssistantAllow(later, RECORD, store)).not.toBeNull();
  });

  it('is per account and project, and a withdrawn Allow grants nothing', () => {
    const store = storage();
    const ticket = beginAssistantAllow('u', 'p', store)!;
    withdrawAssistantAllow(ticket, store);
    expect(completeAssistantAllow(ticket, RECORD, store)).toBeNull();
    const other = beginAssistantAllow('u', 'q', store)!;
    const grant = completeAssistantAllow(other, RECORD, store)!;
    expect(assistantGrant('u', 'p', store)).toBeNull();
    expect(assistantGrant('v', 'q', store)).toBeNull();
    expect(
      assistantGrantCurrent(
        { userId: 'u', projectId: 'p', ...RECORD, grant: grant.id },
        store
      )
    ).toBe(false);
  });

  it('fails closed when storage refuses', () => {
    const store = storage();
    store.faults.write = true;
    expect(beginAssistantAllow('u', 'p', store)).toBeNull();
    store.faults.write = false;
    const ticket = beginAssistantAllow('u', 'p', store)!;
    store.faults.write = true;
    expect(completeAssistantAllow(ticket, RECORD, store)).toBeNull();
    store.faults.write = false;
    const grant = completeAssistantAllow(
      beginAssistantAllow('u', 'p', store)!,
      RECORD,
      store
    )!;
    const consent = { userId: 'u', projectId: 'p', ...RECORD, grant: grant.id };
    store.faults.read = true;
    expect(assistantGrantCurrent(consent, store)).toBe(false);
    store.faults.read = false;
    expect(assistantGrantCurrent(consent, store)).toBe(true);
    // A Stop whose removal storage refuses still holds in this tab.
    store.faults.remove = true;
    stopAssistantGrant('u', 'p', store);
    expect(assistantGrantCurrent(consent, store)).toBe(false);
  });

  it('never lets another tab read a grant written after a Stop interleaved with the write', () => {
    // Tab A completes its Allow; between its pending check and its grant
    // write, tab B stops (moves the generation, removes the keys). Tab C
    // reads the grant right after A wrote it, before A's own re-check.
    const shared = storage();
    let seenByC: unknown = 'not read';
    const tabA = {
      get length() {
        return shared.length;
      },
      key: (index: number) => shared.key(index),
      getItem: (key: string) => shared.getItem(key),
      removeItem: (key: string) => shared.removeItem(key),
      setItem(key: string, value: string) {
        if (key === 'openzcad:e2ee-assistant-grant:v1:u:p') {
          shared.setItem(`${ASSISTANT_STOP_PREFIX}u:p`, 'x'.repeat(36));
          shared.removeItem(`${ASSISTANT_ALLOW_PENDING_PREFIX}u:p`);
          shared.removeItem(`${ASSISTANT_GRANT_PREFIX}u:p`);
          shared.setItem(key, value);
          seenByC = assistantGrant('u', 'p', shared);
          return;
        }
        shared.setItem(key, value);
      }
    };
    const ticket = beginAssistantAllow('u', 'p', tabA)!;
    expect(completeAssistantAllow(ticket, RECORD, tabA)).toBeNull();
    expect(seenByC).toBeNull();
    expect(assistantGrant('u', 'p', shared)).toBeNull();
  });

  it('is not current once any tab verified a newer record, whatever order the floors land in', () => {
    const store = storage();
    const grant = completeAssistantAllow(
      beginAssistantAllow('u', 'p', store)!,
      RECORD,
      store
    )!;
    const consent = { userId: 'u', projectId: 'p', ...RECORD, grant: grant.id };
    // Its own record, verified: still current.
    raiseAssistantConsentFloor('u', 'p', RECORD.sequence, store);
    expect(assistantGrantCurrent(consent, store)).toBe(true);
    // Another tab verifies a revocation past it; a delayed verification of
    // an older record lands after. The floor does not come back down.
    raiseAssistantConsentFloor('u', 'p', RECORD.sequence + 2, store);
    raiseAssistantConsentFloor('u', 'p', RECORD.sequence + 1, store);
    expect(assistantGrantCurrent(consent, store)).toBe(false);
  });

  it('removes an older grant when the floor cannot be written', () => {
    const store = storage();
    const grant = completeAssistantAllow(
      beginAssistantAllow('u', 'p', store)!,
      RECORD,
      store
    )!;
    const consent = { userId: 'u', projectId: 'p', ...RECORD, grant: grant.id };
    store.faults.write = true;
    raiseAssistantConsentFloor('u', 'p', RECORD.sequence + 1, store);
    store.faults.write = false;
    expect(assistantGrantCurrent(consent, store)).toBe(false);
    expect(store.values.has(`${ASSISTANT_GRANT_PREFIX}u:p`)).toBe(false);
  });

  it('never lets an Allow’s first use overwrite a Stop made as it was clicked', () => {
    // Tab A reads that the project has no Stop yet; before its first write
    // (whatever it is), tab B stops. A must not grant.
    const shared = storage();
    let stopped = false;
    const tabA = {
      ...shared,
      get length() {
        return shared.length;
      },
      key: (index: number) => shared.key(index),
      getItem: (key: string) => shared.getItem(key),
      removeItem: (key: string) => shared.removeItem(key),
      setItem(key: string, value: string) {
        if (!stopped) {
          stopped = true;
          shared.setItem(`${ASSISTANT_STOP_PREFIX}u:p`, 'x'.repeat(36));
          shared.removeItem(`${ASSISTANT_GRANT_PREFIX}u:p`);
        }
        shared.setItem(key, value);
      }
    };
    const ticket = beginAssistantAllow('u', 'p', tabA)!;
    expect(completeAssistantAllow(ticket, RECORD, tabA)).toBeNull();
    expect(assistantGrant('u', 'p', shared)).toBeNull();
    expect(shared.getItem(`${ASSISTANT_STOP_PREFIX}u:p`)).toBe('x'.repeat(36));
  });

  it('reads a malformed grant as none', () => {
    const store = storage();
    store.values.set(
      'openzcad:e2ee-assistant-grant:v1:u:p',
      JSON.stringify({
        sequence: 0,
        route: '',
        copyVersion: 1,
        id: 'x',
        stop: 'y'
      })
    );
    expect(assistantGrant('u', 'p', store)).toBeNull();
    store.values.set('openzcad:e2ee-assistant-grant:v1:u:p', '{');
    expect(assistantGrant('u', 'p', store)).toBeNull();
  });
});
