import { describe, expect, it, vi } from 'vitest';
import { MAX_PROJECT_NAME_LENGTH } from '@openzcad/shared';
import {
  CUTE_PART_ADJECTIVES,
  CUTE_PART_ANIMALS,
  generateCutePartName
} from './cutePartName';

describe('cute part names', () => {
  it('combines independently selected local words', () => {
    const indices = [0, CUTE_PART_ANIMALS.length - 1];
    const pickIndex = vi.fn(() => indices.shift() ?? 0);

    expect(generateCutePartName(pickIndex)).toBe('Bouncy Wombat');
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
});
