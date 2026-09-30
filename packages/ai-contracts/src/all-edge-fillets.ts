import type { ProjectDocument, UnitSystem } from '@openzcad/shared';
import type { CadPatchProposal, CadSelectionContext } from './index';

const NUMBER = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const UNIT = '(?:mm|cm|m|inches|inch|in)';
const ADD_FILLET = new RegExp(
  `^(?:add|apply|put)\\s+(?:a\\s+)?(?:(${NUMBER})\\s*(${UNIT})?\\s+)?(?:fillet|filet)s?\\s+(?:to|on|around)\\s+`,
  'i'
);
const ALL_EDGES = new RegExp(
  `^(?:all(?:\\s+of)?(?:\\s+the)?\\s+edges|every\\s+edge|each\\s+edge)` +
    `(?:\\s+(?:of|on)\\s+(.+?))?` +
    `(?:\\s+(?:by|with|using|at)\\s+(?:a\\s+)?(?:radius(?:\\s+of)?\\s+)?` +
    `(${NUMBER})\\s*(${UNIT})?(?:\\s+(?:radius|fillet))?)?$`,
  'i'
);
const UNIT_TO_MM: Record<UnitSystem, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  inch: 25.4
};

/** Deliberately accepts one whole-part operation, never a qualified subset. */
export function parseAllEdgesFilletRequest(prompt: string) {
  const text = prompt
    .trim()
    .replace(/^(?:can|could|would)\s+you\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  const added = ADD_FILLET.exec(text);
  const remainder = added
    ? text.slice(added[0].length)
    : text.replace(/^(?:fillet|filet|round(?:\s+(?:off|over))?)\s+/i, '');
  if (!added && remainder === text) return null;
  const matched = ALL_EDGES.exec(remainder);
  if (!matched || (added?.[1] && matched[2])) return null;
  const radiusText = added?.[1] ?? matched[2];
  const unitText = (added?.[2] ?? matched[3])?.toLowerCase();
  return {
    target: matched[1]?.trim() ?? null,
    radius: radiusText === undefined ? null : Number(radiusText),
    unit: unitText?.startsWith('in')
      ? ('inch' as const)
      : (unitText as UnitSystem | undefined)
  };
}

export type AllEdgesFilletResult =
  | { proposal: CadPatchProposal; error?: never }
  | { error: string; proposal?: never };

/**
 * Uses the complete local exact topology, not the provider digest's bounded
 * edge sample. Every result still needs normal exact preview and Apply.
 */
export function createAllEdgesFilletProposal(
  document: ProjectDocument,
  selection: CadSelectionContext,
  prompt: string
): AllEdgesFilletResult | null {
  const request = parseAllEdgesFilletRequest(prompt);
  if (!request) return null;
  const bodies = Object.values(document.derived.bodyRepresentations).filter(
    (body) => !body.consumed
  );
  const selectedIds = new Set([
    ...selection.bodyIds,
    ...selection.topologies.map((topology) => topology.bodyId)
  ]);
  const selected = bodies.filter((body) => selectedIds.has(body.bodyId));
  const target = request.target?.toLowerCase().replace(/^the\s+/, '');
  const namesSelection = /^(?:this|selected|my)\s+(?:body|part|solid)$/.test(
    target ?? ''
  );
  const genericTarget = target == null || /^(?:body|part|solid)$/.test(target);
  const named = bodies.filter((body) => {
    const name = body.name.toLowerCase();
    return target === name || target === name.replace(/ body$/, '');
  });
  const candidates = namesSelection
    ? selected
    : genericTarget
      ? selected.length > 0
        ? selected
        : bodies
      : named;
  if (candidates.length !== 1) {
    return {
      error:
        bodies.length === 0
          ? 'Create or import a solid before filleting its edges.'
          : 'Select one part, or name the part whose edges should be filleted.'
    };
  }
  const body = candidates[0]!;
  if (!body.topology || body.source === 'imported-mesh') {
    return { error: `${body.name} needs exact solid edges before filleting.` };
  }
  const edgeHashes = [
    ...new Set(
      body.topology.edges
        .filter((edge) => edge.displayRole !== 'seam')
        .map((edge) => edge.hash)
    )
  ];
  if (edgeHashes.length === 0) {
    return { error: `${body.name} has no physical edges to fillet.` };
  }
  // Match the manual tool's 2-document-unit default. Explicit units are
  // converted once; the history stores the actual radius in document units.
  const radius =
    request.radius === null
      ? 2
      : (request.radius * UNIT_TO_MM[request.unit ?? document.units]) /
        UNIT_TO_MM[document.units];
  if (!Number.isFinite(radius) || radius <= 0) {
    return { error: 'The fillet radius must be a positive finite length.' };
  }
  return {
    proposal: {
      proposalId: `all_edges_fillet_${document.version}`,
      summary: `Fillet all ${edgeHashes.length} edges of ${body.name} at ${radius} ${document.units}.`,
      assumptions:
        request.radius === null
          ? [`Using the Fillet tool's default radius of 2 ${document.units}.`]
          : [],
      operations: [
        {
          kind: 'add_edge_modifier',
          name: 'All-edge fillet',
          modifier: 'fillet',
          targetBodyId: body.bodyId,
          edgeHashes,
          size: radius
        }
      ]
    }
  };
}
