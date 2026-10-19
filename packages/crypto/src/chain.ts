import { concatBytes, equalBytes, label, type Bytes } from './bytes';
import { E2eeError } from './errors';
import { HASH_BYTES } from './header';
import { sha256 } from './primitives';

/**
 * Shared rules for the hash-chained lists: device lists, contacts lists and
 * project rosters. Each entry carries a sequence and its predecessor's
 * hash; a browser pins the newest entry it has seen and refuses a list that
 * does not contain the pin, which detects both rollback and forks.
 */
export interface ChainLink {
  readonly sequence: number;
  readonly previousEntryHash: Uint8Array | null;
  readonly hash: Uint8Array;
}

export interface ChainOptions {
  /** The newest entry this browser has seen. */
  readonly pinnedEntryHash?: Uint8Array;
}

/** Labelled SHA-256 of a canonical entry: what the next entry and pins name. */
export async function chainEntryHash(
  kind: string,
  entry: Uint8Array
): Promise<Bytes> {
  return sha256(concatBytes(label(`v1 ${kind} entry hash`), entry));
}

/** One entry must follow another: sequence +1 and the predecessor's hash. */
export function followsLink(link: ChainLink, before: ChainLink): boolean {
  return (
    link.sequence === before.sequence + 1 &&
    link.previousEntryHash !== null &&
    equalBytes(link.previousEntryHash, before.hash)
  );
}

/**
 * Checks one step while walking a chain that must start at its first entry:
 * the first link has sequence 0, every later one follows its predecessor.
 */
export function checkNextLink(
  what: string,
  link: ChainLink,
  before: ChainLink | undefined
): void {
  if (before ? !followsLink(link, before) : link.sequence !== 0) {
    throw new E2eeError(
      'chain-broken',
      before
        ? `${what} entry ${link.sequence} does not follow its predecessor`
        : `${what} must start at its first entry`
    );
  }
}

/**
 * Checks a whole chain, oldest first: it is not empty, every link follows
 * the one before it, and it contains the pin when one is given. With
 * `fromGenesis` the chain must start at sequence 0; otherwise it may start
 * later when a pin anchors it.
 */
export function checkChain(
  what: string,
  links: readonly ChainLink[],
  options: ChainOptions & { readonly fromGenesis: boolean }
): void {
  const first = links[0];
  if (!first) throw new E2eeError('chain-broken', `${what} is empty`);
  links.forEach((link, i) => {
    if (i > 0 && !followsLink(link, links[i - 1]!)) {
      throw new E2eeError(
        'chain-broken',
        `${what} entry ${link.sequence} does not follow its predecessor`
      );
    }
  });
  const pinned = options.pinnedEntryHash;
  if (pinned !== undefined) {
    if (!(pinned instanceof Uint8Array) || pinned.byteLength !== HASH_BYTES) {
      throw new E2eeError('invalid-argument', 'A pin is a 32-byte entry hash');
    }
    if (!links.some(({ hash }) => equalBytes(hash, pinned))) {
      throw new E2eeError(
        'chain-broken',
        `${what} does not contain the pinned entry: rolled back or forked`
      );
    }
  }
  if ((options.fromGenesis || pinned === undefined) && first.sequence !== 0) {
    throw new E2eeError(
      'chain-broken',
      `${what} must start at its first entry`
    );
  }
}
