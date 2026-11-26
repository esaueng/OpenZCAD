import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BottomSheet, useSheet } from './BottomSheet';
import {
  CLOSED_SHEET,
  SHEET_PEEK_PX,
  nearestDetent,
  sheetEscape,
  sheetReducer,
  type SheetAction,
  type SheetPage,
  type SheetState
} from './sheetState';

const page = (key: string, title = key): SheetPage => ({
  key,
  title,
  content: <button type="button">{`${title} item`}</button>
});

describe('sheet state', () => {
  const reduce = (
    state: SheetState,
    hasRoot: boolean,
    ...actions: SheetAction[]
  ) =>
    actions.reduce(
      (current, action) => sheetReducer(current, action, hasRoot),
      state
    );

  it('steps between the three heights and closes only when empty', () => {
    const half = reduce(CLOSED_SHEET, false, {
      type: 'push',
      page: page('more')
    });
    expect(half.detent).toBe('half');
    expect(reduce(half, false, { type: 'step-up' }).detent).toBe('full');
    expect(
      reduce(half, false, { type: 'step-up' }, { type: 'step-up' }).detent
    ).toBe('full');
    // With the workspace's content in it, the sheet stops at peek.
    const holding: SheetState = { detent: 'half', stack: [] };
    expect(reduce(holding, true, { type: 'step-down' }).detent).toBe('peek');
    expect(
      reduce(holding, true, { type: 'step-down' }, { type: 'step-down' }).detent
    ).toBe('peek');
    expect(reduce(holding, true, { type: 'close' }).detent).toBe('peek');
    expect(reduce(holding, false, { type: 'close' }).detent).toBe('closed');
    expect(
      reduce(holding, true, { type: 'set-detent', detent: 'closed' }).detent
    ).toBe('peek');
  });

  it('keeps a back stack for drill-in pages', () => {
    const drilled = reduce(
      CLOSED_SHEET,
      false,
      { type: 'push', page: page('more') },
      { type: 'push', page: page('file') }
    );
    expect(drilled.stack.map((entry) => entry.key)).toEqual(['more', 'file']);
    const back = reduce(drilled, false, { type: 'pop' });
    expect(back.stack.map((entry) => entry.key)).toEqual(['more']);
    expect(back.detent).toBe('half');
    // Popping the last page of a sheet with nothing under it closes it.
    expect(reduce(back, false, { type: 'pop' }).detent).toBe('closed');
    // Over the workspace's content, it goes back to that content.
    expect(reduce(back, true, { type: 'pop' })).toEqual({
      detent: 'half',
      stack: []
    });
    // Pushing a page already in the stack returns to it.
    expect(
      reduce(drilled, false, { type: 'push', page: page('more') }).stack.map(
        (entry) => entry.key
      )
    ).toEqual(['more']);
  });

  it('comes up for new content and leaves with it', () => {
    const arrived = reduce(CLOSED_SHEET, true, {
      type: 'root',
      present: true,
      arrived: true
    });
    expect(arrived.detent).toBe('half');
    const full: SheetState = { detent: 'full', stack: [] };
    expect(
      reduce(full, true, { type: 'root', present: true, arrived: true }).detent
    ).toBe('full');
    expect(
      reduce(arrived, false, { type: 'root', present: false, arrived: false })
        .detent
    ).toBe('closed');
    // A page pushed over the content stays when the content leaves.
    const paged: SheetState = { detent: 'half', stack: [page('more')] };
    expect(
      reduce(paged, false, { type: 'root', present: false, arrived: false })
    ).toBe(paged);
  });

  it('gives Escape to the sheet only where it steps back or down', () => {
    expect(sheetEscape(CLOSED_SHEET, false)).toBeNull();
    expect(sheetEscape({ detent: 'full', stack: [] }, true)?.detent).toBe(
      'half'
    );
    expect(
      sheetEscape({ detent: 'half', stack: [page('more')] }, true)?.stack
    ).toEqual([]);
    // Over a running tool at half, Escape is the tool's (it cancels).
    expect(sheetEscape({ detent: 'half', stack: [] }, true)).toBeNull();
    expect(sheetEscape({ detent: 'peek', stack: [] }, true)).toBeNull();
    // A sheet holding only its own pages steps down and closes.
    expect(sheetEscape({ detent: 'peek', stack: [] }, false)?.detent).toBe(
      'closed'
    );
  });

  it('snaps a drag to the nearest height', () => {
    expect(nearestDetent(SHEET_PEEK_PX + 10, 600, false)).toBe('peek');
    expect(nearestDetent(320, 600, false)).toBe('half');
    expect(nearestDetent(560, 600, false)).toBe('full');
    expect(nearestDetent(20, 600, true)).toBe('closed');
    expect(nearestDetent(20, 600, false)).toBe('peek');
  });
});

function Harness({
  hasRoot = false,
  initial = [],
  children,
  background
}: {
  hasRoot?: boolean;
  initial?: SheetAction[];
  children?: ReactNode;
  background?: () => Element[];
}) {
  const { state, dispatch } = useSheet(hasRoot);
  useEffect(() => {
    for (const action of initial) dispatch(action);
    // Once, as the sheet mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <button type="button">Outside</button>
      <BottomSheet
        label="Workspace sheet"
        state={state}
        dispatch={dispatch}
        hasRoot={hasRoot}
        background={background}
      >
        {children}
      </BottomSheet>
      <button
        type="button"
        onClick={() => dispatch({ type: 'push', page: page('more', 'More') })}
      >
        Open more
      </button>
    </>
  );
}

function sheet() {
  return document.querySelector<HTMLElement>('.compact-sheet')!;
}

describe('BottomSheet', () => {
  it('is hidden with nothing in it and has exactly one sheet', () => {
    render(<Harness />);
    expect(document.querySelectorAll('.compact-sheet')).toHaveLength(1);
    expect(sheet()).toHaveAttribute('hidden');
    expect(sheet().dataset.detent).toBe('closed');
  });

  it('changes height by keyboard and announces it', () => {
    render(
      <Harness hasRoot initial={[{ type: 'set-detent', detent: 'half' }]}>
        <p>Inspector</p>
      </Harness>
    );
    const grabber = screen.getByRole('slider', { name: 'Sheet height' });
    expect(grabber).toHaveAttribute('aria-valuetext', 'Half height');
    expect(screen.getByRole('status')).toHaveTextContent('Sheet half height');
    fireEvent.keyDown(grabber, { key: 'ArrowUp' });
    expect(sheet().dataset.detent).toBe('full');
    expect(grabber).toHaveAttribute('aria-valuetext', 'Full height');
    expect(screen.getByRole('status')).toHaveTextContent('Sheet full height');
    fireEvent.keyDown(grabber, { key: 'Home' });
    expect(sheet().dataset.detent).toBe('peek');
    fireEvent.keyDown(grabber, { key: 'ArrowDown' });
    expect(sheet().dataset.detent).toBe('peek');
    fireEvent.keyDown(grabber, { key: 'End' });
    expect(sheet().dataset.detent).toBe('full');
  });

  it('drills into pages, steps back with the Back button and Escape', () => {
    render(
      <Harness hasRoot initial={[{ type: 'set-detent', detent: 'half' }]}>
        <label>
          Width
          <input defaultValue="" />
        </label>
      </Harness>
    );
    const field = screen.getByLabelText('Width');
    fireEvent.change(field, { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open more' }));
    expect(screen.getByRole('heading', { name: 'More' })).toBeInTheDocument();
    // The workspace's form stays mounted under the page.
    expect(screen.getByLabelText('Width', { selector: 'input' })).toHaveValue(
      '42'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('heading', { name: 'More' })).toBeNull();
    expect(screen.getByLabelText('Width')).toHaveValue('42');

    fireEvent.click(screen.getByRole('button', { name: 'Open more' }));
    const item = screen.getByRole('button', { name: 'More item' });
    item.focus();
    const event = fireEvent.keyDown(item, { key: 'Escape' });
    expect(event).toBe(false);
    expect(screen.queryByRole('heading', { name: 'More' })).toBeNull();
  });

  it('lets Escape through to a running tool at half', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    render(
      <Harness hasRoot initial={[{ type: 'set-detent', detent: 'half' }]}>
        <button type="button">Done</button>
      </Harness>
    );
    const done = screen.getByRole('button', { name: 'Done' });
    fireEvent.keyDown(done, { key: 'Escape' });
    expect(sheet().dataset.detent).toBe('half');
    expect(onWindowKey).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', onWindowKey);
  });

  it('traps focus over an inert stage at full', () => {
    const stage = document.createElement('div');
    document.body.append(stage);
    render(
      <Harness
        hasRoot
        initial={[{ type: 'set-detent', detent: 'full' }]}
        background={() => [stage]}
      >
        <button type="button">First</button>
        <button type="button">Last</button>
      </Harness>
    );
    expect(stage).toHaveAttribute('inert');
    expect(sheet()).toHaveAttribute('role', 'dialog');
    // Focus moved into the sheet as it rose.
    expect(sheet()).toContainElement(document.activeElement as HTMLElement);

    const close = screen.getByRole('button', { name: 'Close sheet' });
    const last = screen.getByRole('button', { name: 'Last' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    // Wrapped round to the sheet's first control, the grabber.
    expect(document.activeElement).toBe(
      screen.getByRole('slider', { name: 'Sheet height' })
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(close).toBeInTheDocument();

    // Escape steps down from full, and the stage is live again.
    act(() => {
      fireEvent.keyDown(last, { key: 'Escape' });
    });
    expect(sheet().dataset.detent).toBe('half');
    expect(stage).not.toHaveAttribute('inert');
    stage.remove();
  });
});
