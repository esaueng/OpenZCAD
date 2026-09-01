/**
 * Screens a STEP file for an inner bound wound the same way as its face's
 * outer bound.
 *
 * ISO 10303-42 wants an inner bound to run CW about the face's outward normal,
 * so that material stays on the left. A file that runs one CCW imports without
 * complaint — remus `validate_solid` reports valid with the correct volume —
 * and the damage only appears in the NEXT boolean, as "shared edges have
 * inconsistent face orientations" reported against an operation whose own
 * geometry is fine. See esaueng/remus#115.
 *
 * This reads the exchange text rather than the imported topology on purpose:
 * the defect is a property of the FILE, and a screen that went through the
 * kernel could only see what the kernel chose to preserve.
 *
 * Deliberately narrow. It covers a planar face whose inner bound is a single
 * full circle, which is the signature #115 documents and the one remus's own
 * older exporter produced. The circle may sit behind the TRIMMED_CURVE wrapper
 * the current exporter gives every curved edge; the wrapper is seen through,
 * with its sense flag composed. A multi-edge inner loop needs the loop's
 * signed area and is reported as UNSCREENED rather than as clean — absence of
 * a finding is only meaningful for the shapes listed in
 * {@link StepInnerLoopScreen.screened}.
 */

/** One entity: its type keyword and its raw, comma-separated argument text. */
type Entity = { readonly type: string; readonly args: string };

export interface InnerLoopFinding {
  /** `#id` of the offending ADVANCED_FACE. */
  readonly faceId: number;
  /** The face's outward normal, after `same_sense`. */
  readonly normal: readonly [number, number, number];
  /** The inner circle's axis direction, as written. */
  readonly circleAxis: readonly [number, number, number];
}

export interface StepInnerLoopScreen {
  readonly findings: readonly InnerLoopFinding[];
  /** Inner bounds this screen could judge. */
  readonly screened: number;
  /** Inner bounds it could not: multi-edge loops, non-circular curves. */
  readonly unscreened: number;
}

const ENTITY = /^#(\d+)\s*=\s*([A-Z_0-9]+)\s*\((.*)\)$/s;

/** Splits an argument list on top-level commas, ignoring nested parentheses. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

function entityRefs(text: string): number[] {
  return [...text.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

/** `.T.` / `.F.` as +1 / -1; null for anything else, including `.U.`. */
function sense(token: string): number | null {
  if (token.includes('.T.')) return 1;
  if (token.includes('.F.')) return -1;
  return null;
}

function parse(text: string): Map<number, Entity> {
  const entities = new Map<number, Entity>();
  const start = text.indexOf('DATA;');
  if (start < 0) return entities;
  const end = text.indexOf('ENDSEC;', start);
  const body = text.slice(start + 'DATA;'.length, end < 0 ? undefined : end);
  for (const chunk of body.split(';')) {
    const match = ENTITY.exec(chunk.replace(/\s+/g, ' ').trim());
    if (match) {
      entities.set(Number(match[1]), { type: match[2]!, args: match[3]! });
    }
  }
  return entities;
}

function direction(
  entities: Map<number, Entity>,
  id: number | undefined
): [number, number, number] | null {
  const entity = id === undefined ? undefined : entities.get(id);
  if (entity?.type !== 'DIRECTION') return null;
  const numbers = [
    ...(splitArgs(entity.args)[1] ?? '').matchAll(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g)
  ].map((match) => Number(match[0]));
  return numbers.length >= 3
    ? [numbers[0]!, numbers[1]!, numbers[2]!]
    : null;
}

/** An AXIS2_PLACEMENT_3D's axis: its SECOND reference, after the location. */
function placementAxis(
  entities: Map<number, Entity>,
  id: number | undefined
): [number, number, number] | null {
  const entity = id === undefined ? undefined : entities.get(id);
  if (entity?.type !== 'AXIS2_PLACEMENT_3D') return null;
  return direction(entities, entityRefs(entity.args)[1]);
}

function dot(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

export function screenStepInnerLoops(text: string): StepInnerLoopScreen {
  const entities = parse(text);
  const findings: InnerLoopFinding[] = [];
  let screened = 0;
  let unscreened = 0;

  for (const [faceId, face] of entities) {
    if (face.type !== 'ADVANCED_FACE') continue;
    const faceArgs = splitArgs(face.args);
    if (faceArgs.length < 4) continue;
    const faceSense = sense(faceArgs[3]!);
    const surface = entities.get(entityRefs(faceArgs[2]!)[0] ?? -1);
    if (faceSense === null || surface?.type !== 'PLANE') continue;
    const planeAxis = placementAxis(entities, entityRefs(surface.args)[0]);
    if (!planeAxis) continue;
    const normal: [number, number, number] = [
      planeAxis[0] * faceSense,
      planeAxis[1] * faceSense,
      planeAxis[2] * faceSense
    ];

    for (const boundId of entityRefs(faceArgs[1]!)) {
      const bound = entities.get(boundId);
      // FACE_OUTER_BOUND is the outer wire; only FACE_BOUND is a hole.
      if (bound?.type !== 'FACE_BOUND') continue;
      const boundArgs = splitArgs(bound.args);
      const boundSense = sense(boundArgs[2] ?? '');
      const loop = entities.get(entityRefs(boundArgs[1] ?? '')[0] ?? -1);
      if (boundSense === null || loop?.type !== 'EDGE_LOOP') continue;
      const orientedIds = entityRefs(splitArgs(loop.args)[1] ?? '');
      if (orientedIds.length !== 1) {
        unscreened += 1;
        continue;
      }
      const oriented = entities.get(orientedIds[0]!);
      if (oriented?.type !== 'ORIENTED_EDGE') continue;
      const orientedArgs = splitArgs(oriented.args);
      const edgeSense = sense(orientedArgs[4] ?? '');
      const edge = entities.get(entityRefs(orientedArgs[3] ?? '')[0] ?? -1);
      if (edgeSense === null || edge?.type !== 'EDGE_CURVE') continue;
      const edgeArgs = splitArgs(edge.args);
      const curveSense = sense(edgeArgs[4] ?? '');
      let curve = entities.get(entityRefs(edgeArgs[3] ?? '')[0] ?? -1);
      if (curveSense === null || !curve) continue;
      // The current exporter wraps curved edges in a TRIMMED_CURVE carrying
      // the edge's parameter authority. The wrapper bounds the parameter
      // range; the winding still comes from the basis curve, with the trim's
      // own sense flag composing in.
      let trimSense = 1;
      if (curve.type === 'TRIMMED_CURVE') {
        const trimArgs = splitArgs(curve.args);
        const senseAgreement = sense(trimArgs[4] ?? '');
        const basis = entities.get(entityRefs(trimArgs[1] ?? '')[0] ?? -1);
        if (senseAgreement === null || !basis) continue;
        trimSense = senseAgreement;
        curve = basis;
      }
      if (curve.type !== 'CIRCLE') {
        unscreened += 1;
        continue;
      }
      const circleAxis = placementAxis(entities, entityRefs(curve.args)[0]);
      if (!circleAxis) continue;

      screened += 1;
      // Geometric sense of the circle about the face's outward normal,
      // composed with every orientation flag between the face and the curve.
      const geometric = dot(circleAxis, normal) > 0 ? 1 : -1;
      if (geometric * boundSense * edgeSense * curveSense * trimSense > 0) {
        findings.push({ faceId, normal, circleAxis });
      }
    }
  }

  return { findings, screened, unscreened };
}
