/**
 * What a refused STEP import owes the user, and what it must not leave behind.
 *
 * An import used to commit before any geometry ran, so an unparseable file
 * produced a success toast, a history row flagged "Feature failed to build",
 * no body, and a blank viewport. The import now goes through the same exact
 * pre-flight as every other feature: this pins the kernel's verdict (the text
 * the status bar has to carry unparaphrased), the refusal path through
 * `validatedFeatureRejection`, and the source-blob cleanup that a rejection
 * triggers.
 *
 * The hook-level atomicity assertions live in
 * `apps/web/src/hooks/useValidatedFeatureCommit.test.tsx`, which runs under the
 * app's own happy-dom config.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createProjectDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';

import {
  discardUnreferencedImportSource,
  importSourceChecksums
} from '../apps/web/src/lib/importArchival';
import {
  validatedFeatureRejection,
  warningForFeature
} from '../apps/web/src/lib/featureValidation';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(REPO_ROOT, 'test', 'parity', 'corpus');

function corpusStep(id: string): string {
  return readFileSync(join(CORPUS, `${id}.step`), 'utf8');
}

function referenceFor(text: string): ImportedSourceReference {
  const bytes = new TextEncoder().encode(text);
  return {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    logicalBytes: bytes.byteLength
  };
}

/** The candidate document the pre-flight rebuilds, ids pre-assigned. */
function importCandidate(
  featureName: string,
  payload: { stepText?: string; stepSourceRef?: ImportedSourceReference }
) {
  const ids = createBodyFeatureIds();
  const manager = new CommandManager(
    createProjectDocument('Import candidate', toUserId('user_step_rejection'))
  );
  const command = commandFactories.importStep({
    name: featureName,
    artifactId: 'artifact_local_preflight',
    sourceName: `${featureName}.step`,
    ids,
    ...payload
  });
  return { ids, document: command.apply(manager.document), command, manager };
}

describe('refused STEP import', () => {
  it('hands the status bar the kernel verdict, unparaphrased', async () => {
    // f-hostile-dangling-reference is a well-formed box whose z-max face
    // points at an entity id that does not exist, so the failure is in the
    // parser rather than in the geometry.
    const candidate = importCandidate('Frame', {
      stepText: corpusStep('f-hostile-dangling-reference')
    });
    const kernel = await createExactKernelAdapter();
    const derived = await kernel.syncDocument(candidate.document);

    expect(derived.bodyRepresentations[candidate.ids.bodyId]).toBeUndefined();
    expect(derived.warnings).toEqual([
      'Feature "Frame": parse error: entity #999999 not found'
    ]);
    // The prefix identifies the feature; the entity number is the part that
    // says which line of the file to look at, so nothing may truncate it.
    expect(warningForFeature('Frame', derived.warnings)).toBe(
      'parse error: entity #999999 not found'
    );
    expect(
      validatedFeatureRejection({
        featureName: 'Frame',
        warnings: derived.warnings,
        bodyPresent: Boolean(derived.bodyRepresentations[candidate.ids.bodyId]),
        documentMoved: false
      })
    ).toBe('parse error: entity #999999 not found');
  }, 60_000);

  it('names the missing body when the file parses but yields no solid', async () => {
    const candidate = importCandidate('Shell', {
      stepText: corpusStep('f-hostile-open-shell')
    });
    const kernel = await createExactKernelAdapter();
    const derived = await kernel.syncDocument(candidate.document);

    expect(derived.bodyRepresentations[candidate.ids.bodyId]).toBeUndefined();
    expect(
      validatedFeatureRejection({
        featureName: 'Shell',
        warnings: derived.warnings,
        bodyPresent: false,
        documentMoved: false
      })
    ).toContain('STEP file contains no closed solids');
  }, 60_000);

  it('accepts a good file with no warning and a body under the pre-assigned id', async () => {
    const candidate = importCandidate('Box', {
      stepText: corpusStep('a-export-box')
    });
    const kernel = await createExactKernelAdapter();
    const derived = await kernel.syncDocument(candidate.document);

    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[candidate.ids.bodyId]).toBeDefined();
    expect(
      validatedFeatureRejection({
        featureName: 'Box',
        warnings: derived.warnings,
        bodyPresent: true,
        documentMoved: false
      })
    ).toBeNull();
  }, 60_000);
});

/**
 * The import ORCHESTRATION — the order of the storage check, the commit lock,
 * the write — used to be asserted by reading `App.tsx`'s source text, because it
 * lived inline in a component no test renders. That is not coverage: independent
 * mutations of it left every suite green.
 *
 * It is now `runStepImport` in `apps/web/src/lib/stepImportRun.ts`, and
 * `apps/web/src/hooks/useValidatedFeatureCommit.test.tsx` runs the real thing
 * against a fake device. What is left here is the kernel's own verdict and the
 * pure cleanup decisions, which is what this file is for.
 */
describe('refused import source cleanup', () => {
  function documentReferencing(
    ...refs: ImportedSourceReference[]
  ): ProjectDocument {
    const manager = new CommandManager(
      createProjectDocument('Held sources', toUserId('user_step_rejection'))
    );
    refs.forEach((ref, index) => {
      manager.execute(
        commandFactories.importStep({
          name: `Held ${index}`,
          artifactId: `artifact_local_held_${index}`,
          sourceName: `held-${index}.step`,
          stepSourceRef: ref
        })
      );
    });
    return manager.document;
  }

  /** Everything a refusal is normally free to delete. */
  function discardable(ref: ImportedSourceReference) {
    return {
      checksumSha256: ref.checksumSha256,
      createdByThisImport: true,
      document: documentReferencing(),
      inFlightChecksums: new Set<string>()
    };
  }

  it('prunes the blob a rejected import wrote', async () => {
    const ref = referenceFor('ISO-10303-21; /* refused */');
    const deleteSourceBlob = vi.fn(() => Promise.resolve());

    await expect(
      discardUnreferencedImportSource({
        ...discardable(ref),
        deleteSourceBlob
      })
    ).resolves.toBe(true);
    expect(deleteSourceBlob).toHaveBeenCalledWith(ref.checksumSha256);
  });

  it('keeps a blob an existing feature still rebuilds from', async () => {
    // Storage is content-addressed, so re-importing a file the project already
    // holds lands on the SAME key. Deleting it would break the working
    // feature, which is the whole reason this is reference-counted.
    const shared = referenceFor('ISO-10303-21; /* already imported */');
    const deleteSourceBlob = vi.fn(() => Promise.resolve());

    await expect(
      discardUnreferencedImportSource({
        ...discardable(shared),
        document: documentReferencing(shared),
        deleteSourceBlob
      })
    ).resolves.toBe(false);
    expect(deleteSourceBlob).not.toHaveBeenCalled();
  });

  it('keeps a blob it did not create, whichever project holds it', async () => {
    // The blob store is device-global and keyed purely by checksum, so the
    // bytes a refused import in project Y wrote to may be the ones project X
    // rebuilds from — and X's document is not open to be counted against.
    // A blob that predates this import is never this import's to delete.
    const shared = referenceFor('ISO-10303-21; /* imported in project X */');
    const deleteSourceBlob = vi.fn(() => Promise.resolve());

    await expect(
      discardUnreferencedImportSource({
        ...discardable(shared),
        createdByThisImport: false,
        deleteSourceBlob
      })
    ).resolves.toBe(false);
    expect(deleteSourceBlob).not.toHaveBeenCalled();
  });

  it('keeps a blob another import is still validating against', async () => {
    // Two imports of the SAME file: the first is minutes into its rebuild, the
    // second is refused (or bounces off the commit lock). Content addressing
    // put both on one key, and the first is about to commit against it.
    const shared = referenceFor('ISO-10303-21; /* imported twice */');
    const deleteSourceBlob = vi.fn(() => Promise.resolve());

    await expect(
      discardUnreferencedImportSource({
        ...discardable(shared),
        inFlightChecksums: new Set([shared.checksumSha256]),
        deleteSourceBlob
      })
    ).resolves.toBe(false);
    expect(deleteSourceBlob).not.toHaveBeenCalled();
  });

  it('prunes a refused import whose bytes already reached the cloud archive', async () => {
    // The upload happens after acceptance but before the commit's own edit
    // check, so a permission flip can refuse the commit with the artifact
    // already written. That artifact is not a reason to keep the local copy:
    // no code path reads an unreferenced blob, so keeping it leaked up to
    // 250 MB *and* left the next import of the same file unable to clean up
    // after itself, having found a key it did not create.
    const ref = referenceFor('ISO-10303-21; /* archived, then refused */');
    const deleteSourceBlob = vi.fn(() => Promise.resolve());

    await expect(
      discardUnreferencedImportSource({
        ...discardable(ref),
        deleteSourceBlob
      })
    ).resolves.toBe(true);
    expect(deleteSourceBlob).toHaveBeenCalledWith(ref.checksumSha256);
  });

  it('reads every referenced checksum out of the document', () => {
    const first = referenceFor('ISO-10303-21; /* one */');
    const second = referenceFor('ISO-10303-21; /* two */');
    expect(importSourceChecksums(documentReferencing(first, second))).toEqual(
      new Set([first.checksumSha256, second.checksumSha256])
    );
    // Legacy embedded imports carry their text in the document and reference
    // no blob at all.
    const manager = new CommandManager(
      createProjectDocument('Embedded', toUserId('user_step_rejection'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Embedded',
        artifactId: 'artifact_local_embedded',
        sourceName: 'embedded.step',
        stepText: 'ISO-10303-21;'
      })
    );
    expect(importSourceChecksums(manager.document)).toEqual(new Set());
  });

  it('prunes when there is no document to count against', async () => {
    const ref = referenceFor('ISO-10303-21; /* project closed */');
    const deleteSourceBlob = vi.fn(() => Promise.resolve());
    await expect(
      discardUnreferencedImportSource({
        ...discardable(ref),
        document: null,
        deleteSourceBlob
      })
    ).resolves.toBe(true);
    expect(deleteSourceBlob).toHaveBeenCalledWith(ref.checksumSha256);
  });
});

/**
 * Rewrites every AXIS2_PLACEMENT_3D into the forms CATIA writes, omitting the
 * optional trailing references with `$`.
 *
 * The elision is semantics-preserving by construction: `ref_direction` only
 * sets the parametrisation origin of the surface or curve it places, and
 * `axis` is dropped only where it already equals the ISO 10303-42 default of
 * (0,0,1). So the imported body must match the untouched file's exactly.
 */
function elideOptionalPlacementReferences(stepText: string): {
  text: string;
  namedForm: number;
  bareForm: number;
} {
  const directions = new Map<string, readonly number[]>();
  for (const entity of stepText.matchAll(
    /#(\d+)\s*=\s*DIRECTION\('[^']*',\s*\(([^)]*)\)\)/g
  )) {
    directions.set(entity[1]!, entity[2]!.split(',').map(Number));
  }
  const isPlusZ = (id: string) => {
    const direction = directions.get(id);
    return (
      direction?.length === 3 &&
      Math.abs(direction[0]!) < 1e-12 &&
      Math.abs(direction[1]!) < 1e-12 &&
      Math.abs(direction[2]! - 1) < 1e-12
    );
  };
  let namedForm = 0;
  let bareForm = 0;
  const text = stepText.replace(
    /AXIS2_PLACEMENT_3D\('[^']*',\s*#(\d+),\s*#(\d+),\s*#(\d+)\)/g,
    (_whole, location: string, axis: string) => {
      if (isPlusZ(axis)) {
        bareForm += 1;
        return `AXIS2_PLACEMENT_3D('', #${location}, $, $)`;
      }
      namedForm += 1;
      return `AXIS2_PLACEMENT_3D('Circle Axis2P3D', #${location}, #${axis}, $)`;
    }
  );
  return { text, namedForm, bareForm };
}

/**
 * UNSKIP-ON-BREPKIT-PIN-BUMP.
 *
 * CATIA omits the optional `axis` and `ref_direction` of AXIS2_PLACEMENT_3D,
 * which the pinned BrepKit rejects outright:
 *
 *   parse error: AXIS2_PLACEMENT_3D #43 needs 3 sub-references
 *
 * Unskipped on 061c1b2, which contains the fix (brepkit #96, "read STEP
 * placement attributes by position").
 *
 * Note for the next person: the pin does NOT live in
 * packages/kernel-adapter/package.json, which floats on `#main`. It is the
 * resolved SHA in pnpm-lock.yaml, and that is what an update has to move.
 * This comment used to say package.json and sent one bump looking in the
 * wrong file.
 */
describe('CATIA optional AXIS2_PLACEMENT_3D references', () => {
  it('imports to a visible body with zero warnings', async () => {
    const source = corpusStep('a-export-cylinder');
    const elided = elideOptionalPlacementReferences(source);
    // Both CATIA forms the fix has to cover must actually be exercised.
    expect(elided.namedForm).toBeGreaterThan(0);
    expect(elided.bareForm).toBeGreaterThan(0);
    expect(elided.text).toContain("AXIS2_PLACEMENT_3D('Circle Axis2P3D',");
    expect(elided.text).toMatch(/AXIS2_PLACEMENT_3D\('', #\d+, \$, \$\)/);

    const kernel = await createExactKernelAdapter();
    const baseline = importCandidate('Baseline', { stepText: source });
    const baselineDerived = await kernel.syncDocument(baseline.document);
    const baselineBody =
      baselineDerived.bodyRepresentations[baseline.ids.bodyId];
    expect(baselineBody).toBeDefined();

    const catia = importCandidate('CATIA', { stepText: elided.text });
    const derived = await kernel.syncDocument(catia.document);

    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[catia.ids.bodyId];
    expect(body).toBeDefined();
    expect(body!.mesh.vertices.length).toBeGreaterThan(0);
    // The untouched file is the oracle: the elision changed no geometry.
    expect(body!.volume).toBeCloseTo(baselineBody!.volume, 9);
    expect(body!.faceCount).toBe(baselineBody!.faceCount);
  }, 60_000);
});
