/**
 * Body names and display colours in a 3MF model part.
 *
 * The paired writer emits one `<object>` per solid with only an id and a
 * type. This names each object after its body and colours it twice over:
 *
 * - one core `<basematerials>` group whose `<base>` entries are the
 *   distinct display colours, so a reader of the core format alone lists
 *   them; and
 * - one Materials extension `<m:colorgroup>` per distinct colour, holding
 *   that one `<m:color>`, which each object selects with `pid` and
 *   `pindex="0"`.
 *
 * One group per colour is what OrcaSlicer needs: its importer keeps a single
 * colour per `m:colorgroup` (the last one) and matches it to the object's
 * `pid`, ignoring `pindex`, and it reads no `basematerials`. Bambu Studio
 * reads both resources by `pid` and `pindex`, so it resolves the same
 * colours. The extension is declared under the literal prefix `m`, which
 * both importers match by name, and is not required: a reader without it
 * still opens the geometry. PrusaSlicer reads no 3MF colour at all.
 * Recorded in docs/exchange-loss-contract.md.
 */

/** The 3MF Materials and Properties extension namespace. */
export const THREE_MF_MATERIAL_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

/** One written object's label, in the order the writer emitted solids. */
export interface ThreeMfObjectLabel {
  /** The body's name; an empty name writes no `name` attribute. */
  readonly name: string;
  /** The body's display colour, `#rrggbb`. */
  readonly color: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const OBJECT_TAG = /<object\b[^>]*>/g;

/** A name as an XML 1.0 attribute: characters XML cannot carry are left out. */
function escapeXmlAttribute(value: string): string {
  return (
    value
      // XML 1.0's Char production: no other controls, surrogate halves,
      // U+FFFE or U+FFFF.
      .replace(/[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/[\t\n\r]/g, (c) => `&#${c.charCodeAt(0)};`)
  );
}

/**
 * Names and colours the writer's objects, one label per object in document
 * order. Refuses rather than guessing when the part does not hold exactly one
 * object per label, or already carries properties of its own: a mismatched
 * label would put one body's name and colour on another.
 */
export function labelThreeMfObjects(
  model: string,
  labels: readonly ThreeMfObjectLabel[]
): string {
  const tags = [...model.matchAll(OBJECT_TAG)].map(([tag]) => tag);
  if (tags.length !== labels.length) {
    throw new Error(
      `The 3MF writer wrote ${tags.length} objects for ${labels.length} solids, so the body names and colours cannot be matched to them.`
    );
  }
  if (
    /<(?:[\w-]+:)?(?:basematerials|colorgroup)\b/.test(model) ||
    tags.some((tag) => /\bp(id|index)=/.test(tag))
  ) {
    throw new Error(
      'The 3MF writer already assigned materials; export refused.'
    );
  }
  const root = /<model\b[^>]*>/.exec(model);
  if (!root) {
    throw new Error('Mesh export produced a 3MF model part without <model>.');
  }
  if (/\sxmlns:m=/.test(root[0])) {
    throw new Error(
      'The 3MF writer already declared the m: namespace; export refused.'
    );
  }
  const resources = /<resources\b[^>]*>/.exec(model);
  if (!resources) {
    throw new Error(
      'Mesh export produced a 3MF model part without <resources>.'
    );
  }
  const colors: string[] = [];
  const pindex = labels.map(({ color }) => {
    if (!HEX_COLOR.test(color)) {
      throw new Error(`Body colour "${color}" is not #rrggbb; export refused.`);
    }
    const display = color.toUpperCase();
    const index = colors.indexOf(display);
    return index >= 0 ? index : colors.push(display) - 1;
  });
  // Ids are unique across every resource, so the group takes the next free one.
  const groupId =
    Math.max(
      0,
      ...tags.map((tag) => Number(/\bid="(\d+)"/.exec(tag)?.[1] ?? 0))
    ) + 1;
  // One colour group per distinct colour, after the base group.
  const colorGroupId = (index: number) => groupId + 1 + index;
  let next = 0;
  const labelled = model.replace(OBJECT_TAG, (tag) => {
    const index = next++;
    const name = labels[index]!.name;
    // A function replacement: a name may contain `$&` and the like.
    return tag.replace(
      /^<object\b/,
      () =>
        `<object${name ? ` name="${escapeXmlAttribute(name)}"` : ''} pid="${colorGroupId(pindex[index]!)}" pindex="0"`
    );
  });
  // The core format requires a resource to be defined before anything that
  // references it, so the groups open <resources>.
  const groups = `\n  <basematerials id="${groupId}">${colors
    .map((color) => `\n   <base name="${color}" displaycolor="${color}"/>`)
    .join('')}\n  </basematerials>${colors
    .map(
      (color, index) =>
        `\n  <m:colorgroup id="${colorGroupId(index)}">\n   <m:color color="${color}"/>\n  </m:colorgroup>`
    )
    .join('')}`;
  return labelled
    .replace(resources[0], () => `${resources[0]}${groups}`)
    .replace(
      root[0],
      () => `${root[0].slice(0, -1)} xmlns:m="${THREE_MF_MATERIAL_NAMESPACE}">`
    );
}
