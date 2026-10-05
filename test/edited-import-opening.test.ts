import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  growingHolderProposalTarget
} from '@openzcad/ai-contracts';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type RebuildProgress
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type DerivedState,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { drillHole } from '../packages/kernel-adapter/src/exact-cylinder-ops';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { syntheticHolderSolid } from './support/synthetic-holder';

/**
 * The opening is measured only where the growing-holder recipe can use it:
 * an import under at most fixed moves or rotations. A direct edit reshapes
 * the body, the recipe refuses to compile against it, and the measurement —
 * strict validations, slab intersections, a full face inventory — was a
 * fifth of an offset-face rebuild of the 160-face hammer holder. After the
 * edit the body publishes an unsupported opening with the reason and never
 * runs the recognizer, while imported-feature recognition still runs fresh,
 * because hole edits and the edit catalog bind to it on edited bodies.
 */

const selection = { featureIds: [], bodyIds: [], topologies: [] };

const stagesOf = (events: RebuildProgress[]) =>
  events
    .filter((event) => event.status === 'started')
    .map((event) => event.name.split(': ').at(-1));

describe(
  'imported-body recognition after a direct edit',
  { timeout: 300_000 },
  () => {
    let adapter: ExactKernelAdapter;
    let holder: ProjectDocument;
    let holderImportStages: RebuildProgress[];
    let plate: ProjectDocument;

    async function sync(document: ProjectDocument) {
      const events: RebuildProgress[] = [];
      const derived = await adapter.syncDocument(document, (event) =>
        events.push(event)
      );
      return { derived, events };
    }

    async function importSolid(
      name: string,
      build: (kernel: RemusKernel) => number
    ) {
      const kernel = new RemusKernel();
      let stepText: string;
      try {
        stepText = new TextDecoder().decode(
          remusTranslators().exportStep(
            kernel.serializeSolids(Uint32Array.of(build(kernel)))
          )
        );
      } finally {
        kernel.free();
      }
      const manager = new CommandManager(
        createProjectDocument(name, toUserId('user_edited_import'))
      );
      manager.execute(
        commandFactories.importStep({
          name,
          artifactId: name.toLowerCase(),
          sourceName: `${name.toLowerCase()}.step`,
          stepText
        })
      );
      const { derived, events } = await sync(manager.document);
      return {
        document: { ...manager.document, derived } as ProjectDocument,
        events
      };
    }

    /** Offsets the one planar face with this outward normal through `at`. */
    function offsetFace(
      base: ProjectDocument,
      normal: Vector3,
      at: Vector3,
      offset: number
    ) {
      const bodyId = base.bodyOrder[0]!;
      const face = base.derived.bodyRepresentations[
        bodyId
      ]!.topology!.faces.find(
        ({ geometry }) =>
          geometry?.surfaceType === 'plane' &&
          geometry.normal !== undefined &&
          geometry.planeOffset !== undefined &&
          geometry.normal.x * normal.x +
            geometry.normal.y * normal.y +
            geometry.normal.z * normal.z >
            1 - 1e-9 &&
          Math.abs(
            geometry.planeOffset -
              (normal.x * at.x + normal.y * at.y + normal.z * at.z)
          ) < 1e-6
      )!;
      const plan = planFaceOffset({
        document: base,
        bodyId,
        face,
        faceHash: face.hash,
        offset
      });
      expect(plan?.kind).toBe('direct-edit');
      return new CommandManager(base).runTransaction('Offset face', [
        plan!.command
      ]);
    }

    async function coldSync(document: ProjectDocument): Promise<DerivedState> {
      const fresh = await createExactKernelAdapter();
      try {
        return await fresh.syncDocument(document);
      } finally {
        fresh.dispose();
      }
    }

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
      await loadRemusTranslators();
      const imported = await importSolid('Holder', syntheticHolderSolid);
      holder = imported.document;
      holderImportStages = imported.events;
      // A blind Ø6 bore 8 deep into the top of a 40 × 30 × 20 plate: an
      // exactly proved hole the coordinated hole edits bind to.
      plate = (
        await importSolid('Plate', (kernel) =>
          drillHole(kernel, kernel.makeBox(40, 30, 20), {
            surfacePoint: { x: 20, y: 15, z: 20 },
            axis: { x: 0, y: 0, z: -1 },
            radius: 3,
            depth: 8,
            entryExtension: 0.2,
            exitExtension: 0,
            style: 'simple'
          })
        )
      ).document;
    }, 300_000);
    afterAll(() => adapter.dispose());

    it('measures the opening of the unmodified import', () => {
      const bodyId = holder.bodyOrder[0]!;
      expect(stagesOf(holderImportStages)).toContain('Opening recognition');
      expect(
        holder.derived.bodyRepresentations[bodyId]!.topology!.recognizedOpening
          ?.status
      ).toBe('recognized');
      expect(growingHolderProposalTarget(holder, selection)).not.toBeNull();
    });

    it('publishes an unsupported opening without running the recognizer after a direct edit', async () => {
      const bodyId = holder.bodyOrder[0]!;
      // The floor's underside: planar, and away from both bores.
      const edited = offsetFace(
        holder,
        { x: 0, y: -1, z: 0 },
        { x: 0, y: 0, z: 0 },
        2
      );
      const { derived, events } = await sync(edited);
      expect(derived.warnings).toEqual([]);
      const stages = stagesOf(events);
      expect(stages).not.toContain('Opening recognition');
      expect(stages).toContain('Imported feature recognition');

      const opening =
        derived.bodyRepresentations[bodyId]!.topology!.recognizedOpening;
      expect(opening?.status).toBe('unsupported');
      if (opening?.status === 'unsupported') {
        expect(opening.reason).toMatch(/fixed moves or rotations/);
      }
      expect(
        (await coldSync(edited)).bodyRepresentations[bodyId]!.topology!
          .recognizedOpening
      ).toEqual(opening);

      // The assistant reads the reason instead of a recipe that cannot
      // compile, and no verified suggestion targets the edited body.
      const document = { ...edited, derived };
      expect(growingHolderProposalTarget(document, selection)).toBeNull();
      expect(
        createCadDocumentDigest(document, selection).bodies?.find(
          (body) => body.bodyId === bodyId
        )?.topology?.recognizedOpening
      ).toEqual(opening);
    });

    it('measures the opening again once the edit is undone', async () => {
      const bodyId = holder.bodyOrder[0]!;
      const { derived, events } = await sync(holder);
      expect(stagesOf(events)).toContain('Opening recognition');
      expect(
        derived.bodyRepresentations[bodyId]!.topology!.recognizedOpening
      ).toEqual(
        holder.derived.bodyRepresentations[bodyId]!.topology!.recognizedOpening
      );
    });

    it('still measures an import under a fixed move', async () => {
      const bodyId = holder.bodyOrder[0]!;
      const moved = new CommandManager(holder);
      moved.execute(
        commandFactories.transformBody({
          name: 'Move',
          targetBodyId: bodyId,
          translation: { x: 5, y: 0, z: 0 }
        })
      );
      const { derived, events } = await sync(moved.document);
      expect(stagesOf(events)).toContain('Opening recognition');
      const opening =
        derived.bodyRepresentations[bodyId]!.topology!.recognizedOpening;
      expect(opening?.status).toBe('recognized');
      if (opening?.status === 'recognized') {
        expect(opening.opening.sourceOpening).toBe(44);
      }
    });

    it('still proves imported features fresh on the edited body', async () => {
      const bodyId = plate.bodyOrder[0]!;
      const before =
        plate.derived.bodyRepresentations[bodyId]!.topology!
          .recognizedImportedFeatures ?? [];
      expect(before.map((feature) => feature.kind)).toEqual([
        'blind-cylindrical-hole'
      ]);
      // The underside, away from the bore: the hole keeps its proof.
      const edited = offsetFace(
        plate,
        { x: 0, y: 0, z: -1 },
        { x: 0, y: 0, z: 0 },
        2
      );
      const { derived, events } = await sync(edited);
      expect(derived.warnings).toEqual([]);
      expect(stagesOf(events)).toContain('Imported feature recognition');
      const after =
        derived.bodyRepresentations[bodyId]!.topology!
          .recognizedImportedFeatures;
      expect(after).toEqual(
        (await coldSync(edited)).bodyRepresentations[bodyId]!.topology!
          .recognizedImportedFeatures
      );
      expect(after).toMatchObject([
        { kind: 'blind-cylindrical-hole', diameter: 6, depth: 8 }
      ]);
    });
  }
);
