// Words are only ever added: isCutePartName must keep recognising the
// suggestions earlier releases made, which still name projects.
export const CUTE_PART_ADJECTIVES = [
  'Bouncy',
  'Brave',
  'Breezy',
  'Bright',
  'Bubbly',
  'Calm',
  'Cheery',
  'Chipper',
  'Chirpy',
  'Clever',
  'Comfy',
  'Cosmic',
  'Cozy',
  'Crafty',
  'Curious',
  'Daring',
  'Dandy',
  'Dapper',
  'Dreamy',
  'Eager',
  'Fancy',
  'Fizzy',
  'Fluffy',
  'Frisky',
  'Frosty',
  'Fuzzy',
  'Gentle',
  'Giggly',
  'Gleeful',
  'Golden',
  'Happy',
  'Hearty',
  'Jazzy',
  'Jolly',
  'Jumpy',
  'Kind',
  'Lively',
  'Lucky',
  'Mellow',
  'Merry',
  'Mighty',
  'Minty',
  'Misty',
  'Nifty',
  'Nimble',
  'Noble',
  'Peachy',
  'Peppy',
  'Perky',
  'Plucky',
  'Plush',
  'Polite',
  'Poppy',
  'Proud',
  'Quick',
  'Quiet',
  'Rosy',
  'Sassy',
  'Shiny',
  'Silly',
  'Sleepy',
  'Smiley',
  'Snappy',
  'Snug',
  'Sparkly',
  'Speedy',
  'Spry',
  'Spunky',
  'Squishy',
  'Steady',
  'Sunny',
  'Swift',
  'Tiny',
  'Toasty',
  'Trusty',
  'Twinkly',
  'Wiggly',
  'Wise',
  'Witty',
  'Zany',
  'Zesty',
  'Zippy'
] as const;

export const CUTE_PART_ANIMALS = [
  'Alpaca',
  'Axolotl',
  'Badger',
  'Bat',
  'Bear',
  'Beaver',
  'Bison',
  'Bobcat',
  'Bunny',
  'Capybara',
  'Cheetah',
  'Chipmunk',
  'Coyote',
  'Crane',
  'Deer',
  'Dolphin',
  'Donkey',
  'Dormouse',
  'Duckling',
  'Eagle',
  'Elephant',
  'Elk',
  'Falcon',
  'Ferret',
  'Finch',
  'Flamingo',
  'Fox',
  'Frog',
  'Gecko',
  'Gerbil',
  'Giraffe',
  'Goat',
  'Gopher',
  'Gosling',
  'Hamster',
  'Hare',
  'Hedgehog',
  'Heron',
  'Hippo',
  'Ibis',
  'Iguana',
  'Jay',
  'Kitten',
  'Kiwi',
  'Koala',
  'Lamb',
  'Lemur',
  'Lion',
  'Llama',
  'Lynx',
  'Magpie',
  'Manatee',
  'Marmot',
  'Meerkat',
  'Mole',
  'Moose',
  'Mouse',
  'Narwhal',
  'Newt',
  'Ocelot',
  'Okapi',
  'Otter',
  'Owl',
  'Panda',
  'Parrot',
  'Pelican',
  'Penguin',
  'Piglet',
  'Platypus',
  'Pony',
  'Possum',
  'Puffin',
  'Puppy',
  'Quokka',
  'Rabbit',
  'Raccoon',
  'Raven',
  'Robin',
  'Seal',
  'Sloth',
  'Sparrow',
  'Squirrel',
  'Starling',
  'Stoat',
  'Swan',
  'Tapir',
  'Tiger',
  'Toucan',
  'Turtle',
  'Vole',
  'Walrus',
  'Weasel',
  'Wombat',
  'Wren',
  'Yak',
  'Zebra'
] as const;

type RandomIndex = (upperBound: number) => number;

/** Random draws tried before walking every pair for an unused one. */
const RANDOM_ATTEMPTS = 32;

function randomIndex(upperBound: number): number {
  const sample = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return sample % upperBound;
}

function pairName(pair: number): string {
  const adjective =
    CUTE_PART_ADJECTIVES[Math.floor(pair / CUTE_PART_ANIMALS.length)];
  const animal = CUTE_PART_ANIMALS[pair % CUTE_PART_ANIMALS.length];
  return `${adjective} ${animal}`;
}

/**
 * A local-only suggestion for a new part; no service or persisted seed needed.
 * `taken` names the projects that already exist (compared without case), and
 * a suggestion avoids them while any pair is left; only when every pair is in
 * use does it repeat one, and the form then says the name is taken.
 */
export function generateCutePartName(
  pickIndex: RandomIndex = randomIndex,
  taken: Iterable<string> = []
): string {
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim().toLowerCase());
  const free = (name: string) => !used.has(name.toLowerCase());
  let name = '';
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
    const adjective =
      CUTE_PART_ADJECTIVES[pickIndex(CUTE_PART_ADJECTIVES.length)];
    const animal = CUTE_PART_ANIMALS[pickIndex(CUTE_PART_ANIMALS.length)];
    name = `${adjective} ${animal}`;
    if (free(name)) return name;
  }
  // A crowded library: walk every pair from a random start for a free one.
  const pairs = CUTE_PART_ADJECTIVES.length * CUTE_PART_ANIMALS.length;
  const start = pickIndex(pairs);
  for (let offset = 0; offset < pairs; offset += 1) {
    const candidate = pairName((start + offset) % pairs);
    if (free(candidate)) return candidate;
  }
  return name;
}

const ADJECTIVES: ReadonlySet<string> = new Set(CUTE_PART_ADJECTIVES);
const ANIMALS: ReadonlySet<string> = new Set(CUTE_PART_ANIMALS);

/** Whether `name` is a suggestion `generateCutePartName` could have made. */
export function isCutePartName(name: string): boolean {
  const [adjective, animal, ...rest] = name.split(' ');
  return (
    rest.length === 0 &&
    adjective !== undefined &&
    animal !== undefined &&
    ADJECTIVES.has(adjective) &&
    ANIMALS.has(animal)
  );
}
