/**
 * Body names and display colours in a 3MF model part.
 *
 * The paired writer emits one `<object>` per solid with only an id and a
 * type. This names each object after its body and colours it through the 3MF
 * core format's own property resource: one `<basematerials>` group whose
 * `<base>` entries are the distinct display colours, referenced from each
 * object by `pid` and `pindex`. No extension namespace is declared, so every
 * conforming reader can open the file.
 *
 * What the common slicers make of it (read from their 3MF importers, and
 * recorded in docs/exchange-loss-contract.md): every one names the parts
 * after `name`; Bambu Studio also turns each distinct colour into a filament
 * slot; PrusaSlicer and OrcaSlicer skip `basematerials`.
 */

/** One written object's label, in the order the writer emitted solids. */
export interface ThreeMfObjectLabel {
  /** The body's name; an empty name writes no `name` attribute. */
  readonly name: string;
  /** The body's display colour, `#rrggbb`. */
  readonly color: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const OBJECT_TAG = /<object\b[^>]*>/g;

/** A name as an XML 1.0 attribute: other control characters cannot be written at all. */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/[^\t\n\r\u0020-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\t\n\r]/g, (c) => `&#${c.charCodeAt(0)};`);
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
    /<basematerials\b/.test(model) ||
    tags.some((tag) => /\bp(id|index)=/.test(tag))
  ) {
    throw new Error(
      'The 3MF writer already assigned materials; export refused.'
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
  let next = 0;
  const labelled = model.replace(OBJECT_TAG, (tag) => {
    const index = next++;
    const name = labels[index]!.name;
    // A function replacement: a name may contain `$&` and the like.
    return tag.replace(
      /^<object\b/,
      () =>
        `<object${name ? ` name="${escapeXmlAttribute(name)}"` : ''} pid="${groupId}" pindex="${pindex[index]}"`
    );
  });
  // The core format requires a resource to be defined before anything that
  // references it, so the group opens <resources>.
  const group = `\n  <basematerials id="${groupId}">${colors
    .map((color) => `\n   <base name="${color}" displaycolor="${color}"/>`)
    .join('')}\n  </basematerials>`;
  return labelled.replace(resources[0], () => `${resources[0]}${group}`);
}
