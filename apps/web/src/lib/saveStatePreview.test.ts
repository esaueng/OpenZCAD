import { describe, expect, it } from 'vitest';
import {
  SAVE_PREVIEW_EXPORT_REASON,
  SAVE_PREVIEW_MEASURE_REASON,
  SAVE_PREVIEW_SHARE_REASON,
  projectSectionView,
  viewportMeasurementAnnotations,
  viewportSectionView,
  viewportStoredUnits
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
      SAVE_PREVIEW_SHARE_REASON
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
