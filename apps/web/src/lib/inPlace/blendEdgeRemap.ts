import type { BodyId } from '@openzcad/shared';
import type { EdgePick } from './tools';

/**
 * What a click on an edited blend's result names on the body it rounds.
 *
 * An unblended edge keeps its fingerprint, so `onInput` finds it. An edge
 * the blend trimmed (any edge ending on its band) or made gets a new one and
 * has no counterpart on the input. When the input's topology is on hand that
 * is known now, and the click is refused as `'reshaped'`: storing the result
 * body's hash anyway let the next pick refresh drop it and report that a
 * saved pick had vanished. Without the input's topology nothing here can
 * tell, so the hash goes to the validated commit, which refuses one the
 * kernel cannot find.
 */
export function remappedBlendEdge(
  onInput: EdgePick | null,
  target: BodyId,
  hash: number | undefined,
  inputHasTopology: boolean
): EdgePick | 'reshaped' | null {
  if (onInput) return onInput;
  if (inputHasTopology) return 'reshaped';
  return hash !== undefined ? { bodyId: target, hash, topologyId: '' } : null;
}
