/**
 * The STEP reader's typed report.
 *
 * `importStep` hands back bytes and nothing else, so everything the reader
 * observed about the file was thrown away at the boundary: how many roots it
 * found, whether the roots it dropped were sheets rather than solids, and what
 * bounded healing it had to do to produce them. A file holding only surface
 * bodies came out as "STEP file contains no solids", which is true and tells
 * the user nothing they can act on.
 *
 * `importStepWithReport` returns the same solid document plus a JSON report —
 * `solidCount`, `sheetCount`, `diagnostics` — and this module is the one place
 * that reads it.
 *
 * ## What this deliberately does NOT do
 *
 * There is no typed refusal for a STEP import on the pin. A file the reader
 * cannot parse, and a file over the hostile-input budget, both come back as a
 * bare `Error` carrying the reader's prose — measured: `parse error: entity
 * #999999 not found` and `import limit exceeded for input bytes: 8475 > 10`.
 * That is true of `importStep`, `importStepWithReport` and
 * `importStepBodies` alike. So the import family gets a typed REPORT and not
 * a typed refusal, and the existing text handling for those two messages
 * stays where it is, in `refusalLanguage` in the web app. Classifying them
 * here from their prefixes would be the same English matching this work
 * exists to remove, moved to a new address and dressed as a category.
 */
import { remusTranslators } from './remus-runtime';
import { kernelPayloadCount, readKernelPayload } from './kernel-refusal';

/**
 * Remus's hostile-input budgets for every source. A locally selected file can
 * later be shared or restored, so its origin does not make it trusted.
 */
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_ENTITIES = 2_000_000;

/** The same hostile-input budgets, for the other exact translators (IGES). */
export const EXACT_IMPORT_BUDGETS = {
  maxInputBytes: MAX_INPUT_BYTES,
  maxEntities: MAX_ENTITIES
} as const;

/** What the reader saw in the file, as data rather than as bytes. */
export interface StepImportReport {
  /** Solid roots the reader produced. */
  solidCount: number;
  /** Sheet (surface) roots the reader saw and this import does not adopt. */
  sheetCount: number;
  /**
   * Bounded-healing disclosures, in the reader's own words.
   *
   * Every file in the parity corpus reports an empty list on this pin, so the
   * ENTRY shape is unverified: entries are accepted as a plain string or as an
   * object with a string `message`, and anything else is counted and not
   * quoted. {@link StepImportReport.diagnosticCount} is the number the reader
   * actually gave, so a disclosure this adapter could not render still shows
   * up as one that happened.
   */
  diagnostics: readonly string[];
  diagnosticCount: number;
}

function readDiagnostics(payload: Record<string, unknown>): {
  diagnostics: string[];
  diagnosticCount: number;
} {
  const raw = payload['diagnostics'];
  if (!Array.isArray(raw)) {
    // The reader omitted the field. Absent is not the same as empty, but
    // there is nothing to report either way and this must not raise: the
    // import succeeded.
    return { diagnostics: [], diagnosticCount: 0 };
  }
  const diagnostics: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) {
      diagnostics.push(entry);
      continue;
    }
    const message =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['message']
        : undefined;
    if (typeof message === 'string' && message.length > 0) {
      diagnostics.push(message);
    }
  }
  return { diagnostics, diagnosticCount: raw.length };
}

export function readStepImportReport(raw: unknown): StepImportReport {
  const payload = readKernelPayload(raw, 'STEP import');
  return {
    solidCount: kernelPayloadCount(payload, 'solidCount', 'STEP import'),
    sheetCount: kernelPayloadCount(payload, 'sheetCount', 'STEP import'),
    ...readDiagnostics(payload)
  };
}

export interface StepImportOutcome {
  /** Exact arena bytes already produced by the translator, reusable without serialization. */
  document: Uint8Array;
  /** Kernel solid handles, empty when the file declared no solid roots. */
  solids: Uint32Array;
  report: StepImportReport;
}

/**
 * The imported-STEP cache key for a source: its checksum, qualified by the
 * reader that numbers its solids, so a structured and a flat import of the
 * same file never share a cached document (their solid orders differ).
 */
export function importedStepCacheKey(
  checksum: string,
  data: { stepReader?: 'structure' }
): string {
  return data.stepReader === 'structure' ? `${checksum}#structure` : checksum;
}

/** The kernel methods this module needs, so a test can supply a double. */
interface DeserializingKernel {
  deserializeSolids(document: Uint8Array): Uint32Array;
}

/**
 * Read a STEP file under the hostile-input budgets, keeping the report.
 *
 * The translator parses in its own scratch topology and hands back an arena
 * document; a file with no solids hands back no bytes, which is the empty
 * handle list rather than a document to restore. The `StepImportResult` owns
 * WASM memory, so it is released once its two payloads have been read.
 */
export function importStepWithOwnBudget(
  kernel: DeserializingKernel,
  bytes: Uint8Array
): StepImportOutcome {
  const result = remusTranslators().importStepWithReport(
    bytes,
    MAX_INPUT_BYTES,
    MAX_ENTITIES
  );
  let document: Uint8Array;
  let report: StepImportReport;
  try {
    document = result.solids;
    report = readStepImportReport(result.report);
  } finally {
    result.free();
  }
  return {
    document,
    solids:
      document.length === 0
        ? new Uint32Array()
        : kernel.deserializeSolids(document),
    report
  };
}

/**
 * Why a file produced no body, when the reader's report can say more than
 * "no solids".
 *
 * A file whose only roots are sheets is the case worth naming: the user
 * opened something real and OpenZCAD models solids, which is a different
 * story from an empty or irrelevant file and is one the reader can now tell.
 */
export function stepImportEmptyReason(report: StepImportReport): string {
  if (report.sheetCount > 0) {
    return (
      `STEP file contains no solids: its ${report.sheetCount} ` +
      `${report.sheetCount === 1 ? 'body is a surface' : 'bodies are surfaces'}` +
      ', which this exact modeler cannot adopt as a solid.'
    );
  }
  return 'STEP file contains no solids.';
}

/** One product occurrence of a structured STEP read (I02). */
export interface StepStructureNode {
  /** The product's name. */
  name: string;
  /** Index of the enclosing node; null for a root product. */
  parent: number | null;
}

/** What the structure reader says about one placed solid. */
export interface StepStructureSolid {
  /** Index of its product node; null for a solid no product reaches. */
  node: number | null;
  /** The solid's own B-rep name, when the file gives one. */
  name: string | null;
  /** Its surface colour, `#rrggbb`. */
  color: string | null;
  /** The one colour every face carries, when they all agree. */
  faceColor: string | null;
}

export interface StepStructure {
  nodes: StepStructureNode[];
  /** One entry per solid, in the order of the solid document. */
  solids: StepStructureSolid[];
}

export interface StepStructureImportOutcome extends StepImportOutcome {
  structure: StepStructure;
}

/** `[r, g, b]` sRGB in [0, 1] as `#rrggbb`, or null when it is not one. */
function hexColor(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const channels = raw.map((value) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
      ? Math.round(value * 255)
      : null
  );
  if (channels.some((value) => value === null)) return null;
  return `#${channels.map((value) => value!.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The structure part of `importStepStructure`'s report. Nodes and solids are
 * checked one by one: a parent that does not point at an earlier node, or a
 * solid list whose length disagrees with the solid count, refuses the whole
 * structure rather than filing bodies under the wrong product.
 */
export function readStepStructure(
  raw: unknown,
  solidCount: number
): StepStructure {
  const payload = readKernelPayload(raw, 'STEP structure import');
  const structure = payload['structure'];
  if (typeof structure !== 'object' || structure === null) {
    throw new Error('The STEP structure report has no structure.');
  }
  const record = structure as Record<string, unknown>;
  const rawNodes = Array.isArray(record['nodes']) ? record['nodes'] : [];
  const nodes: StepStructureNode[] = rawNodes.map((entry, index) => {
    const node = (entry ?? {}) as Record<string, unknown>;
    const parent = node['parent'];
    if (
      parent !== null &&
      !(
        Number.isInteger(parent) &&
        (parent as number) >= 0 &&
        (parent as number) < index
      )
    ) {
      throw new Error(`STEP structure node ${index} has an invalid parent.`);
    }
    return {
      name: typeof node['name'] === 'string' ? node['name'] : '',
      parent: parent as number | null
    };
  });
  const rawSolids = Array.isArray(record['solids']) ? record['solids'] : [];
  if (rawSolids.length !== solidCount) {
    throw new Error(
      `The STEP structure report describes ${rawSolids.length} solids for ${solidCount}.`
    );
  }
  const solids: StepStructureSolid[] = rawSolids.map((entry, index) => {
    const solid = (entry ?? {}) as Record<string, unknown>;
    const node = solid['node'];
    if (
      node !== null &&
      !(
        Number.isInteger(node) &&
        (node as number) >= 0 &&
        (node as number) < nodes.length
      )
    ) {
      throw new Error(`STEP structure solid ${index} names no node.`);
    }
    const name = solid['name'];
    return {
      node: node as number | null,
      name: typeof name === 'string' && name.trim() ? name : null,
      color: hexColor(solid['color']),
      faceColor: hexColor(solid['faceColor'])
    };
  });
  return { nodes, solids };
}

/**
 * Read a STEP file with its product structure (I02): every placed
 * occurrence is its own solid, in product-tree order, with its product node,
 * name and colour. Same budgets and document contract as
 * {@link importStepWithOwnBudget}; the solid order differs from it whenever
 * the file has an assembly.
 */
export function importStepStructureWithOwnBudget(
  kernel: DeserializingKernel,
  bytes: Uint8Array
): StepStructureImportOutcome {
  const result = remusTranslators().importStepStructure(
    bytes,
    MAX_INPUT_BYTES,
    MAX_ENTITIES
  );
  let document: Uint8Array;
  let report: StepImportReport;
  let structure: StepStructure;
  try {
    document = result.solids;
    report = readStepImportReport(result.report);
    structure = readStepStructure(result.report, report.solidCount);
  } finally {
    result.free();
  }
  return {
    document,
    solids:
      document.length === 0
        ? new Uint32Array()
        : kernel.deserializeSolids(document),
    report,
    structure
  };
}
