/**
 * One plain sentence for a refusal, with the kernel's own words kept behind
 * it.
 *
 * The reference states a refusal as a single sentence naming the cause and
 * nothing else. Our adapter writes its own refusals that way, but a failure
 * raised inside the kernel arrives as the kernel's diagnostic — lowercase,
 * tagged, counted (`exact-only policy: the exact boolean pipeline could not
 * produce this result…`, `boolean result has degenerate topology (F=…`) — and
 * that used to be the headline. The translation is a fixed table, so every
 * sentence a person reads here was written by a person; the kernel text is
 * never discarded, it moves into the detail the card shows on request.
 */

import { ownEntry } from '@openzcad/shared';
export interface PlainRefusal {
  message: string;
  headline?: string;
  detail?: string;
  /**
   * The kernel's own classification of the refusal, when the rebuild recorded
   * one. Copy may be reworded; this is the field a caller branches on.
   */
  category?: string;
  /**
   * The kernel's or adapter's refusal code (`reference_missing`, …), when the
   * rebuild typed one: the specific verdict `category` groups.
   */
  code?: string;
}

/**
 * A STEP parser refusal needs an action as well as the broken entity number.
 * Keep this at the import boundary: a generic kernel failure must not tell a
 * person to re-export a file that was never part of the operation.
 */
export function stepImportRefusal(text: string): PlainRefusal {
  if (!/^parse error:/i.test(text.trimStart())) {
    return { message: text };
  }
  return {
    message:
      'This STEP file could not be read. Export a fresh STEP file from the source CAD project and try again.',
    detail: text.trim()
  };
}

/**
 * One sentence per kernel failure category.
 *
 * The category comes from `FeatureWarning.kernelRefusal`, which the adapter
 * fills from the kernel's typed results. Before it existed, every refusal
 * whose sentence the kernel wrote collapsed into one GENERIC line: a domain
 * the engine does not support, a budget that was exceeded and geometry
 * refused on quality were three different stories told identically. They are
 * three sentences now.
 *
 * Keyed by string rather than by a union imported from the adapter, on
 * purpose: the category crosses the boundary as a string precisely so a new
 * kernel category cannot break a build here, and an unrecognised one falls
 * back to GENERIC exactly as an uncategorised refusal does.
 */
const CATEGORY_SENTENCES: Readonly<Record<string, string>> = {
  unsupported:
    'The exact kernel does not support this combination of shapes yet.',
  resource_limit:
    "This operation went past the exact kernel's budget for this kind of work.",
  quality_refused:
    'The exact kernel could not build this exactly, and an approximate ' +
    'result was declined.',
  nonconvergence:
    'The exact kernel could not settle where these surfaces meet.',
  tolerance_violation:
    'This could not be built within the exact kernel’s tolerance.',
  invalid_input: 'The exact kernel rejected the input for this operation.',
  invalid_topology: 'The resulting body came back invalid.',
  cancelled: 'The operation was cancelled before it finished.',
  internal: 'The exact kernel failed internally on this operation.'
};

/**
 * The kernel's typed record of a refusal, as `FeatureWarning.kernelRefusal`
 * carries it. Only the fields the copy branches on.
 */
export interface RefusalClassification {
  category: string;
  code?: string;
  reason?: string;
  neighborSurfaceType?: string;
}

const FREEFORM_NEIGHBOR =
  "This face meets a fillet or freeform surface, which resizing and moving faces can't follow yet.";
const CURVED_NEIGHBOR =
  "This face meets a curved surface that resizing and moving faces can't follow yet. Change the size on the original shape in History instead.";
const PARTIAL_WALL =
  "This hole's wall doesn't end in full circles, which resizing can't follow yet. Change the size on the original shape in History instead.";

/**
 * The sentence for a refused face move the kernel typed, read from its code
 * and cause rather than its prose. Null when the record does not name a cause
 * this table has a sentence for; the prose table below then still applies,
 * because untyped paths (move-faces, previews) reach the same sentences.
 */
function typedSentence(typed: RefusalClassification): string | null {
  if (typed.code === 'cylinder-diameter-unbuildable') {
    return 'That diameter does not fit the existing supports and fillets. Try a smaller diameter.';
  }
  if (
    typed.category === 'quality_refused' &&
    typed.code === 'exact_only_unattainable'
  ) {
    return typed.reason === 'approximate_reblend_not_permitted'
      ? 'Resizing this face would require an approximate fillet. This edit only allows exact geometry.'
      : CATEGORY_SENTENCES.quality_refused!;
  }
  if (typed.code !== 'unsupported_move_face') {
    return null;
  }
  switch (typed.reason) {
    case 'unsupported_neighbor':
      switch (typed.neighborSurfaceType) {
        case 'nurbs':
        case 'bspline':
          return FREEFORM_NEIGHBOR;
        case 'sphere':
        case 'torus':
        case 'cone':
          return CURVED_NEIGHBOR;
        default:
          return null;
      }
    case 'partial_reversed_wall':
      return PARTIAL_WALL;
    default:
      return null;
  }
}

/**
 * One table row. A sentence that names a number the kernel stated is written
 * as a function of the match; the words are still ours, only the number is
 * the kernel's.
 */
interface Translation {
  pattern: RegExp;
  sentence: string | ((match: RegExpExecArray) => string);
}

function sentenceOf(translation: Translation, text: string): string {
  if (typeof translation.sentence === 'string') return translation.sentence;
  const match = translation.pattern.exec(text);
  return match ? translation.sentence(match) : GENERIC;
}

const TRANSLATIONS: readonly Translation[] = [
  {
    pattern: /unsupported STEP entity:/i,
    sentence:
      'This STEP file uses a geometry type the importer does not support yet.'
  },
  {
    pattern: /through-hole diameter .* does not fit/i,
    sentence: 'The hole does not fit this body.'
  },
  {
    pattern: /removing the selected face failed/i,
    sentence: 'The selected face could not be removed.'
  },
  {
    pattern: /could not be sewn into a shell/i,
    sentence: 'This mesh could not be made into a solid.'
  },
  {
    pattern:
      /\[object WebAssembly\.Exception\]|RuntimeError|unreachable|panicked|memory access out of bounds|out of memory/i,
    sentence: 'The exact kernel crashed on this operation.'
  },
  {
    pattern: /exact-only policy|approximate fallback/i,
    sentence: 'The exact kernel could not build this result.'
  },
  {
    pattern: /conical cap reaches or crosses its support apex/i,
    sentence:
      'The conical end would collapse at that distance. Try a smaller offset.'
  },
  {
    pattern: /radial resize intersects nonincident meridian boundaries/i,
    sentence: 'That diameter would make parts of the body overlap.'
  },
  {
    pattern:
      /radial resize (?:reverses a meridian segment|collapses a (?:meridian segment|torus ring))/i,
    sentence:
      'That diameter would collapse a wall or blend. Try a smaller change.'
  },
  {
    // A resized or moved face is re-limited against its boundary neighbours,
    // and the kernel can only do that against planes, cylinders and axial
    // cones. A boss that grows out of a sphere meets the sphere; once the
    // seam is filleted it meets the blend band, which is a NURBS surface.
    // Editing the source feature rebuilds the boolean instead, which does
    // handle the sphere, so the sphere case names that route. A blend
    // neighbour gets no route: replaying the history currently breaks the
    // fillet's edge selection (docs/plans/kernel-robustness-plan-2026-11-05.md).
    pattern:
      /move-face does not support face [^:]*\((?:nurbs|bspline)\): face is adjacent/i,
    sentence: FREEFORM_NEIGHBOR
  },
  {
    pattern:
      /move-face does not support face [^:]*\((?:sphere|torus|cone)\): face is adjacent/i,
    sentence: CURVED_NEIGHBOR
  },
  {
    // A hole wall that does not run between two whole circles — a blind bore
    // ending on a sphere — is a partial cylinder, and the kernel resizes a
    // partial wall only on the outside of a boss with planar sides. Editing
    // the tool's source size rebuilds the cut and works.
    pattern: /partial-cylinder resize currently requires/i,
    sentence: PARTIAL_WALL
  },
  {
    // A local face move sweeps the face and lets only its edge neighbours
    // stretch; anything else in the path refuses the move.
    pattern:
      /swept face reaches nonadjacent face|sweep may contact a nonadjacent|crosses a nonadjacent source boundary/i,
    sentence:
      'The face would run into another part of the body before it got that far.'
  },
  {
    pattern: /self-intersect/i,
    sentence: 'The resulting body would intersect itself.'
  },
  {
    pattern:
      /non-manifold|degenerate topology|boolean result has|empty result|produced no (?:output |offset )?(?:faces|vertices|solids)|would leave only|would empty|no faces could be assembled/i,
    sentence: "The resulting body wouldn't be valid."
  },
  {
    // A face move re-limits its neighbours; pushed past the length of a
    // neighbour's flat, that flat would vanish (`collapse`) or turn inside
    // out (`reverse`), which changes the body's topology. The kernel names
    // the extent it ran against, and that is how far the face can go.
    pattern:
      /move-face would change topology.*?would (?:collapse|reverse): a move of -?[\d.]+(?:e-?\d+)? against a fixed-to-moving extent of (\d+(?:\.\d+)?(?:e-?\d+)?)/i,
    sentence: (match) =>
      `A neighbouring face would shrink to nothing past ${Math.round(Number(match[1]) * 100) / 100}. Try a smaller offset.`
  },
  {
    pattern:
      /does not fit on the recovered sharp feature|chamfer setback does not fit|blend band touches a freeform|fillet contact map|fillet reconstruction|fillet stitch/i,
    sentence: 'The blend does not fit here. Try a smaller size.'
  },
  {
    pattern: /radius must be positive/i,
    sentence: 'The radius must be greater than zero.'
  },
  {
    pattern: /degenerate/i,
    sentence: 'The geometry collapses to nothing at this value.'
  },
  {
    pattern:
      /intersection failed|face splitting failed|failed to build|failed to (?:add|create|encode)|face has (?:no|empty)|face wire has no edges/i,
    sentence: 'The exact kernel could not build the result surfaces.'
  },
  {
    pattern: /names (?:face|vertex) handle|not among this solid/i,
    sentence: 'The kernel returned inconsistent topology for this body.'
  },
  {
    pattern: /exact geometry failed|unknown kernel error|the kernel rejected/i,
    sentence: 'The exact kernel could not build this feature.'
  }
];

/** The fallback sentence when nothing more specific is known. */
export const GENERIC_REFUSAL = 'The exact kernel could not build this result.';
const GENERIC = GENERIC_REFUSAL;

/**
 * A sentence the kernel wrote rather than the adapter: it opens lowercase or
 * carries an identifier, a tag, or a count in the kernel's own notation.
 */
function looksLikeKernelText(sentence: string): boolean {
  return (
    /^[a-z]/.test(sentence) ||
    /::|\bwasm\b|\[object |\(F=|\bhandle \d|_[a-z]+:/i.test(sentence)
  );
}

/**
 * Splits `<sentence>\n<detail>` and translates the sentence when the kernel
 * wrote it.
 */
export function plainRefusal(
  text: string,
  classification?: string | RefusalClassification
): PlainRefusal {
  const typed = typeof classification === 'object' ? classification : undefined;
  const category =
    typeof classification === 'string' ? classification : typed?.category;
  const separator = text.indexOf('\n');
  const sentence = (separator < 0 ? text : text.slice(0, separator)).trim();
  const tail = separator < 0 ? '' : text.slice(separator + 1).trim();
  const classified = {
    ...(category ? { category } : {}),
    ...(typed?.code ? { code: typed.code } : {})
  };
  // A lost selection is read by the card to know that no value can help; a
  // parse error names the entity of the file that is broken. Both stay.
  if (/no longer exists|^parse error:/.test(sentence)) {
    return tail
      ? { message: sentence, detail: tail, ...classified }
      : { message: sentence, ...classified };
  }
  const byCode = typed ? typedSentence(typed) : null;
  if (byCode) {
    const detail = [sentence, tail].filter(Boolean).join('\n');
    return {
      message: byCode,
      detail,
      ...classified,
      ...(typed?.code === 'cylinder-diameter-unbuildable'
        ? { headline: byCode }
        : {})
    };
  }
  const translation = TRANSLATIONS.find(({ pattern }) =>
    pattern.test(sentence)
  );
  const byCategory = category
    ? ownEntry(CATEGORY_SENTENCES, category)
    : undefined;
  // A table entry names a SYMPTOM and is more specific than any category, so
  // it wins — except where its sentence IS the generic fallback, which says
  // no more than "it did not work". The category says more than that and
  // takes its place. Everything else the kernel wrote used to collapse into
  // that one line; a category now replaces the fallback there too.
  const translated = translation ? sentenceOf(translation, sentence) : null;
  const tabled =
    translated !== null && translated !== GENERIC ? translated : undefined;
  const plain =
    tabled ??
    (translation || looksLikeKernelText(sentence)
      ? (byCategory ?? GENERIC)
      : null);
  if (plain === null) {
    return tail
      ? { message: sentence, detail: tail, ...classified }
      : { message: sentence, ...classified };
  }
  const detail = [sentence, tail].filter(Boolean).join('\n');
  return { message: plain, detail, ...classified };
}
