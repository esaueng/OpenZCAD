import { describe, expect, it, vi } from 'vitest';
import { MAX_PROJECT_NAME_LENGTH } from '@openzcad/shared';
import {
  CUTE_PART_ADJECTIVES,
  CUTE_PART_ANIMALS,
  generateCutePartName,
  isCutePartName
} from './cutePartName';

describe('cute part names', () => {
  it('combines independently selected local words', () => {
    const indices = [0, CUTE_PART_ANIMALS.length - 1];
    const pickIndex = vi.fn(() => indices.shift() ?? 0);

    expect(generateCutePartName(pickIndex)).toBe('Bouncy Zebra');
    expect(pickIndex).toHaveBeenNthCalledWith(1, CUTE_PART_ADJECTIVES.length);
    expect(pickIndex).toHaveBeenNthCalledWith(2, CUTE_PART_ANIMALS.length);
  });

  it('keeps every possible suggestion inside the shared project-name limit', () => {
    const longestAdjective = Math.max(
      ...CUTE_PART_ADJECTIVES.map((word) => word.length)
    );
    const longestAnimal = Math.max(
      ...CUTE_PART_ANIMALS.map((word) => word.length)
    );

    expect(longestAdjective + 1 + longestAnimal).toBeLessThanOrEqual(
      MAX_PROJECT_NAME_LENGTH
    );
  });

  it('uses the bundled vocabulary without consulting external state', () => {
    const [adjective, animal] = generateCutePartName().split(' ');

    expect(CUTE_PART_ADJECTIVES).toContain(adjective);
    expect(CUTE_PART_ANIMALS).toContain(animal);
  });

  it('offers thousands of distinct pairs from words used once each', () => {
    expect(new Set(CUTE_PART_ADJECTIVES).size).toBe(
      CUTE_PART_ADJECTIVES.length
    );
    expect(new Set(CUTE_PART_ANIMALS).size).toBe(CUTE_PART_ANIMALS.length);
    expect(
      CUTE_PART_ADJECTIVES.length * CUTE_PART_ANIMALS.length
    ).toBeGreaterThanOrEqual(5_000);
  });

  it('still recognises the suggestions earlier releases made', () => {
    // 15 Nov 2026: the vocabulary grew; existing projects keep these names.
    for (const name of [
      'Gentle Panda',
      'Sunny Duckling',
      'Tiny Ferret',
      'Tiny Fox',
      'Lucky Quokka',
      'Bouncy Wombat',
      'Wiggly Badger'
    ]) {
      expect(isCutePartName(name)).toBe(true);
    }
  });

  it('draws again rather than suggest a name already in use', () => {
    // 15 Nov 2026: "Gentle Panda" was suggested beside a "Gentle Panda".
    const gentle = CUTE_PART_ADJECTIVES.indexOf('Gentle');
    const panda = CUTE_PART_ANIMALS.indexOf('Panda');
    const indices = [gentle, panda, 0, 0];
    const pickIndex = vi.fn(() => indices.shift() ?? 0);

    expect(generateCutePartName(pickIndex, ['  gentle PANDA '])).toBe(
      'Bouncy Alpaca'
    );
  });

  it('finds the one unused pair when random draws keep colliding', () => {
    const taken: string[] = [];
    for (const adjective of CUTE_PART_ADJECTIVES) {
      for (const animal of CUTE_PART_ANIMALS) {
        if (adjective !== 'Zippy' || animal !== 'Zebra') {
          taken.push(`${adjective} ${animal}`);
        }
      }
    }

    expect(generateCutePartName(() => 0, taken)).toBe('Zippy Zebra');
    // With every pair in use it still returns a suggestion.
    expect(
      isCutePartName(generateCutePartName(undefined, [...taken, 'Zippy Zebra']))
    ).toBe(true);
  });
});
