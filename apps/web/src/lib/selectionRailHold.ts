import type {
  SelectionCalloutContent,
  SelectionCalloutVerb
} from './selectionCallout';
import { TOOL_META, type ToolId } from './tools';

/**
 * While the hand is on the handle, and while the exact check that follows
 * the release runs, the rail is held: nothing but the verb being made can
 * act on the pick until the check answers. The rail keeps every button it
 * had, the others disabled in place rather than taken away, so it changes
 * neither what it shows nor its height across one pick's drag.
 */
export function selectionRailHeld(content: SelectionCalloutContent): boolean {
  const phase = content.operation?.phase;
  return phase === 'dragging' || phase === 'validating';
}

/**
 * Whether the rail lets `verb` act now: the same answer its button gives.
 * While the hand is on the handle only the verb being made acts, and the
 * exact check owns the pick until it answers: another action then would
 * leave the old operation free to commit late.
 */
export function selectionRailVerbEnabled(
  content: SelectionCalloutContent,
  verb: SelectionCalloutVerb
): boolean {
  const phase = content.operation?.phase;
  return (
    !verb.disabled &&
    phase !== 'validating' &&
    !(phase === 'dragging' && !verb.pressed)
  );
}

/**
 * Why `tool` cannot be launched now, by any route (a shortcut, the palette,
 * the rail), or null when it can. Only a held rail refuses: then a tool
 * launches only where its own verb on the rail is still enabled, so a key
 * never starts what the rail shows greyed out (and never cancels the drag
 * by opening over it). Escape is not a tool and still ends the drag.
 */
export function selectionRailToolHoldReason(
  content: SelectionCalloutContent | null,
  tool: ToolId
): string | null {
  if (!content || !selectionRailHeld(content)) return null;
  const verb = content.verbs.find(
    (candidate) => candidate.id === `tool:${tool}`
  );
  if (verb && selectionRailVerbEnabled(content, verb)) return null;
  const title = content.operation?.title ?? 'The operation';
  return content.operation?.phase === 'dragging'
    ? `${title} is being dragged · let go of the handle first, or press Esc to cancel it.`
    : `${title} is being checked · ${TOOL_META[tool].label} is available once it answers.`;
}
