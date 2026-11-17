import { ownEntry } from '@openzcad/shared';
import type {
  ProjectDocument,
  SketchNode,
  SketchPointRef
} from '@openzcad/shared';
import { sketchCompositeTargetNames } from './compositeTargetNames';

/**
 * The name a sketch object gets when nobody named it: the document stores
 * `${objectKind} profile` ("line profile"), which is an internal word, not a
 * name. Such objects show as their kind ("Line"), or as their place in the
 * rectangle or polygon they belong to.
 */
function storedDefaultName(name: string, objectKind: string): boolean {
  return name === '' || name === `${objectKind} profile`;
}

function kindName(objectKind: string): string {
  return objectKind.charAt(0).toUpperCase() + objectKind.slice(1);
}

type LabelledSketch = Pick<SketchNode, 'objectIds'> &
  Partial<Pick<SketchNode, 'composites'>>;

/** Where each composite member sits: its shape's name and its side index. */
function compositeMembership(sketch: LabelledSketch): Map<
  string,
  {
    shape: string;
    side: number | null;
    sides: number;
  }
> {
  const composites = sketch.composites ?? [];
  const names = sketchCompositeTargetNames(composites);
  const membership = new Map<
    string,
    { shape: string; side: number | null; sides: number }
  >();
  for (const composite of composites) {
    const shape = names.get(composite.compositeId) ?? 'Shape';
    composite.edgeIds.forEach((id, side) =>
      membership.set(String(id), {
        shape,
        side,
        sides: composite.edgeIds.length
      })
    );
    for (const id of composite.helperIds ?? []) {
      membership.set(String(id), {
        shape,
        side: null,
        sides: composite.edgeIds.length
      });
    }
  }
  return membership;
}

/**
 * Display names for a sketch's objects. Authored names are kept (repeats
 * get a number); unnamed objects read as their kind ("Line 2") or their
 * place in a shape ("Rectangle 1 side 3"). Saved names are never changed.
 */
export function sketchObjectLabels(
  document: ProjectDocument,
  sketch: LabelledSketch
): Map<string, string> {
  const membership = compositeMembership(sketch);
  const objects = [...new Set(sketch.objectIds)].flatMap((id) => {
    const node = ownEntry(document.nodes, id);
    if (node?.kind !== 'sketch-object') return [];
    const kind = node.data.objectKind;
    if (!storedDefaultName(node.name ?? '', kind)) {
      return [{ id, name: node.name, fixed: false }];
    }
    const member = membership.get(String(id));
    if (member) {
      return [
        {
          id,
          name:
            member.side === null
              ? `${member.shape} guide`
              : `${member.shape} side ${member.side + 1}`,
          // A side's name is already unique; a shape's guides repeat.
          fixed: member.side !== null
        }
      ];
    }
    return [{ id, name: kindName(kind), fixed: false }];
  });
  const counts = new Map<string, number>();
  for (const { name } of objects) counts.set(name, (counts.get(name) ?? 0) + 1);
  const used = new Set(objects.map(({ name }) => name));
  const next = new Map<string, number>();
  return new Map(
    objects.map(({ id, name, fixed }) => {
      if (fixed || counts.get(name) === 1) return [id, name];
      let index = next.get(name) ?? 1;
      while (used.has(`${name} ${index}`)) index += 1;
      const label = `${name} ${index}`;
      used.add(label);
      next.set(name, index + 1);
      return [id, label];
    })
  );
}

/**
 * Names a stored sketch point for people: "end of Line 2", "center of
 * Circle 1", or a shape's corner ("corner 2 of Rectangle 1") when the
 * point is the end of one of its sides.
 */
export function sketchPointNamer(
  sketch: LabelledSketch,
  labels: ReadonlyMap<string, string>
): (ref: SketchPointRef) => string {
  const membership = compositeMembership(sketch);
  return (ref) => {
    const id = String(ref.objectId);
    const member = membership.get(id);
    if (member && member.side !== null && ref.point !== 'center') {
      const corner =
        ref.point === 'start'
          ? member.side
          : (member.side + 1) % Math.max(1, member.sides);
      return `corner ${corner + 1} of ${member.shape}`;
    }
    return `${ref.point} of ${labels.get(id) ?? 'entity'}`;
  };
}
