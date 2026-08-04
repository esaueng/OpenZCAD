/**
 * K0.6: import validation and imported-body topology witnesses.
 *
 * Two things are pinned here that the parity corpus can only observe from the
 * outside — the taxonomy's decision table, and the adapter behaviour that
 * follows from it. The corpus proves BrepKit and OpenCascade agree; this proves
 * WHY they agree, so a change to the rule fails here with a readable message
 * rather than as a baseline diff.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type BodyRepresentation } from '@openzcad/shared';

import { BrepKitKernelAdapter } from '../packages/kernel-adapter/src/exact';
import {
  classifyImportedSolid,
  importedStepDroppedSolidWarning,
  importedStepNoSolidError,
  importedStepValidationWarning,
  type ImportedSolidDiagnosis
} from '../packages/kernel-adapter/src/imported-step-validation';
import { importedStepLineageName } from '../packages/kernel-adapter/src/topology-lineage';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(REPO_ROOT, 'test', 'parity', 'corpus');

/** A closed, manifold, strictly valid single-shell solid. */
const CLEAN: ImportedSolidDiagnosis = {
  index: 1,
  faceCount: 6,
  edgeCount: 12,
  openEdgeCount: 0,
  nonManifoldEdgeCount: 0,
  shellCount: 1,
  strictErrorCount: 0,
  relaxedErrorCount: 0
};

function importDocument(stepText: string, name: string) {
  const manager = new CommandManager(
    createProjectDocument(name, toUserId('user_k06'), 'mm')
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Imported',
      artifactId: `artifact_k06_${name}`,
      sourceName: name,
      stepText
    })
  );
  return manager.document;
}

function corpusStep(id: string): string {
  return readFileSync(join(CORPUS, `${id}.step`), 'utf8');
}

describe('imported STEP solid taxonomy', () => {
  it('accepts a closed manifold solid', () => {
    expect(classifyImportedSolid(CLEAN)).toEqual({ kind: 'solid' });
  });

  it('rejects an open shell and counts the boundary', () => {
    const verdict = classifyImportedSolid({
      ...CLEAN,
      faceCount: 5,
      openEdgeCount: 4,
      strictErrorCount: 2
    });
    expect(verdict.kind).toBe('not-a-solid');
    expect(verdict.kind === 'not-a-solid' && verdict.reason).toBe(
      'solid 1 (5 faces): it is an open shell — 4 of its 12 edges are used ' +
        'by a single face, so it encloses no volume'
    );
  });

  it('rejects a non-manifold shell', () => {
    const verdict = classifyImportedSolid({
      ...CLEAN,
      nonManifoldEdgeCount: 1
    });
    expect(verdict.kind).toBe('not-a-solid');
    expect(verdict.kind === 'not-a-solid' && verdict.reason).toContain(
      'it is non-manifold — 1 edge is shared by more than two faces'
    );
  });

  it('keeps a closed solid that fails strict validation, and flags it', () => {
    const verdict = classifyImportedSolid({ ...CLEAN, strictErrorCount: 3 });
    expect(verdict).toEqual({
      kind: 'flagged',
      reason: 'solid 1: 3 B-rep validity errors'
    });
  });

  /**
   * The measured false positive this rule exists to avoid: strict validation
   * runs an Euler-characteristic check that only holds for a single closed
   * shell, so every voided solid in the corpus reports one strict error while
   * being exactly what its file declares.
   */
  it('does not flag a voided solid for its Euler characteristic', () => {
    expect(
      classifyImportedSolid({
        ...CLEAN,
        shellCount: 2,
        strictErrorCount: 1,
        relaxedErrorCount: 0
      })
    ).toEqual({ kind: 'solid' });
  });

  it('still flags a voided solid that fails relaxed validation', () => {
    expect(
      classifyImportedSolid({
        ...CLEAN,
        shellCount: 2,
        strictErrorCount: 1,
        relaxedErrorCount: 1
      }).kind
    ).toBe('flagged');
  });

  it('names the defect when nothing survives the import', () => {
    expect(importedStepNoSolidError(['solid 1 (5 faces): it is an open shell']))
      .toBe(
        'STEP file contains no closed solids: solid 1 (5 faces): it is an ' +
          'open shell.'
      );
  });

  it('names the dropped solid when the rest of the file survives', () => {
    expect(
      importedStepDroppedSolidWarning('Imported', ['solid 2: open'], 3)
    ).toBe(
      'Body "Imported" imported, but 1 of its 3 STEP solids is not a closed ' +
        'solid and was dropped: solid 2: open.'
    );
  });

  it('reports the kernel that objected in the partial-success warning', () => {
    expect(importedStepValidationWarning('Part', 1, 1, 'BrepKit')).toContain(
      'but its STEP solid has BrepKit B-rep validity issues'
    );
  });
});

describe('BrepKit STEP import validation', () => {
  let adapter: BrepKitKernelAdapter;

  beforeAll(() => {
    adapter = new BrepKitKernelAdapter();
  });
  afterAll(() => {
    adapter.dispose();
  });

  /**
   * The headline case. `f-hostile-open-shell.step` is a 10 mm box with its
   * z-max face left out of the CLOSED_SHELL member list. It used to import as
   * a body of 666.67 mm³ — the divergence integral over the five faces it has
   * — with no warning at all.
   */
  it('refuses an open shell instead of importing a phantom volume', async () => {
    const derived = await adapter.syncDocument(
      importDocument(corpusStep('f-hostile-open-shell'), 'open-shell')
    );
    expect(derived.exportableBodyIds).toEqual([]);
    expect(derived.bodyRepresentations).toEqual({});
    expect(derived.warnings).toEqual([
      'Feature "Imported": STEP file contains no closed solids: solid 1 ' +
        '(5 faces): it is an open shell — 4 of its 12 edges are used by a ' +
        'single face, so it encloses no volume.'
    ]);
  });

  it('answers inspectStep for an open shell rather than calling it valid', async () => {
    const inspection = await adapter.inspectStep(
      corpusStep('f-hostile-open-shell')
    );
    expect(inspection.solid).toBe(false);
    expect(inspection.valid).toBe(false);
    expect(inspection.volume).toBe(0);
    expect(inspection.reason).toContain('it is an open shell');
  });

  /**
   * The probe is what the app calls to decide whether to offer an import at
   * all, so a thrown parse error is a worse SHAPE of answer than `false` even
   * when its text is better. Keep the text, in the value.
   */
  it('answers inspectStep for an unparseable file instead of throwing', async () => {
    const inspection = await adapter.inspectStep(
      corpusStep('f-hostile-dangling-reference')
    );
    expect(inspection).toMatchObject({
      solid: false,
      valid: false,
      volume: 0
    });
    expect(inspection.reason).toContain('#999999');
  });

  it('imports a closed solid with no validation warning', async () => {
    const derived = await adapter.syncDocument(
      importDocument(corpusStep('a-export-box'), 'box')
    );
    expect(derived.warnings).toEqual([]);
    expect(derived.exportableBodyIds).toHaveLength(1);
  });

  it('does not warn about a legitimately voided solid', async () => {
    const derived = await adapter.syncDocument(
      importDocument(corpusStep('c-void-single-cavity'), 'void')
    );
    expect(derived.warnings).toEqual([]);
  });
});

describe('imported STEP topology witnesses', () => {
  let adapter: BrepKitKernelAdapter;
  let box: BodyRepresentation;

  beforeAll(async () => {
    adapter = new BrepKitKernelAdapter();
    const derived = await adapter.syncDocument(
      importDocument(corpusStep('a-export-box'), 'witness-box')
    );
    box = Object.values(derived.bodyRepresentations)[0]!;
  });
  afterAll(() => {
    adapter.dispose();
  });

  it('publishes a schema-v5 reference on every face of an imported box', () => {
    const faces = box.topology?.faces ?? [];
    expect(faces).toHaveLength(6);
    for (const face of faces) {
      expect(face.reference?.kind).toBe('face');
      expect(face.reference?.witnessVersion).toBe(1);
    }
  });

  /**
   * ADR-013's integrity rule, applied to imports: recomputing the hash from
   * the stored witness must reproduce `currentHash`, and the name must be the
   * fingerprint rather than anything positional.
   */
  it('names imported topology by its own exact fingerprint', () => {
    for (const face of box.topology?.faces ?? []) {
      expect(face.reference?.currentHash).toBe(face.hash);
      expect(face.reference?.lineageName).toBe(
        importedStepLineageName('face', face.hash)
      );
    }
    for (const edge of box.topology?.edges ?? []) {
      expect(edge.reference?.currentHash).toBe(edge.hash);
      expect(edge.reference?.lineageName).toBe(
        importedStepLineageName('edge', edge.hash)
      );
    }
  });

  it('scopes every reference to the import feature that produced it', () => {
    const features = new Set(
      (box.topology?.faces ?? []).map(
        (face) => face.reference?.producingFeatureId
      )
    );
    expect(features.size).toBe(1);
    expect([...features][0]).toBeTruthy();
  });

  /**
   * Fail-closed, not best-effort: two faces with the same exact witness cannot
   * be told apart, so neither is named. A sphere exported by BrepKit is the
   * corpus case — its two hemispherical patches share a witness.
   */
  it('publishes no reference for topology it cannot name one-to-one', async () => {
    const derived = await adapter.syncDocument(
      importDocument(corpusStep('a-export-sphere'), 'witness-sphere')
    );
    const body = Object.values(derived.bodyRepresentations)[0]!;
    const faces = body.topology?.faces ?? [];
    const hashes = faces.map((face) => face.hash);
    for (const face of faces) {
      const unique = hashes.filter((hash) => hash === face.hash).length === 1;
      expect(face.reference !== undefined).toBe(unique);
    }
  });
});
