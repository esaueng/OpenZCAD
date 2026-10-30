import {
  accountKeyCommitment,
  fromBase64Url,
  isE2eeError,
  openLibraryFolders,
  readLibraryFoldersHeader,
  sealLibraryFolders,
  toBase64Url,
  toHex
} from '@openzcad/crypto';
import { parseFolderSet } from '../libraryFolderSync';
import {
  canonicalFolderJson,
  decodePlaintextFolders,
  type FolderRecordCodec
} from '../libraryFolderCloudSync';

/**
 * Library folders sealed under the account key (format 2, ADR-024 amendment
 * 2026-10-30), for an account whose projects are encrypted. Loaded only by
 * such an account, so the crypto stays out of the shelf's chunk.
 */
export interface SequencePins {
  read(): number;
  write(sequence: number): void;
}

export function sealedFolderCodec(options: {
  accountKey: Uint8Array;
  userId: string;
  pins: SequencePins;
}): FolderRecordCodec {
  const { accountKey, userId, pins } = options;
  const ownCommitment = accountKeyCommitment(accountKey).then(toHex);
  return {
    format: 2,
    async decode(snapshot) {
      // Plaintext folders from before the account encrypted are read, then
      // rewritten sealed.
      if (snapshot.format === 1) return decodePlaintextFolders(snapshot.record);
      if (snapshot.format !== 2 || snapshot.record === null)
        return { kind: 'unsupported' };
      let sealed: Uint8Array;
      let header: ReturnType<typeof readLibraryFoldersHeader>;
      try {
        sealed = fromBase64Url(snapshot.record);
        header = readLibraryFoldersHeader(sealed);
      } catch {
        return { kind: 'unsupported' };
      }
      // Sealed under an account key this device no longer holds (a device
      // removal rotated it), or older than a copy already opened here.
      if (toHex(header.commitment) !== (await ownCommitment))
        return { kind: 'replace' };
      const pinned = pins.read();
      if (header.sequence < pinned) return { kind: 'replace' };
      let plaintext: Uint8Array;
      try {
        ({ plaintext } = await openLibraryFolders(accountKey, userId, sealed));
      } catch (error) {
        if (isE2eeError(error)) return { kind: 'unsupported' };
        throw error;
      }
      let set: ReturnType<typeof parseFolderSet>;
      try {
        set = parseFolderSet(JSON.parse(new TextDecoder().decode(plaintext)));
      } catch {
        set = null;
      }
      if (!set) return { kind: 'unsupported' };
      pins.write(Math.max(pinned, header.sequence));
      return { kind: 'set', set };
    },
    async encode(set) {
      const sequence = pins.read() + 1;
      const sealed = await sealLibraryFolders(
        accountKey,
        userId,
        sequence,
        new TextEncoder().encode(canonicalFolderJson(set))
      );
      return {
        record: toBase64Url(sealed),
        commit: () => {
          if (pins.read() < sequence) pins.write(sequence);
        }
      };
    }
  };
}
