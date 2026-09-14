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
  /** Kernel solid handles, empty when the file declared no solid roots. */
  solids: Uint32Array;
  report: StepImportReport;
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
