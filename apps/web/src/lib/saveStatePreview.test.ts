import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_LIVE_OUTPUTS,
  SAVE_PREVIEW_ACCOUNT_REASON,
  SAVE_PREVIEW_EXPORT_REASON,
  SAVE_PREVIEW_MEASURE_REASON,
  SAVE_PREVIEW_SHARE_REASON,
  SAVE_PREVIEW_VIEW_REASON,
  previewLiveOutputRefusal,
  projectSectionView,
  savePreviewContextKey,
  viewportMeasurementAnnotations,
  viewportOverlayDocument,
  viewportSectionView,
  viewportStoredUnits,
  type PreviewLiveOutput
} from './saveStatePreview';

describe('save-state preview', () => {
  it('sizes the viewport by the previewed version’s stored unit (#2365)', () => {
    // A version saved before a mm → in conversion still stores millimetres.
    expect(viewportStoredUnits('inch', { document: { units: 'mm' } })).toBe(
      'mm'
    );
    expect(viewportStoredUnits('mm', { document: { units: 'inch' } })).toBe(
      'inch'
    );
    expect(viewportStoredUnits('inch', null)).toBe('inch');
  });

  it('draws none of the project’s pins over a previewed version (#2365)', () => {
    const pins = [{ id: 'kept-diameter' }, { id: 'kept-area' }];
    expect(viewportMeasurementAnnotations(pins, false)).toBe(pins);
    const hidden = viewportMeasurementAnnotations(pins, true);
    expect(hidden).toEqual([]);
    // One list across renders, so the viewer does not reinstall its labels.
    expect(viewportMeasurementAnnotations([{ id: 'other' }], true)).toBe(
      hidden
    );
  });

  it('says what does export or measure while a version is previewed', () => {
    // #2366, #2364: each refusal names both ways on — Close for the
    // project, Branch for the version on screen.
    for (const reason of [
      SAVE_PREVIEW_EXPORT_REASON,
      SAVE_PREVIEW_MEASURE_REASON,
      SAVE_PREVIEW_SHARE_REASON,
      SAVE_PREVIEW_ACCOUNT_REASON
    ]) {
      expect(reason).toMatch(/^A saved version is open for preview\. /);
      expect(reason).toMatch(/Close it to .+ the project/);
      expect(reason).toMatch(/branch it to .+ that version\.$/);
    }
  });

  it('cuts a version saved in another unit where the project’s cut is', () => {
    // The project stores inches; the version millimetres. A cut 1 in along
    // the project sits 25.4 mm along the version, and a cut moved to 10 mm
    // over the version is kept by the project as 10 mm, not 10 in.
    const live = { plane: 'XY' as const, offset: 1 };
    expect(viewportSectionView(live, 'inch', 'mm').offset).toBeCloseTo(25.4);
    expect(viewportSectionView(live, 'inch', 'inch')).toBe(live);
    const moved = { plane: 'XY' as const, offset: 10, flipped: true };
    const kept = projectSectionView(moved, 'inch', 'mm');
    expect(kept.offset).toBeCloseTo(10 / 25.4);
    expect(kept).toMatchObject({ plane: 'XY', flipped: true });
    expect(projectSectionView(moved, 'mm', 'mm')).toBe(moved);
  });
});

describe('the central preview gate (#2422)', () => {
  const outputs = Object.keys(PREVIEW_LIVE_OUTPUTS) as PreviewLiveOutput[];
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const sharing = readFileSync(
    resolve(__dirname, '../components/ProjectSharingDialog.tsx'),
    'utf8'
  );

  it('refuses every listed output while a version is previewed, and none otherwise', () => {
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) {
      expect(previewLiveOutputRefusal(false, output), output).toBeNull();
      const refusal = previewLiveOutputRefusal(true, output);
      expect(refusal, output).toMatch(
        /^A saved version is open for preview\. Close it to /
      );
    }
    expect(previewLiveOutputRefusal(true, 'export-step')).toBe(
      SAVE_PREVIEW_EXPORT_REASON
    );
    expect(previewLiveOutputRefusal(true, 'share-link')).toBe(
      SAVE_PREVIEW_SHARE_REASON
    );
    expect(previewLiveOutputRefusal(true, 'save-to-account')).toBe(
      SAVE_PREVIEW_ACCOUNT_REASON
    );
    expect(previewLiveOutputRefusal(true, 'saved-views')).toBe(
      SAVE_PREVIEW_VIEW_REASON
    );
  });

  it('is asked for every listed output, and words every refusal', () => {
    // Each output is asked of the gate by its name: by a handler, by the
    // shared export scope, or by the sharing dialog's action table.
    for (const output of outputs) {
      const asked = new RegExp(
        `(?:previewBlocksLiveOutput|previewLiveOutputReason|readyExportTarget)\\(\\s*'${output}'` +
          `|previewLiveOutputRefusal\\(\\s*savePreviewActive,\\s*'${output}'` +
          `|outputRefusal\\?\\.\\('${output}'\\)` +
          `|return '${output}';`
      );
      expect(asked.test(app) || asked.test(sharing), output).toBe(true);
    }
    // No caller refuses with wording of its own: a path that did would be
    // one the gate does not know about.
    for (const source of [app, sharing]) {
      expect(source).not.toMatch(
        /SAVE_PREVIEW_(?:EXPORT|SHARE|ACCOUNT|VIEW)_REASON/
      );
    }
    // The shared export scope asks for whichever output it is starting.
    expect(app).toMatch(
      /function readyExportTarget\(output: PreviewLiveOutput, rowId: string \| null\) \{\s+if \(previewBlocksLiveOutput\(output\)/
    );
  });

  it('gates every export, slicer and account-save handler of the workspace', () => {
    // Every handler of the workspace that writes a file, opens an export
    // or saves to the account, found by name. Each asks the gate, or is
    // listed here with why it may run over a previewed version. A new
    // handler in neither set fails this test.
    const readsTheVersionOrNoModel: Record<string, string> = {
      handleExportSectionDxf:
        'drawn from the viewport, which shows the version',
      handleExportViewportPng: 'a capture of the viewport, which shows it',
      openImageExport: 'opens the dialog; its sketch export asks the gate',
      handleExportProject: 'the complete backup, every save point included',
      handleExportDiagnostics: 'a sanitized support bundle, not a model file',
      handleExportInteractionLog: 'the interaction log, not a model file'
    };
    const handlers = [
      ...app.matchAll(
        /^ {2}(?:async )?function ((?:handle|open)\w*(?:Export|Slicer|FlatPattern|MeshQuality|SaveToAccount)\w*)\(/gm
      )
    ];
    const names = handlers.map((match) => match[1]!);
    expect(names).toEqual(
      expect.arrayContaining([
        'handleExportStep',
        'handleExportIges',
        'handleExportMesh',
        'handleOpenInSlicer',
        'handleExportCncLayout',
        'handleExportFaceDxf',
        'handleExportSketchSvg',
        'handleExportConfigurationRow',
        'handleCheckMeshQuality',
        'openMeshExport',
        'openFlatPattern',
        'handleSaveToAccount'
      ])
    );
    const ungated = handlers
      .filter((match) => {
        const body = app.slice(
          match.index,
          app.indexOf('\n  }\n', match.index)
        );
        return !/previewBlocksLiveOutput\(|previewLiveOutputReason\(|readyExportTarget\('/.test(
          body
        );
      })
      .map((match) => match[1]!);
    expect(ungated.sort()).toEqual(
      Object.keys(readsTheVersionOrNoModel).sort()
    );
  });

  it('ends a preview still building when the place it was asked from is left', () => {
    const asked = {
      projectId: 'project-1',
      workspaceMode: 'build',
      revisions: ['docked', null, false, null],
      tool: null as string | null,
      sketching: false,
      editing: false,
      measuring: false
    };
    const key = savePreviewContextKey(asked);
    expect(savePreviewContextKey({ ...asked })).toBe(key);
    const left: Partial<typeof asked>[] = [
      { projectId: 'project-2' },
      { workspaceMode: 'drawing' },
      // The Revisions panel closed, hidden with the others, or left on a
      // phone.
      { revisions: ['closed', null, false, null] },
      { revisions: ['docked', null, true, null] },
      { revisions: ['docked', null, false, 'history'] },
      { tool: 'fillet' },
      { sketching: true },
      { editing: true },
      { measuring: true }
    ];
    for (const change of left) {
      expect(
        savePreviewContextKey({ ...asked, ...change }),
        JSON.stringify(change)
      ).not.toBe(key);
    }
  });

  it('reads the viewport’s overlays from the document it draws', () => {
    const live = { name: 'project' };
    const version = { name: 'version' };
    expect(viewportOverlayDocument(live, { document: version })).toBe(version);
    expect(viewportOverlayDocument(live, null)).toBe(live);
  });
});
