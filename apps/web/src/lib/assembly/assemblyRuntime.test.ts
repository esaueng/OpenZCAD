import { afterEach, describe, expect, it } from 'vitest';
import type { AssemblyCouplingEnd, AssemblyPlacement } from '@openzcad/shared';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  registerAssemblyCommitHandlers,
  registerStudyPoseSink
} from './assemblyRuntime';

interface Commit {
  values: Record<string, number[]>;
  placements?: Record<string, AssemblyPlacement>;
  drivers?: readonly AssemblyCouplingEnd[];
}

function recordCommits(): Commit[] {
  const commits: Commit[] = [];
  registerAssemblyCommitHandlers({
    commitPose: (values, placements, drivers) =>
      commits.push({
        values,
        ...(placements ? { placements } : {}),
        drivers
      }),
    createJoint: () => undefined
  });
  return commits;
}

/** The player's pose: both joints turned, never to be saved. */
const PREVIEW_POSE = new Map([
  ['joint_a', [30]],
  ['joint_b', [40]]
]);

function preview(): number {
  const id = assemblyRuntime.startPreview();
  assemblyRuntime.showPreview(id, PREVIEW_POSE, [
    { jointId: 'joint_b', dof: 0 }
  ]);
  return id;
}

function shown() {
  return Object.fromEntries(getAssemblyRuntime().overrides);
}

function edits() {
  return Object.fromEntries(getAssemblyRuntime().editOverrides);
}

const PLACEMENT: AssemblyPlacement = {
  translation: { x: 1, y: 2, z: 3 },
  rotation: { x: 0, y: 0, z: 0, w: 1 }
};

afterEach(() => {
  registerAssemblyCommitHandlers(null);
  registerStudyPoseSink(null);
  assemblyRuntime.setActive(false);
  assemblyRuntime.reset();
});

describe('assembly runtime preview layer (AS06)', () => {
  it('keeps the preview in its own layer over the edit values', () => {
    assemblyRuntime.setActive(true);
    assemblyRuntime.setOverride('joint_a', [5], 0);
    const id = preview();
    expect(shown()).toEqual({ joint_a: [30], joint_b: [40] });
    expect(getAssemblyRuntime().drivers).toEqual([
      { jointId: 'joint_b', dof: 0 }
    ]);
    // The edit layer under it is untouched.
    expect(edits()).toEqual({ joint_a: [5] });
    expect(getAssemblyRuntime().editDrivers).toEqual([
      { jointId: 'joint_a', dof: 0 }
    ]);
    expect(getAssemblyRuntime().moved).toEqual([
      { jointId: 'joint_a', dof: 0 }
    ]);
    // Ending it discards exactly its layer.
    assemblyRuntime.endPreview(id);
    expect(getAssemblyRuntime().previewId).toBeNull();
    expect(shown()).toEqual({ joint_a: [5] });
    expect(edits()).toEqual({ joint_a: [5] });
  });

  it('starts a preview on what is shown, so nothing jumps', () => {
    assemblyRuntime.setActive(true);
    assemblyRuntime.setOverride('joint_a', [5], 0);
    const before = getAssemblyRuntime().overrides;
    assemblyRuntime.startPreview();
    expect(getAssemblyRuntime().overrides).toBe(before);
  });

  it('restores a cancelled drag from its saved base, ending the preview', () => {
    // The viewport's sequence: a drag starts from the edit layer, a second
    // finger scrubs the player, the drag is cancelled and put back.
    const commits = recordCommits();
    assemblyRuntime.setActive(true);
    const base = getAssemblyRuntime();
    assemblyRuntime.setOverride('joint_a', [12], 0);
    preview();
    assemblyRuntime.setOverrides(
      base.editOverrides,
      base.editDrivers,
      base.moved
    );
    expect(getAssemblyRuntime().previewId).toBeNull();
    expect(shown()).toEqual({});
    expect(edits()).toEqual({});
    // The next drag saves only what it moved.
    assemblyRuntime.setOverride('joint_a', [20], 0);
    assemblyRuntime.commitOverrides();
    expect(commits.map((c) => c.values)).toEqual([{ joint_a: [20] }]);
  });

  it('lets no commit path save a preview’s values', () => {
    const commits = recordCommits();
    assemblyRuntime.setActive(true);

    // 1. A commit with nothing edited under the preview saves nothing and
    // leaves the preview showing.
    preview();
    assemblyRuntime.commitOverrides();
    expect(commits).toEqual([]);
    expect(shown()).toEqual({ joint_a: [30], joint_b: [40] });

    // 2. An edit during the preview starts from rest and saves only itself.
    assemblyRuntime.setOverride('joint_a', [5], 0);
    assemblyRuntime.commitOverrides();
    expect(commits.at(-1)).toEqual({
      values: { joint_a: [5] },
      drivers: [{ jointId: 'joint_a', dof: 0 }]
    });

    // 3. Edit values a preview covers save without the preview's.
    assemblyRuntime.setOverride('joint_a', [7], 0);
    preview();
    assemblyRuntime.commitOverrides();
    expect(commits.at(-1)).toEqual({
      values: { joint_a: [7] },
      drivers: [{ jointId: 'joint_a', dof: 0 }]
    });
    expect(getAssemblyRuntime().previewId).toBeNull();

    // 4. Moving a free part during a preview saves the placement alone.
    preview();
    assemblyRuntime.setPlacementOverride('comp_free', PLACEMENT);
    expect(getAssemblyRuntime().previewId).toBeNull();
    assemblyRuntime.commitOverrides();
    expect(commits.at(-1)).toEqual({
      values: {},
      placements: { comp_free: PLACEMENT },
      drivers: []
    });

    // 5. An open motion study keys only the edit values.
    const keyed: Record<string, number[]>[] = [];
    registerStudyPoseSink((values) => {
      keyed.push(values);
      return true;
    });
    assemblyRuntime.selectStudy('study_x');
    preview();
    assemblyRuntime.commitOverrides();
    expect(keyed).toEqual([]);
    assemblyRuntime.setOverride('joint_b', [9], 0);
    assemblyRuntime.commitOverrides();
    expect(keyed).toEqual([{ joint_b: [9] }]);
    registerStudyPoseSink(null);
    assemblyRuntime.selectStudy(null);
    assemblyRuntime.clearOverrides();

    // 6. However a preview ends, none of its values stay behind to save.
    const ends: [string, () => void][] = [
      [
        'endPreview',
        () => assemblyRuntime.endPreview(getAssemblyRuntime().previewId!)
      ],
      ['clearOverrides', () => assemblyRuntime.clearOverrides()],
      ['stop', () => assemblyRuntime.stop()],
      ['reset', () => assemblyRuntime.reset()],
      ['setActive', () => assemblyRuntime.setActive(false)],
      ['openJointTool', () => assemblyRuntime.openJointTool()],
      [
        'setOverrides',
        () => assemblyRuntime.setOverrides(new Map([['joint_a', [1]]]))
      ],
      ['setOverride', () => assemblyRuntime.setOverride('joint_a', [2], 0)]
    ];
    for (const [name, end] of ends) {
      assemblyRuntime.setActive(true);
      preview();
      end();
      const runtime = getAssemblyRuntime();
      expect(runtime.previewId, name).toBeNull();
      expect(runtime.preview, name).toBeNull();
      for (const values of runtime.editOverrides.values())
        expect([[30], [40]], name).not.toContainEqual(values);
      expect(runtime.overrides, name).toBe(runtime.editOverrides);
      assemblyRuntime.closeJointTool();
      const before = commits.length;
      assemblyRuntime.commitOverrides();
      for (const commit of commits.slice(before))
        expect(Object.values(commit.values), name).not.toContainEqual([40]);
    }
  });
});
