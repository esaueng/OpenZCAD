import { describe, expect, it } from 'vitest';
import {
  localStoragePreferencePins,
  memoryPreferencePins,
  type PreferencePinStore
} from './preferencePins';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value)
  };
}

describe.each<[string, () => PreferencePinStore]>([
  ['localStorage', () => localStoragePreferencePins(memoryStorage())],
  ['memory', memoryPreferencePins]
])('%s preference pins', (_, create) => {
  it('pins the verified value with its record and never moves back', async () => {
    const pins = create();
    expect(await pins.optedIn('user_1')).toBe(false);
    await pins.write('user_1', 2, true);
    expect(await pins.read('user_1')).toBe(2);
    expect(await pins.optedIn('user_1')).toBe(true);

    // An older record, from a slower tab, changes neither.
    await pins.write('user_1', 1, false);
    expect(await pins.read('user_1')).toBe(2);
    expect(await pins.optedIn('user_1')).toBe(true);

    // A newer record does; a sequence alone leaves the value.
    await pins.write('user_1', 3, false);
    expect(await pins.optedIn('user_1')).toBe(false);
    await pins.write('user_1', 4);
    expect(await pins.read('user_1')).toBe(4);
    expect(await pins.optedIn('user_1')).toBe(false);

    // Per account.
    expect(await pins.optedIn('user_2')).toBe(false);
  });
});

it('reads as not opted in when storage is blocked', async () => {
  const pins = localStoragePreferencePins({
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    }
  });
  await pins.write('user_1', 1, true);
  expect(await pins.optedIn('user_1')).toBe(false);
  expect(await pins.read('user_1')).toBeNull();
});
