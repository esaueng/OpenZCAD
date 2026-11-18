import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CommandManager, replayCommands } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createObjectFolder,
  assertImportedStepContentSchema,
  createProjectDocument,
  STEP_STRUCTURE_SCHEMA_VERSION,
  listObjectFolders,
  objectFolderOfBody,
  setNodeMetadata,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_COLOR_METADATA_KEY,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { buildDocumentHistory } from '../packages/kernel-adapter/src/exact-build-loop';
import {
  runStepImport,
  localStepImportSourceStore,
  type StepImportRunDeps
} from '../apps/web/src/lib/stepImportRun';
import { createInFlightImportChecksums } from '../apps/web/src/lib/importArchival';

/**
 * I02: STEP import keeps the file's product structure. The fixture was
 * written by an independent XCAF STEP writer: a 40 × 30 × 5 "Base plate"
 * and a geometry-free "Pin pair" sub-assembly of two R3 × 12 "Pin"s, placed
 * twice in "Fixture" (the second time turned 90° about Z), plate and pins
 * coloured. Its flat read is two unplaced solids; the bounds below are the
 * placed ones that writer's own reader reports.
 */
const ASSEMBLY = new Uint8Array(
  readFileSync(
    new URL('./fixtures/step/i02-nested-assembly.step', import.meta.url)
  )
);
const PLACED_BOUNDS: Record<string, number[][]> = {
  plate: [[0, 0, 0, 40, 30, 5]],
  pins: [
    [2, 2, 5, 8, 8, 17],
    [12, 2, 5, 18, 8, 17],
    [-8, 22, 5, -2, 28, 17],
    [-8, 32, 5, -2, 38, 17]
  ]
};

function sourceRef(bytes: Uint8Array) {
  return {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    logicalBytes: bytes.length
  } as const;
}

async function importThroughTheRun(
  adapter: ExactKernelAdapter,
  bytes: Uint8Array,
  fileName: string,
  initial: ProjectDocument
) {
  const manager = new CommandManager(initial);
  let status = '';
  const deps: StepImportRunDeps = {
    file: new File([Uint8Array.from(bytes)], fileName),
    contentType: 'model/step',
    inspectStructure: async () =>
      adapter.inspectStep(bytes.slice().buffer, { structure: true }),
    store: {
      ...localStepImportSourceStore,
      ensureLocalProjectStorage: async () => 'ready',
      putSourceBlobIfAbsent: async () => ({
        ref: sourceRef(bytes),
        created: true
      }),
      releaseSourceBlobClaim: async () => {}
    },
    archive: async () => 'artifact_structure',
    validatedFeature: {
      reserve: () => ({ release() {} }),
      run: async (command, options) => {
        const candidate = command.apply(manager.document);
        const derived = await adapter.syncDocument(candidate);
        expect(derived.warnings).toEqual([]);
        manager.execute(await options.finalize!());
        const message =
          typeof options.successMessage === 'function'
            ? options.successMessage()
            : options.successMessage;
        if (message) status = message;
        return 'committed';
      }
    },
    status: { setStatus() {}, setFeatureFormError() {} },
    marks: {
      inFlight: createInFlightImportChecksums(),
      abandoned: new Set()
    },
    currentDocument: () => manager.document,
    editDisabledReason: () => null,
    newId: () => crypto.randomUUID()
  };
  const result = await runStepImport(deps);
  expect(result.outcome).toBe('committed');
  return { manager, status };
}

function bodies(document: ProjectDocument) {
  return document.bodyOrder.map((bodyId) => {
    const node = Object.values(document.nodes).find(
      (entry) => entry.kind === 'body' && entry.bodyId === bodyId
    )!;
    const folderId = objectFolderOfBody(document, bodyId);
    const folder = listObjectFolders(document).find(
      (entry) => entry.id === folderId
    );
    return {
      bodyId,
      name: node.name,
      color: node.metadata?.[BODY_COLOR_METADATA_KEY] as string | undefined,
      folder: folder?.name ?? null
    };
  });
}

it('imports an independent assembly placed, named, coloured and filed in folders', async () => {
  const kernel = new RemusKernel();
  const adapter = await createExactKernelAdapter({
    resolveSourceBytes: async () => ASSEMBLY
  });
  const initial = createProjectDocument('Fixture import', toUserId('user_i02'));
  try {
    const { manager, status } = await importThroughTheRun(
      adapter,
      ASSEMBLY,
      'fixture.step',
      initial
    );
    expect(status).not.toContain('could not be read');
    const imported = bodies(manager.document);
    expect(imported.map((body) => body.name)).toEqual([
      'Base plate',
      'Pin',
      'Pin 2',
      'Pin 3',
      'Pin 4'
    ]);
    // The file's sRGB colours, as #rrggbb.
    expect(imported.map((body) => body.color)).toEqual([
      '#7caae7',
      '#f3bc59',
      '#f3bc59',
      '#f3bc59',
      '#f3bc59'
    ]);
    // Fixture holds the plate and two Pin pair folders of two pins each.
    expect(imported.map((body) => body.folder)).toEqual([
      'Fixture',
      'Pin pair',
      'Pin pair',
      'Pin pair',
      'Pin pair'
    ]);
    const folders = listObjectFolders(manager.document);
    const root = folders.find((folder) => folder.name === 'Fixture')!;
    expect(root.parentId).toBeNull();
    expect(
      folders
        .filter((folder) => folder.name === 'Pin pair')
        .map((f) => f.parentId)
    ).toEqual([root.id, root.id]);
    for (const node of Object.values(manager.document.nodes)) {
      if (node.kind === 'feature' && node.data.featureKind === 'imported-step')
        expect(node.data.stepReader).toBe('structure');
    }

    const ids = [...manager.document.bodyOrder] as BodyId[];
    const checksum = sourceRef(ASSEMBLY).checksumSha256;
    const verify = (document: ProjectDocument) => {
      const build = buildDocumentHistory(
        kernel,
        document,
        new Map([[checksum, ASSEMBLY]])
      );
      expect(build.warnings).toEqual([]);
      const expected = [...PLACED_BOUNDS.plate!, ...PLACED_BOUNDS.pins!];
      ids.forEach((bodyId, index) => {
        const solids = build.shapes.get(bodyId)!.solids;
        expect(solids).toHaveLength(1);
        const box = Array.from(kernel.boundingBox(solids[0]!));
        box.forEach((value, axis) =>
          expect(value).toBeCloseTo(expected[index]![axis]!, 6)
        );
      });
    };
    verify(manager.document);
    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);
    expect(listObjectFolders(manager.document)).toHaveLength(0);
    manager.redo();
    expect(bodies(manager.document)).toEqual(imported);
    verify(replayCommands(initial, manager.document.commandLog));
    const reopened = await adapter.syncDocument(
      structuredClone(manager.document)
    );
    expect(reopened.exportableBodyIds).toEqual(ids);
  } finally {
    adapter.dispose();
    kernel.free();
  }
}, 120_000);

it('round-trips OpenZCAD body names and colours through its own STEP', async () => {
  const adapter = await createExactKernelAdapter();
  try {
    let document = createProjectDocument('Bracket', toUserId('user_i02'));
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 10, depth: 5 }
    });
    document = addPrimitiveFeature(document, {
      name: 'Pin',
      primitiveKind: 'cylinder',
      dimensions: { radius: 5, height: 10 }
    });
    document = transformBody(document, {
      name: 'Move pin',
      targetBodyId: document.bodyOrder.at(-1)!,
      translation: { x: 40, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const pin = Object.values(document.nodes).find(
      (node) =>
        node.kind === 'body' && node.bodyId === document.bodyOrder.at(-1)
    )!;
    document = setNodeMetadata(document, {
      nodeId: pin.id,
      metadata: {
        [BODY_COLOR_METADATA_KEY]: '#12abef',
        [BODY_COLOR_CHOSEN_METADATA_KEY]: true
      }
    });
    const derived = await adapter.syncDocument(document);
    const exported = await adapter.exportStep({ ...document, derived }, [
      ...derived.exportableBodyIds
    ]);
    const names = [...derived.exportableBodyIds].map(
      (bodyId) => derived.bodyRepresentations[bodyId]!.name
    );
    const bytes = new TextEncoder().encode(exported);
    const sourceAdapter = await createExactKernelAdapter({
      resolveSourceBytes: async () => bytes
    });
    try {
      const { manager } = await importThroughTheRun(
        sourceAdapter,
        bytes,
        'Bracket.step',
        createProjectDocument('Receiver', toUserId('user_i02'))
      );
      const imported = bodies(manager.document);
      expect(imported.map((body) => body.name)).toEqual(names);
      expect(imported[1]!.color).toBe('#12abef');
      // One product, so no folder: the bodies stay at the top level.
      expect(imported.map((body) => body.folder)).toEqual([null, null]);
    } finally {
      sourceAdapter.dispose();
    }
  } finally {
    adapter.dispose();
  }
}, 120_000);

it('falls back to the flat reader, and says so, when the structure cannot be read', async () => {
  // Mapped-item assemblies are outside the structure reader's subset.
  const text = new TextDecoder().decode(ASSEMBLY);
  const at = text.lastIndexOf('ENDSEC;');
  const mapped = new TextEncoder().encode(
    `${text.slice(0, at)}#9001 = REPRESENTATION_MAP(#11,#40);\n#9002 = MAPPED_ITEM('',#9001,#15);\n${text.slice(at)}`
  );
  const adapter = await createExactKernelAdapter({
    resolveSourceBytes: async () => mapped
  });
  try {
    const { manager, status } = await importThroughTheRun(
      adapter,
      mapped,
      'mapped.step',
      createProjectDocument('Mapped', toUserId('user_i02'))
    );
    expect(manager.document.bodyOrder).toHaveLength(2);
    expect(status).toContain('assembly structure could not be read');
    for (const node of Object.values(manager.document.nodes)) {
      if (node.kind === 'feature' && node.data.featureKind === 'imported-step')
        expect(node.data.stepReader).toBeUndefined();
    }
  } finally {
    adapter.dispose();
  }
}, 120_000);

it('needs the structured-import schema to store a structured import', () => {
  const data = { featureKind: 'imported-step', stepReader: 'structure' };
  expect(() =>
    assertImportedStepContentSchema(data, PROJECT_DOCUMENT_SCHEMA_VERSION)
  ).not.toThrow();
  expect(() =>
    assertImportedStepContentSchema(data, STEP_STRUCTURE_SCHEMA_VERSION - 1)
  ).toThrow(
    `Structured STEP imports require project schema v${STEP_STRUCTURE_SCHEMA_VERSION}`
  );
  expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(
    STEP_STRUCTURE_SCHEMA_VERSION
  );
  expect(() =>
    assertImportedStepContentSchema({ featureKind: 'imported-step' }, 1)
  ).not.toThrow();
});

it('round-trips Objects folders as STEP assembly structure', async () => {
  const adapter = await createExactKernelAdapter();
  try {
    let document = createProjectDocument('Rig', toUserId('user_i02'));
    for (const [name, x] of [
      ['Plate', 0],
      ['Pin', 30],
      ['Spare pin', 60]
    ] as const) {
      document = addPrimitiveFeature(document, {
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
      document = transformBody(document, {
        name: `Move ${name}`,
        targetBodyId: document.bodyOrder.at(-1)!,
        translation: { x, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      }).document;
    }
    const [plate, pin, spare] = document.bodyOrder;
    document = createObjectFolder(document, {
      folderId: 'folder_fasteners',
      name: 'Fasteners',
      parentId: null,
      bodyIds: [pin!]
    });
    document = createObjectFolder(document, {
      folderId: 'folder_spares',
      name: 'Spares',
      parentId: 'folder_fasteners',
      bodyIds: [spare!]
    });
    const derived = await adapter.syncDocument(document);
    const ids = [...derived.exportableBodyIds];
    const exported = await adapter.exportStep({ ...document, derived }, ids);
    expect(exported).toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
    const names = new Map(
      ids.map((bodyId) => [bodyId, derived.bodyRepresentations[bodyId]!.name])
    );
    const bytes = new TextEncoder().encode(exported);
    const sourceAdapter = await createExactKernelAdapter({
      resolveSourceBytes: async () => bytes
    });
    try {
      const { manager } = await importThroughTheRun(
        sourceAdapter,
        bytes,
        'Rig.step',
        createProjectDocument('Receiver', toUserId('user_i02'))
      );
      const imported = new Map(
        bodies(manager.document).map((body) => [body.name, body.folder])
      );
      // The project's own folders, under one named after the project.
      expect(imported.get(names.get(plate!)!)).toBe('Rig');
      expect(imported.get(names.get(pin!)!)).toBe('Fasteners');
      expect(imported.get(names.get(spare!)!)).toBe('Spares');
      const folders = listObjectFolders(manager.document);
      const byName = new Map(folders.map((folder) => [folder.name, folder]));
      expect(byName.get('Rig')!.parentId).toBeNull();
      expect(byName.get('Fasteners')!.parentId).toBe(byName.get('Rig')!.id);
      expect(byName.get('Spares')!.parentId).toBe(byName.get('Fasteners')!.id);
      // Same geometry: the flat reader still reads the same three solids.
      const flat = await sourceAdapter.inspectStep(bytes.slice().buffer);
      expect(flat.solidIndices).toEqual([0, 1, 2]);
    } finally {
      sourceAdapter.dispose();
    }
  } finally {
    adapter.dispose();
  }
}, 120_000);
