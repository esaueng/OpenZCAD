export const CUTE_PART_ADJECTIVES = [
  'Bouncy',
  'Bright',
  'Cheery',
  'Clever',
  'Cozy',
  'Dapper',
  'Gentle',
  'Jolly',
  'Lucky',
  'Mellow',
  'Merry',
  'Minty',
  'Nimble',
  'Peachy',
  'Peppy',
  'Perky',
  'Plucky',
  'Poppy',
  'Snappy',
  'Spry',
  'Sunny',
  'Tiny',
  'Twinkly',
  'Wiggly'
] as const;

export const CUTE_PART_ANIMALS = [
  'Badger',
  'Beaver',
  'Bunny',
  'Capybara',
  'Chipmunk',
  'Duckling',
  'Ferret',
  'Finch',
  'Fox',
  'Gecko',
  'Hedgehog',
  'Koala',
  'Llama',
  'Marmot',
  'Mouse',
  'Newt',
  'Otter',
  'Panda',
  'Penguin',
  'Puffin',
  'Quokka',
  'Robin',
  'Turtle',
  'Wombat'
] as const;

type RandomIndex = (upperBound: number) => number;

function randomIndex(upperBound: number): number {
  const sample = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return sample % upperBound;
}

/** A local-only suggestion for a new part; no service or persisted seed needed. */
export function generateCutePartName(
  pickIndex: RandomIndex = randomIndex
): string {
  const adjective =
    CUTE_PART_ADJECTIVES[pickIndex(CUTE_PART_ADJECTIVES.length)];
  const animal = CUTE_PART_ANIMALS[pickIndex(CUTE_PART_ANIMALS.length)];
  return `${adjective} ${animal}`;
}
