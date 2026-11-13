import type { BodyId, BodyRepresentation } from '@openzcad/shared';
import { IN_PLACE_TOOL_SPECS, type InPlaceToolId } from './tools';

/**
 * The body a command that takes one body starts on when nothing is
 * selected and the model has only one live body: Move took it, while Scale,
 * Mirror, Split, Solid offset and the patterns said "Click the body to …"
 * of the only body there was. Null when the command takes no single body
 * (a boolean takes several), or there are none or several to choose from.
 */
export function loneBodyFor(
  tool: InPlaceToolId,
  bodies: Readonly<
    Record<string, Pick<BodyRepresentation, 'bodyId' | 'consumed'>>
  >,
  hidden: ReadonlySet<string>
): BodyId | null {
  const spec = IN_PLACE_TOOL_SPECS[tool];
  // A solid offset names its body by a face of it; the host turns the body
  // into that face.
  if (spec.bodyMode !== 'one' && tool !== 'solid-offset') return null;
  const live = Object.values(bodies).filter(
    (body) => !body.consumed && !hidden.has(body.bodyId)
  );
  return live.length === 1 ? live[0]!.bodyId : null;
}
