/**
 * Import validation taxonomy for STEP bodies (K0.6).
 *
 * With OpenCascade deleted (Z5) there is no second reader to disagree with,
 * so whatever this layer lets through is what users get. A file that imports as a
 * body, measures a volume, and is geometrically meaningless is the exact
 * failure class the single-kernel programme exists to remove — so the bar here
 * is deliberately asymmetric: a false positive costs a warning, a false
 * negative costs a broken model.
 *
 * ---------------------------------------------------------------------------
 * What is measured, and why these signals and not others
 * ---------------------------------------------------------------------------
 *
 * The classifier consumes counts rather than kernel handles so both adapters
 * and the unit tests share one taxonomy. Three signals feed it, and the choice
 * between them was measured against the parity corpus rather than assumed:
 *
 *  - **Edge use counts**, read from the exact B-rep (`edgeToFaceMap` on
 *    Remus, ancestor faces on OpenCascade). A closed manifold shell uses
 *    every edge exactly twice. This is the "is it a solid at all" test, it is
 *    exact rather than tessellated, and it yields a countable reason a user can
 *    act on ("4 of its 12 edges are used by a single face").
 *
 *  - **The strict solid validator** (`validateSolid`, not
 *    `validateSolidRelaxed`) — but only on a solid with a single shell.
 *    Relaxed validation exists for booleans, fillets and shells, whose output
 *    is geometrically correct but not always fully manifold. An imported B-rep
 *    has no such excuse: it is what the file declares. The strict validator
 *    reports a count and no reason, so it flags a body rather than rejecting
 *    it.
 *
 *    The single-shell restriction is measured, not defensive. Strict validation
 *    includes an Euler-characteristic check, and `V - E + F = 2` holds for one
 *    closed shell, not for a solid carrying cavities. On the corpus every
 *    voided solid reports exactly one strict error and zero relaxed errors —
 *    `c-void-single-cavity` (2 shells), `c-void-two-cavities` (3 shells) and
 *    the voided half of `d-multi-solid-and-void` — while every single-shell
 *    body reports zero. Flagging those three would be three false warnings
 *    against files that are exactly what they claim to be, so a multi-shell
 *    solid is held to relaxed validation plus this module's own exact closure
 *    and manifoldness test, which does hold across shells.
 *
 *  - **`meshQuality` is deliberately NOT used as a validity gate.** It looked
 *    like the obvious closure test and it is wrong: on the corpus it reports
 *    `boundaryEdges: 50, isWatertight: false` for `a-export-cone`, a perfectly
 *    valid analytic cone, because independently tessellated faces do not weld
 *    at the apex. Gating on it would refuse valid supplier files — the one
 *    thing this layer must not do. Its Euler characteristic is equally unusable
 *    (0 on the shipped bracket sample).
 *
 * ---------------------------------------------------------------------------
 * Refuse or warn: the deliberate choice
 * ---------------------------------------------------------------------------
 *
 * A shell that is not closed is **rejected as geometry, per solid**, and never
 * becomes a body. A closed shell that merely fails strict validation is
 * **kept and flagged**, matching OpenCascade's long-standing partial-success
 * taxonomy. The split is where it is for four reasons:
 *
 *  1. An open shell has no volume. Importing it as a body publishes a number
 *     that does not exist (`f-hostile-open-shell` reads 666.67 mm³, the
 *     divergence integral over the five faces it happens to have) and every
 *     downstream boolean, blend and export then operates on it. There is no
 *     reading of that file under which the body is real.
 *  2. OpenZCAD ships no shell-healing workflow. "Import it so the user can heal
 *     it" would hand over a body that cannot be exported, cannot be modelled
 *     on, and reports a false measurement — worse product behaviour than a
 *     refusal that says exactly what is wrong.
 *  3. The refusal is specific, not generic. It names the defect and its size,
 *     so the user knows what to fix upstream. That is the "see and heal it"
 *     need served with information instead of with a broken body.
 *  4. `inspectStep` answers the same question *before* the user commits to the
 *     import, so the product already has the place to put a future
 *     "heal it anyway" affordance without weakening the import path.
 *
 * The rejection is per solid, not per file. A supplier file with twenty good
 * solids and one open shell imports the twenty and says loudly which one it
 * dropped; only a file where nothing survives fails outright. Silently dropping
 * an unreadable solid is the failure mode the corpus records as the worst in
 * its set, so the drop always carries a warning naming the solid.
 */

/** Per-solid measurement taken at the import boundary. */
export interface ImportedSolidDiagnosis {
  /** 1-based position in the file's solid list, for the message. */
  readonly index: number;
  readonly faceCount: number;
  readonly edgeCount: number;
  /** Edges used by fewer than two face sides: the shell has a boundary. */
  readonly openEdgeCount: number;
  /** Edges used by more than two face sides: the shell is non-manifold. */
  readonly nonManifoldEdgeCount: number;
  /** Outer shell plus one per enclosed cavity. */
  readonly shellCount: number;
  /** `validateSolid`: valid only as a bar for a single-shell solid. */
  readonly strictErrorCount: number;
  /** `validateSolidRelaxed`: the bar a voided solid is held to. */
  readonly relaxedErrorCount: number;
}

/**
 * The validator bar that applies to this solid. See the module header: strict
 * validation's Euler-characteristic check does not hold once a solid carries
 * cavities, so a multi-shell solid is measured by the relaxed validator and by
 * this module's own exact closure test instead.
 */
function applicableErrorCount(diagnosis: ImportedSolidDiagnosis): number {
  return diagnosis.shellCount === 1
    ? diagnosis.strictErrorCount
    : diagnosis.relaxedErrorCount;
}

export type ImportedSolidVerdict =
  /** A closed, manifold, strictly valid solid. */
  | { readonly kind: 'solid' }
  /** Closed and manifold, but the strict validator objects. Keep and warn. */
  | { readonly kind: 'flagged'; readonly reason: string }
  /** Not a closed manifold shell. Reject: it encloses no volume. */
  | { readonly kind: 'not-a-solid'; readonly reason: string };

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

/**
 * The single decision point. Closure and manifoldness are structural facts
 * about the shell and decide acceptance; the strict validator's remaining
 * complaints decide whether an accepted body is flagged.
 */
export function classifyImportedSolid(
  diagnosis: ImportedSolidDiagnosis
): ImportedSolidVerdict {
  const defects: string[] = [];
  if (diagnosis.openEdgeCount > 0) {
    defects.push(
      `it is an open shell — ${diagnosis.openEdgeCount} of its ` +
        `${diagnosis.edgeCount} ${plural(diagnosis.edgeCount, 'edge')} ` +
        `${diagnosis.openEdgeCount === 1 ? 'is' : 'are'} used by a single ` +
        'face, so it encloses no volume'
    );
  }
  if (diagnosis.nonManifoldEdgeCount > 0) {
    defects.push(
      `it is non-manifold — ${diagnosis.nonManifoldEdgeCount} ` +
        `${plural(diagnosis.nonManifoldEdgeCount, 'edge')} ` +
        `${diagnosis.nonManifoldEdgeCount === 1 ? 'is' : 'are'} shared by ` +
        'more than two faces'
    );
  }
  if (defects.length > 0) {
    return {
      kind: 'not-a-solid',
      reason: `solid ${diagnosis.index} (${diagnosis.faceCount} ${plural(
        diagnosis.faceCount,
        'face'
      )}): ${defects.join(', and ')}`
    };
  }
  const errorCount = applicableErrorCount(diagnosis);
  if (errorCount > 0) {
    return {
      kind: 'flagged',
      reason:
        `solid ${diagnosis.index}: ${errorCount} B-rep validity ` +
        plural(errorCount, 'error')
    };
  }
  return { kind: 'solid' };
}

/**
 * Every declared solid was rejected, so the import produces no body. Thrown
 * from the build so it reaches the user as a feature warning, in the same
 * `contains no solids` family as the empty-file message but naming the defect
 * instead of leaving the user to find it.
 */
export function importedStepNoSolidError(
  rejections: readonly string[]
): string {
  if (rejections.length === 0) {
    return 'STEP file contains no solids.';
  }
  return 'STEP file contains no closed solids: ' + rejections.join('; ') + '.';
}

/**
 * Some solids survived and some did not. The dropped ones are named: an
 * unreadable solid that vanishes without a warning is the worst failure mode
 * in the corpus, because the user gets a fraction of what they opened and
 * nothing says so.
 */
export function importedStepDroppedSolidWarning(
  bodyName: string,
  rejections: readonly string[],
  declaredSolidCount: number
): string {
  return (
    `Body "${bodyName}" imported, but ${rejections.length} of its ` +
    `${declaredSolidCount} STEP solids ${
      rejections.length === 1
        ? 'is not a closed solid and was'
        : 'are not closed solids and were'
    } dropped: ${rejections.join('; ')}.`
  );
}

/**
 * The `inspectStep` phrasing of a partial rejection: the probe runs before the
 * user commits, so it says what the import WILL drop rather than what it did.
 */
export function importedStepRejectedSolidSummary(
  rejections: readonly string[],
  declaredSolidCount: number
): string {
  return (
    `${rejections.length} of ${declaredSolidCount} STEP solids are not ` +
    `closed solids and will be dropped: ${rejections.join('; ')}.`
  );
}

/**
 * STEP import is intentionally tolerant: a kernel can still tessellate and
 * display a body when one of its solids fails strict validation. Make that
 * partial-success state explicit instead of describing a successful import as
 * a body failure.
 */
export function importedStepValidationWarning(
  bodyName: string,
  invalidSolidCount: number,
  solidCount: number,
  kernelName: string
): string {
  const affected =
    solidCount === 1
      ? 'its STEP solid'
      : `${invalidSolidCount} of its ${solidCount} STEP solids`;
  const subject = invalidSolidCount === 1 ? 'solid' : 'solids';
  const verb = invalidSolidCount === 1 ? 'has' : 'have';
  return (
    `Body "${bodyName}" imported and rendered, but ${affected} ` +
    `${verb} ${kernelName} B-rep validity issues. Exact edits or booleans involving ` +
    `the affected ${subject} may fail.`
  );
}
