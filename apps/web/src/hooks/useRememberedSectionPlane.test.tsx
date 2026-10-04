import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SectionViewSettings } from '@openzcad/viewport';
import { useRememberedSectionPlane } from './useRememberedSectionPlane';

describe('useRememberedSectionPlane', () => {
  function render(initial: SectionViewSettings | undefined) {
    return renderHook(
      ({ sectionView }: { sectionView: SectionViewSettings | undefined }) =>
        useRememberedSectionPlane(sectionView),
      { initialProps: { sectionView: initial } }
    );
  }

  it('starts on XY with no section in this session', () => {
    expect(render(undefined).result.current.current).toBe('XY');
  });

  it('keeps the last live plane through the cut going off', () => {
    const hook = render(undefined);
    hook.rerender({ sectionView: { plane: 'YZ', offset: 2 } });
    hook.rerender({ sectionView: undefined });
    expect(hook.result.current.current).toBe('YZ');
  });

  it('follows a section restored from a project, not the last one picked', () => {
    // Review on #578: a project opened with a saved XZ cut, after YZ was
    // picked in another project, came back on YZ once toggled off and on.
    const hook = render({ plane: 'YZ', offset: 2 });
    hook.rerender({ sectionView: undefined });
    // The next project opens with its own saved cut…
    hook.rerender({ sectionView: { plane: 'XZ', offset: 4 } });
    // …which is switched off: its plane is the one that comes back.
    hook.rerender({ sectionView: undefined });
    expect(hook.result.current.current).toBe('XZ');
  });

  it('starts on the plane of a section that is live on mount', () => {
    expect(render({ plane: 'YZ', offset: 0 }).result.current.current).toBe(
      'YZ'
    );
  });
});
