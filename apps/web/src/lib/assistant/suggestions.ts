/**
 * Openers for an empty thread.
 *
 * A blank prompt box is the hardest part of a modeling assistant: it never says
 * what it is good at. These are phrased as the requests that actually work —
 * concrete dimensions, named features — and they follow the selection, so the
 * first thing offered is about the thing under the cursor.
 */
export interface AssistantSuggestionContext {
  bodyCount: number;
  /** The kind every selected topology shares, when they share one. */
  topologyKind: 'body' | 'face' | 'edge' | null;
  selectedBodyCount: number;
}

export function assistantSuggestions(
  context: AssistantSuggestionContext
): string[] {
  if (context.topologyKind === 'edge') {
    return [
      'Fillet the selected edges by 2 mm',
      'Chamfer the selected edges 1 mm',
      'What would rounding these edges do to the part?'
    ];
  }
  if (context.topologyKind === 'face') {
    return [
      'Cut a 6 mm hole through the selected face',
      'Offset the selected face out by 3 mm',
      'Sketch a 20 mm slot on the selected face'
    ];
  }
  if (context.selectedBodyCount > 0) {
    return [
      'Round every outside edge of the selection by 2 mm',
      'Pattern the selected body 4 times, 30 mm apart along X',
      'Add a parameter for the wall thickness and drive the selection from it'
    ];
  }
  if (context.bodyCount === 0) {
    return [
      'Model an 80 × 60 × 6 mm plate with four M4 clearance holes',
      'Build a 40 mm cube with 3 mm rounded edges',
      'Make a Ø30 × 60 mm shaft with a 1 mm chamfer on both ends'
    ];
  }
  return [
    'Round every outside edge by 2 mm',
    'Cut a 12 mm bore through the tallest body',
    'What is this model made of, feature by feature?'
  ];
}
