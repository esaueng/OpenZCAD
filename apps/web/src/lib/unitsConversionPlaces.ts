import type { DocumentNode, ProjectDocument } from '@openzcad/shared';
import { PRIMITIVE_FIELDS } from './primitiveFields';

/**
 * I03 review screen: where a refusal, warning or rewritten expression is, in
 * the words the workspace uses.
 *
 * The conversion names a place by its stored subject and field path:
 * `Box (ent_9d65…)` and `dimensions.height`. The reader knows neither the id
 * nor the key, and a box's `height` key is the size its editor calls
 * "Depth (Y)" (OCCT's makeBox puts it on Y), beside a separate
 * "Height (Z)". So:
 *
 * - a subject shows only its name; the id is kept for a name two different
 *   subjects on the same screen share, where it is the only tell;
 * - a field is named as the feature's own editor names it, where the
 *   editor has a label for it (primitive dimensions, a parameter's
 *   expression); any other field keeps its path.
 */

/** One place, as the conversion reports it. */
export interface ConversionPlace {
  subject: string;
  field?: string;
}

/** `configuration "Row": ` before an oracle subject checked on another row. */
const ROW_PREFIX = /^(configuration "[^"]*": )/;
/** `Name (id)`, the conversion's `subjectOf`. */
const NAMED_ID = /^(.*) \(([^()\s]+)\)$/;

const AREA_LABELS: Readonly<Record<string, string>> = {
  drawings: 'Drawing sheets',
  pmi: 'Model annotations (PMI)',
  assembly: 'Assembly',
  referenceImages: 'Reference images'
};

interface ParsedSubject {
  prefix: string;
  name: string;
  id?: string;
}

function parseSubject(
  subject: string,
  nodes: ProjectDocument['nodes'] | undefined
): ParsedSubject {
  const prefixMatch = ROW_PREFIX.exec(subject);
  const prefix = prefixMatch?.[1] ?? '';
  const rest = subject.slice(prefix.length);
  const named = NAMED_ID.exec(rest);
  if (named && (!nodes || nodes[named[2]!]))
    return { prefix, name: named[1]!, id: named[2]! };
  const node = nodes?.[rest];
  if (node) return { prefix, name: node.name || rest, id: rest };
  return { prefix, name: AREA_LABELS[rest] ?? rest };
}

/** The editor's label for `field` of `node`, when it has one. */
function fieldLabel(node: DocumentNode | undefined, field: string): string {
  if (node?.kind === 'feature' && node.data.featureKind === 'primitive') {
    const key = /^dimensions\.([^.]+)$/.exec(field)?.[1];
    const entry = PRIMITIVE_FIELDS[node.data.primitiveKind]?.find(
      (candidate) => candidate.key === key
    );
    if (entry) return entry.label;
  }
  if (node?.kind === 'parameter' && field === 'expression') return 'Expression';
  return field;
}

/**
 * Labels for every place on one screen. Ambiguity is judged across `items`
 * together, so a refusal and a rewrite naming two different "width"s both
 * keep their ids.
 */
export function conversionPlaceLabels(
  items: readonly ConversionPlace[],
  nodes: ProjectDocument['nodes'] | undefined
): {
  /** `Name · Field`, `Name`, `Field` or null for the document itself. */
  place(item: ConversionPlace): string | null;
  /** `message` with the stored subject replaced by its label. */
  message(item: ConversionPlace, message: string): string;
} {
  const idsByName = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.subject === 'document') continue;
    const parsed = parseSubject(item.subject, nodes);
    const key = `${parsed.prefix}${parsed.name}`;
    const ids = idsByName.get(key) ?? new Set<string>();
    ids.add(parsed.id ?? '');
    idsByName.set(key, ids);
  }
  const subjectLabel = (subject: string): string => {
    const parsed = parseSubject(subject, nodes);
    const key = `${parsed.prefix}${parsed.name}`;
    const ambiguous = (idsByName.get(key)?.size ?? 0) > 1;
    return parsed.id && ambiguous ? `${key} (${parsed.id})` : key;
  };
  return {
    place(item) {
      const subject =
        item.subject === 'document' ? null : subjectLabel(item.subject);
      const parsed =
        item.subject === 'document'
          ? undefined
          : parseSubject(item.subject, nodes);
      const field =
        item.field === undefined
          ? undefined
          : fieldLabel(parsed?.id ? nodes?.[parsed.id] : undefined, item.field);
      if (subject && field) return `${subject} · ${field}`;
      return subject ?? field ?? null;
    },
    message(item, message) {
      if (item.subject === 'document') return message;
      const label = subjectLabel(item.subject);
      return label === item.subject
        ? message
        : message.split(item.subject).join(label);
    }
  };
}
