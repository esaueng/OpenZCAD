import {
  UNIT_TO_MM,
  ownEntry,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import type { CadPatchProposal, CadSelectionContext } from './index';

const NUMBER = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const UNIT = '(?:mm|cm|m|inches|inch|in)';
const DRILL_HOLE = new RegExp(
  `^(?:drill|add|make|cut|put)\\s+(?:a|one)\\s+` +
    // Diameter: "6 mm", "6 mm diameter", "6mm wide".
    `(?:(${NUMBER})\\s*(${UNIT})?\\s+(?:(?:diameter|dia\\.?|wide)\\s+)?)?` +
    `(?:(through|thru|blind)\\s+)?hole` +
    `(?:\\s+(${NUMBER})\\s*(${UNIT})?\\s+deep)?` +
    `(?:\\s+(through\\s+all|all\\s+the\\s+way\\s+through))?` +
    `(?:\\s+(?:in|into|on|through)\\s+(?:the\\s+)?(?:this|selected|picked)\\s+face)?$`,
  'i'
);

/** The Hole tool's own defaults, in document units. */
const DEFAULT_DIAMETER = 6;
const DEFAULT_DEPTH = 10;

export interface SelectedFaceHoleRequest {
  diameter: number | null;
  diameterUnit: UnitSystem | undefined;
  depthMode: 'blind' | 'through' | null;
  depth: number | null;
  depthUnit: UnitSystem | undefined;
}

function unitOf(text: string | undefined): UnitSystem | undefined {
  const unit = text?.toLowerCase();
  return unit?.startsWith('in') ? 'inch' : (unit as UnitSystem | undefined);
}

/**
 * F03: deliberately accepts one simple hole in the one selected flat face,
 * never a placement, a pattern, or a counterbore/countersink.
 */
export function parseSelectedFaceHoleRequest(
  prompt: string
): SelectedFaceHoleRequest | null {
  let text = prompt
    .trim()
    .replace(/^(?:can|could|would)\s+you\s+/i, '')
    .replace(/^please\s+/i, '');
  let end = text.length;
  while (end > 0 && '.!?'.includes(text.charAt(end - 1))) end -= 1;
  text = text.slice(0, end).trim().replace(/\s+/g, ' ');
  const matched = DRILL_HOLE.exec(text);
  if (!matched) return null;
  const [, diameter, diameterUnit, rawKind, depth, depthUnit, throughAll] =
    matched;
  const kind = rawKind?.toLowerCase();
  const blind = kind === 'blind';
  const through = kind === 'through' || kind === 'thru' || !!throughAll;
  // "A through hole 5 mm deep" or "a blind hole through all" says two
  // things; it is left to the provider rather than guessed.
  if (through && (blind || depth !== undefined)) return null;
  return {
    diameter: diameter === undefined ? null : Number(diameter),
    diameterUnit: unitOf(diameterUnit),
    depthMode:
      depth !== undefined || blind ? 'blind' : through ? 'through' : null,
    depth: depth === undefined ? null : Number(depth),
    depthUnit: unitOf(depthUnit)
  };
}

export type SelectedFaceHoleResult =
  | { proposal: CadPatchProposal; error?: never }
  | { error: string; proposal?: never };

/** A length in document units, or NaN for an unknown unit. */
function documentLength(
  value: number,
  unit: UnitSystem | undefined,
  document: ProjectDocument
): number {
  const from = ownEntry(UNIT_TO_MM, unit ?? document.units);
  const to = ownEntry(UNIT_TO_MM, document.units);
  return from === undefined || to === undefined
    ? Number.NaN
    : (value * from) / to;
}

/**
 * Drills the one selected planar face at its centre through the manual Hole
 * command. Resolved from the complete local exact topology, not the provider
 * digest; the result still needs the normal exact preview and Apply.
 */
export function createSelectedFaceHoleProposal(
  document: ProjectDocument,
  selection: CadSelectionContext,
  prompt: string
): SelectedFaceHoleResult | null {
  const request = parseSelectedFaceHoleRequest(prompt);
  if (!request) return null;
  const faces = selection.topologies.filter(
    (topology) => topology.kind === 'face'
  );
  if (faces.length !== 1 || typeof faces[0]!.hash !== 'number') {
    return {
      error: 'Select the one flat face to drill, then ask again.'
    };
  }
  const picked = faces[0]!;
  const body = ownEntry(document.derived.bodyRepresentations, picked.bodyId);
  if (!body || body.consumed) {
    return { error: 'The selected face is no longer on a live body.' };
  }
  if (!body.topology || body.source === 'imported-mesh') {
    return { error: `${body.name} needs exact solid faces before drilling.` };
  }
  const face = body.topology.faces.find(
    (candidate) => candidate.hash === picked.hash
  );
  if (!face) {
    return { error: 'The selected face is no longer on a live body.' };
  }
  if (face.geometry?.surfaceType !== 'plane' || !face.geometry.normal) {
    return {
      error: 'The Hole tool drills only flat faces. Select a flat face.'
    };
  }
  if (!face.reference) {
    return {
      error: `The selected face of ${body.name} has no exact reference to drill from.`
    };
  }
  const diameter =
    request.diameter === null
      ? DEFAULT_DIAMETER
      : documentLength(request.diameter, request.diameterUnit, document);
  if (!Number.isFinite(diameter) || diameter <= 0) {
    return { error: 'The hole diameter must be a positive finite length.' };
  }
  // The Hole tool drills through all unless a depth is named.
  const depthMode = request.depthMode ?? 'through';
  const depth =
    depthMode === 'through'
      ? null
      : request.depth === null
        ? DEFAULT_DEPTH
        : documentLength(request.depth, request.depthUnit, document);
  if (depth !== null && (!Number.isFinite(depth) || depth <= 0)) {
    return { error: 'The hole depth must be a positive finite length.' };
  }
  const assumptions = [
    ...(request.diameter === null
      ? [
          `Using the Hole tool's default diameter of ${DEFAULT_DIAMETER} ${document.units}.`
        ]
      : []),
    ...(depthMode === 'blind' && request.depth === null
      ? [
          `Using the Hole tool's default depth of ${DEFAULT_DEPTH} ${document.units}.`
        ]
      : []),
    'Drilled at the centre of the selected face.'
  ];
  return {
    proposal: {
      proposalId: `selected_face_hole_${document.version}`,
      summary:
        depthMode === 'through'
          ? `Drill a ${diameter} ${document.units} through hole in ${body.name}.`
          : `Drill a ${diameter} ${document.units} hole ${depth} ${document.units} deep in ${body.name}.`,
      assumptions,
      operations: [
        {
          kind: 'add_hole',
          name: 'Hole',
          targetBodyId: body.bodyId,
          faceHash: face.hash,
          faceReference: face.reference,
          diameter,
          depthMode,
          depth,
          position: { u: 0, v: 0 }
        }
      ]
    }
  };
}
