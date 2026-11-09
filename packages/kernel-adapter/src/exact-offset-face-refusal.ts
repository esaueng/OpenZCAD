/**
 * A face offset the kernel refused because a neighbouring face would
 * collapse, as a typed error.
 *
 * Remus re-limits the faces around a moved face, and a face move that would
 * shrink one of them to nothing changes the body's topology, which an
 * in-place move refuses. The pinned journaled entry point
 * (`moveFacesJournaledWithQuality`) throws that as prose, and its detailed
 * twin answers only `operation_failed` / `internal` — so the refusal arrived
 * at the user as "the exact kernel failed internally", although nothing
 * failed: the move was past the length of the neighbour's flat.
 *
 * This is the ONE place that reads that prose, and it reads it for a number:
 * the kernel states the extent the move ran against. When Remus gives this
 * refusal a typed code, that code replaces the pattern below.
 */
import { KernelRefusal } from './kernel-refusal';

/** The adapter's code for this refusal until the kernel has its own. */
export const OFFSET_FACE_COLLAPSES_NEIGHBOR = 'offset_face_collapses_neighbor';

/**
 * `… line edge 8 with one moving end would collapse: a move of -6.4 against a
 * fixed-to-moving extent of 6.400000000000002` — the topology guard of the
 * kernel's move-face, as it reads on the pin. `reverse` is the same edge
 * moved further than its own length.
 */
const NEIGHBOR_COLLAPSE =
  /move-face would change topology.*?would (collapse|reverse): a move of (-?\d+(?:\.\d+)?(?:e-?\d+)?) against a fixed-to-moving extent of (\d+(?:\.\d+)?(?:e-?\d+)?)/i;

/** A refused face offset that names how far the face can go. */
export class OffsetFaceRefusal extends KernelRefusal {
  readonly operation = 'offset-face';
}

/** Rounds away binary noise (`6.400000000000002`) without moving the limit. */
function cleanLength(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** The limit as the sentence states it: hundredths, trailing zeros dropped. */
function formatLimit(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * The typed refusal behind a failed face offset, or null when the failure is
 * something else.
 *
 * `offset` is the signed distance the face was asked to move. The limit is
 * given the same sign, so it is a value of the same parameter. The kernel's
 * move must be that same distance for the extent to be a limit on it; a
 * kernel message about some other move (a compound edit moving a different
 * amount) keeps the category but offers no limit.
 */
export function offsetFaceRefusalOf(
  error: unknown,
  offset: number
): OffsetFaceRefusal | null {
  if (!(error instanceof Error) || error instanceof KernelRefusal) {
    return null;
  }
  const match = NEIGHBOR_COLLAPSE.exec(error.message);
  if (!match) {
    return null;
  }
  const move = Number(match[2]);
  const extent = Number(match[3]);
  const sameMove =
    Number.isFinite(move) &&
    Math.abs(Math.abs(move) - Math.abs(offset)) <=
      1e-6 * Math.max(1, Math.abs(offset));
  const limit =
    sameMove && Number.isFinite(extent) && extent > 0
      ? Math.sign(offset) * cleanLength(extent)
      : undefined;
  const reason =
    limit === undefined
      ? 'A neighbouring face would shrink to nothing at this distance. Try a smaller offset.'
      : `A neighbouring face would shrink to nothing past ${formatLimit(Math.abs(limit))}. Try a smaller offset.`;
  return new OffsetFaceRefusal({
    family: 'direct-edit',
    category: 'invalid_topology',
    kernelCode: OFFSET_FACE_COLLAPSES_NEIGHBOR,
    kernelMessage: error.message,
    reason,
    message: `${reason}\n${error.message}`,
    kernelReason: match[1]!.toLowerCase(),
    ...(limit === undefined ? {} : { limit }),
    cause: error
  });
}
