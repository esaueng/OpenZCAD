import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  frozenShareDocumentProblem,
  importStepBody,
  isSharedWithoutHistory,
  listNodesByKind
} from '@openzcad/document-core';
import {
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_COLOR_METADATA_KEY,
  BODY_OPACITY_METADATA_KEY,
  toUserId,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';

import {
  freezeModelForSharing,
  type FrozenShareGeometry
} from './frozenShareModel';
import { saveShareLinkCopy } from './shareLinkCopy';

const SECRET = 'SECRET_HISTORY';

/** An owner's project: two bodies and a history that names them. */
function ownerProject(): ProjectDocument {
  let document = createProjectDocument('Bracket', toUserId('user_owner'));
  for (const name of [`${SECRET} plate`, `${SECRET} pin`]) {
    document = importStepBody(document, {
      name,
      artifactId: `artifact_local_${name.length}`,
      sourceName: `${SECRET}.step`,
      stepText: `ISO-10303-21; /* ${SECRET} source */`
    }).document;
  }
  const manager = new CommandManager(document);
  const [plate] = listNodesByKind(manager.document, 'body');
  manager.execute(
    commandFactories.setNodeMetadata(
      {
        nodeId: plate!.id,
        metadata: {
          [BODY_COLOR_METADATA_KEY]: '#ff0000',
          [BODY_COLOR_CHOSEN_METADATA_KEY]: true,
          [BODY_OPACITY_METADATA_KEY]: 0.4
        }
      },
      'Set appearance'
    )
  );
  return manager.document;
}

/** The geometry worker, writing one recognizable STEP per body. */
function geometry(
  document: ProjectDocument,
  options: { meshReference?: BodyId; hidden?: BodyId } = {}
) {
  const bodies = listNodesByKind(document, 'body')
    .filter((node) => node.bodyId !== options.hidden)
    .map((node, index) => ({
      bodyId: node.bodyId,
      name: `Body ${index + 1}`,
      ...(node.bodyId === options.meshReference
        ? { meshReference: true as const }
        : {})
    }));
  const exportModel = vi.fn(
    async (
      format: string,
      _document: ProjectDocument,
      bodyIds: BodyId[],
      _options?: { units?: string; fileName?: string }
    ) => ({
      type: 'export' as const,
      ok: true as const,
      requestId: 'r',
      format,
      text: `ISO-10303-21; exact solid of ${bodyIds.join(',')}`,
      warnings: []
    })
  );
  return {
    exportModel,
    api: {
      exportBodies: vi.fn(async () => bodies),
      exportModel
    } as unknown as FrozenShareGeometry
  };
}

describe('freezeModelForSharing', () => {
  it('writes each shown body on its own and keeps nothing of the history', async () => {
    const source = ownerProject();
    expect(JSON.stringify(source.commandLog)).toContain('Set appearance');
    const before = structuredClone(source);
    const { api, exportModel } = geometry(source);
    const frozen = await freezeModelForSharing(source, api);

    expect(frozenShareDocumentProblem(frozen)).toBeNull();
    expect(isSharedWithoutHistory(frozen)).toBe(true);
    expect(frozen.projectId).toBe(source.projectId);
    expect(frozen.name).toBe('Bracket');
    const features = listNodesByKind(frozen, 'feature');
    expect(features.map((node) => node.name)).toEqual(['Body 1', 'Body 2']);
    const ids = listNodesByKind(source, 'body').map((node) => node.bodyId);
    expect(
      features.map((node) => (node.data as { stepText?: string }).stepText)
    ).toEqual(ids.map((id) => `ISO-10303-21; exact solid of ${id}`));
    // One export per body, in millimetres, of that body alone.
    expect(exportModel.mock.calls.map((call) => call[2])).toEqual(
      ids.map((id) => [id])
    );
    expect(exportModel.mock.calls[0]![3]).toMatchObject({ units: 'mm' });
    // The chosen colour and opacity travel; nothing else of the owner's does.
    expect(listNodesByKind(frozen, 'body')[0]!.metadata).toMatchObject({
      [BODY_COLOR_METADATA_KEY]: '#ff0000',
      [BODY_OPACITY_METADATA_KEY]: 0.4
    });
    expect(frozen.parameterOrder).toEqual([]);
    expect(frozen.commandLog).toEqual([]);
    expect(frozen.revisions).toEqual([]);
    expect(JSON.stringify(frozen)).not.toContain(SECRET);
    // The owner's project is untouched.
    expect(source).toEqual(before);
  });

  it('leaves out a body the model hides and a mesh reference', async () => {
    const source = ownerProject();
    const [first, second] = listNodesByKind(source, 'body');
    const hidden = await freezeModelForSharing(
      source,
      geometry(source, { hidden: first!.bodyId }).api
    );
    expect(listNodesByKind(hidden, 'feature')).toHaveLength(1);
    const mesh = await freezeModelForSharing(
      source,
      geometry(source, { meshReference: second!.bodyId }).api
    );
    expect(listNodesByKind(mesh, 'feature')).toHaveLength(1);
  });

  it('refuses a model with no solid body', async () => {
    const empty = createProjectDocument('Empty', toUserId('user_owner'));
    await expect(
      freezeModelForSharing(empty, geometry(empty).api)
    ).rejects.toThrow(/no solid body to share/);
  });
});

describe('a copy of a link without history', () => {
  it('holds the frozen solids only, as an ordinary project', async () => {
    const source = ownerProject();
    const frozen = await freezeModelForSharing(source, geometry(source).api);
    const saved: ProjectDocument[] = [];
    const copy = await saveShareLinkCopy(
      frozen,
      'Bracket',
      toUserId('user_visitor'),
      async (document) => {
        saved.push(document);
      }
    );
    expect(saved).toEqual([copy]);
    expect(copy.projectId).not.toBe(source.projectId);
    expect(copy.ownerUserId).toBe('user_visitor');
    expect(isSharedWithoutHistory(copy)).toBe(false);
    expect(
      listNodesByKind(copy, 'feature').map((node) => node.featureKind)
    ).toEqual(['imported-step', 'imported-step']);
    expect(copy.parameterOrder).toEqual([]);
    expect(copy.sketchOrder).toEqual([]);
    // Its only save state is the copy's own.
    expect(copy.revisions).toHaveLength(1);
    expect(JSON.stringify(copy)).not.toContain(SECRET);
  });
});
