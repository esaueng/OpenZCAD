import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SectionViewSettings } from '@openzcad/viewport';
import { useRememberedSection } from './useRememberedSection';

describe('useRememberedSection', () => {
  function render(initial: SectionViewSettings | undefined) {
    return renderHook(
      ({ sectionView }: { sectionView: SectionViewSettings | undefined }) =>
        useRememberedSection(sectionView),
      { initialProps: { sectionView: initial } }
    );
  }

  it('has no remembered cut before one is enabled', () => {
    expect(render(undefined).result.current.current).toBeUndefined();
  });

  it('keeps the last live plane through the cut going off', () => {
    const hook = render(undefined);
    hook.rerender({ sectionView: { plane: 'YZ', offset: 2, flipped: true } });
    hook.rerender({ sectionView: undefined });
    expect(hook.result.current.current).toEqual({
      plane: 'YZ',
      offset: 2,
      flipped: true
    });
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
    expect(hook.result.current.current).toEqual({ plane: 'XZ', offset: 4 });
  });

  it('starts on the plane of a section that is live on mount', () => {
    expect(
      render({ plane: 'YZ', offset: 0, flipped: true }).result.current.current
    ).toEqual({ plane: 'YZ', offset: 0, flipped: true });
  });

  it('does not restore another project’s offset when the new project has no cut', () => {
    const hook = renderHook(
      ({
        projectId,
        sectionView
      }: {
        projectId: string;
        sectionView: SectionViewSettings | undefined;
      }) => useRememberedSection(sectionView, projectId),
      {
        initialProps: {
          projectId: 'first',
          sectionView: { plane: 'YZ', offset: 200, flipped: true } as
            SectionViewSettings | undefined
        }
      }
    );
    hook.rerender({ projectId: 'first', sectionView: undefined });
    expect(hook.result.current.current?.offset).toBe(200);
    hook.rerender({ projectId: 'second', sectionView: undefined });
    expect(hook.result.current.current).toBeUndefined();
  });
});
