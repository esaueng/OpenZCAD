import { beforeEach, describe, expect, it } from 'vitest';
import {
  assistantGrant,
  assistantGrantCurrent,
  beginAssistantAllow,
  completeAssistantAllow,
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

  it('reads a malformed grant as none', () => {
    const store = storage();
    store.values.set(
      'openzcad:e2ee-assistant-grant:v1:u:p',
      JSON.stringify({ sequence: 0, route: '', copyVersion: 1, id: 'x' })
    );
    expect(assistantGrant('u', 'p', store)).toBeNull();
    store.values.set('openzcad:e2ee-assistant-grant:v1:u:p', '{');
    expect(assistantGrant('u', 'p', store)).toBeNull();
  });
});
