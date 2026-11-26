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

const page = (key: string): SheetPage => ({ key });

/** Each harness page: a title and one button, drawn from its key. */
const renderPage = (key: string) => {
  const title = key.charAt(0).toUpperCase() + key.slice(1);
  return {
    title,
    content: <button type="button">{`${title} item`}</button>
  };
};

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
    // Over the workspace's content, it goes back to that content, at the
    // height the content stood at before the first page (here none: peek,
    // the least the content needs).
    expect(reduce(back, true, { type: 'pop' })).toEqual({
      detent: 'peek',
      stack: []
    });
    // Pushing a page already in the stack returns to it.
    expect(
      reduce(drilled, false, { type: 'push', page: page('more') }).stack.map(
        (entry) => entry.key
      )
    ).toEqual(['more']);
  });

  it('goes back to the height the root had when its first page goes', () => {
    // All tools opened from the tray at peek comes up full, a modal over an
    // inert stage; Back or Escape returns the tray to peek, the stage live.
    const tray: SheetState = { detent: 'peek', stack: [] };
    const allTools = reduce(tray, true, {
      type: 'push',
      page: page('all-tools'),
      detent: 'full'
    });
    expect(allTools.detent).toBe('full');
    expect(reduce(allTools, true, { type: 'pop' })).toEqual(tray);
    expect(reduce(allTools, true, { type: 'step-down' })).toEqual(tray);
    expect(sheetEscape(allTools, true)).toEqual(tray);
    // Through a drill-in, the first page's root height is the one kept.
    const drilled = reduce(
      { detent: 'half', stack: [] },
      true,
      { type: 'push', page: page('more') },
      { type: 'set-detent', detent: 'full' },
      { type: 'push', page: page('file') }
    );
    expect(reduce(drilled, true, { type: 'pop' }).detent).toBe('full');
    expect(reduce(drilled, true, { type: 'pop' }, { type: 'pop' })).toEqual({
      detent: 'half',
      stack: []
    });
    // Content that arrived under the page comes back at its own height.
    const arrivedUnder = reduce(
      allTools,
      true,
      { type: 'root', present: true, arrived: true, at: 'half' },
      { type: 'pop' }
    );
    expect(arrivedUnder.detent).toBe('half');
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

  it('snaps a side sheet between peek and its full-height half only', () => {
    expect(nearestDetent(250, 280, false, true)).toBe('half');
    expect(nearestDetent(280, 280, false, true)).toBe('half');
    expect(nearestDetent(SHEET_PEEK_PX + 20, 280, false, true)).toBe('peek');
  });

  it("brings a running tool's row up at peek and other content at half", () => {
    const row = reduce(CLOSED_SHEET, true, {
      type: 'root',
      present: true,
      arrived: true,
      at: 'peek'
    });
    expect(row.detent).toBe('peek');
    expect(
      reduce(CLOSED_SHEET, true, {
        type: 'root',
        present: true,
        arrived: true
      }).detent
    ).toBe('half');
    // Raised higher by hand, new content leaves it there.
    expect(
      reduce({ detent: 'full', stack: [] }, true, {
        type: 'root',
        present: true,
        arrived: true,
        at: 'peek'
      }).detent
    ).toBe('full');
  });

  it('raises for Options or the keypad, never lowers', () => {
    const peek: SheetState = { detent: 'peek', stack: [] };
    expect(reduce(peek, true, { type: 'raise', detent: 'half' }).detent).toBe(
      'half'
    );
    const full: SheetState = { detent: 'full', stack: [] };
    expect(reduce(full, true, { type: 'raise', detent: 'half' })).toBe(full);
    // A sheet with nothing in it does not open for a stray request.
    expect(reduce(CLOSED_SHEET, false, { type: 'raise', detent: 'half' })).toBe(
      CLOSED_SHEET
    );
  });

  it('settles back to the tray once a tool leaves, unless a page is open', () => {
    expect(
      reduce({ detent: 'half', stack: [] }, true, { type: 'settle' }).detent
    ).toBe('peek');
    const paged: SheetState = {
      detent: 'full',
      stack: [page('more')],
      rootDetent: 'half'
    };
    const settled = reduce(paged, true, { type: 'settle' });
    expect(settled.detent).toBe('full');
    expect(settled.stack).toBe(paged.stack);
    // The tool left under the page: the tray comes back at peek after it.
    expect(reduce(settled, true, { type: 'pop' })).toEqual({
      detent: 'peek',
      stack: []
    });
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
        renderPage={renderPage}
        background={background}
      >
        {children}
      </BottomSheet>
      <button
        type="button"
        onClick={() => dispatch({ type: 'push', page: page('more') })}
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

  it('takes Escape for an open page wherever focus is', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    render(
      <Harness hasRoot initial={[{ type: 'set-detent', detent: 'half' }]}>
        <button type="button">Done</button>
      </Harness>
    );
    const opener = screen.getByRole('button', { name: 'Open more' });
    opener.focus();
    fireEvent.click(opener);
    // Opening the page moves focus into it.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'More item' })
    );
    // Focus back outside the sheet (the header's More, say): Escape still
    // steps the page back and never reaches the workspace behind it.
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'More' })).toBeNull();
    expect(onWindowKey).not.toHaveBeenCalled();
    // With the page gone, Escape is the running tool's again.
    fireEvent.keyDown(outside, { key: 'Escape' });
    expect(onWindowKey).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', onWindowKey);
  });

  it('gives focus back to what opened a page as it goes', () => {
    function Drill() {
      const { state, dispatch } = useSheet(false);
      return (
        <>
          <button
            type="button"
            onClick={() => dispatch({ type: 'push', page: page('more') })}
          >
            Open more
          </button>
          <BottomSheet
            label="Workspace sheet"
            state={state}
            dispatch={dispatch}
            hasRoot={false}
            renderPage={(key) =>
              key === 'more'
                ? {
                    title: 'More',
                    content: (
                      <button
                        type="button"
                        data-sheet-row="file"
                        onClick={() =>
                          dispatch({ type: 'push', page: page('file') })
                        }
                      >
                        File
                      </button>
                    )
                  }
                : {
                    title: 'File',
                    content: <button type="button">Export STEP</button>
                  }
            }
          />
        </>
      );
    }
    render(<Drill />);
    const opener = screen.getByRole('button', { name: 'Open more' });
    opener.focus();
    fireEvent.click(opener);
    const file = screen.getByRole('button', { name: 'File' });
    file.focus();
    fireEvent.click(file);
    const action = screen.getByRole('button', { name: 'Export STEP' });
    expect(document.activeElement).toBe(action);
    // Back from File: the action is gone, and focus lands on the row that
    // opened it, drawn anew on the page below, not on the body.
    fireEvent.keyDown(action, { key: 'Escape' });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'File' })
    );
    // Back from More, which closes the sheet: focus returns to its opener.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(sheet()).toHaveAttribute('hidden');
    expect(document.activeElement).toBe(opener);
  });

  it('gives focus back to an opener under a full sheet once it is live', () => {
    function Header() {
      const { state, dispatch } = useSheet(false);
      return (
        <>
          <header className="compact-header">
            <button
              type="button"
              onClick={() => dispatch({ type: 'push', page: page('more') })}
            >
              More
            </button>
          </header>
          <BottomSheet
            label="Workspace sheet"
            state={state}
            dispatch={dispatch}
            hasRoot={false}
            renderPage={renderPage}
            background={() => [document.querySelector('.compact-header')]}
          />
        </>
      );
    }
    render(<Header />);
    const more = screen.getByRole('button', { name: 'More' });
    more.focus();
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Sheet height' }), {
      key: 'ArrowUp'
    });
    expect(sheet().dataset.detent).toBe('full');
    const header = document.querySelector('.compact-header')!;
    expect(header).toHaveAttribute('inert');
    // The last page leaves from full: the sheet closes, the header is live
    // again, and focus is back on More rather than dropped on the body.
    const item = screen.getByRole('button', { name: 'More item' });
    item.focus();
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(sheet()).toHaveAttribute('hidden');
    expect(header).not.toHaveAttribute('inert');
    expect(document.activeElement).toBe(more);
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

  it('leaves controls that are not drawn out of the trap', () => {
    render(
      <Harness hasRoot initial={[{ type: 'set-detent', detent: 'full' }]}>
        <button type="button">Done</button>
        {/* A tool's Options left closed, and other controls not drawn. */}
        <details>
          <summary>Box options</summary>
          <input aria-label="Width" />
        </details>
        <input aria-label="Folded away" style={{ display: 'none' }} />
        <div style={{ display: 'none' }}>
          <button type="button">Under a hidden box</button>
        </div>
        <button type="button" style={{ visibility: 'hidden' }}>
          Invisible
        </button>
      </Harness>
    );
    const grabber = screen.getByRole('slider', { name: 'Sheet height' });
    const summary = screen.getByText('Box options');
    // Shift+Tab on the sheet's first control goes round to the last one
    // drawn: the closed Options' summary, not the Width field inside.
    grabber.focus();
    fireEvent.keyDown(grabber, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(summary);
    // And Tab from there wraps back to the first.
    fireEvent.keyDown(summary, { key: 'Tab' });
    expect(document.activeElement).toBe(grabber);
    // Opened, the Options' field is the last stop.
    act(() => {
      (summary.parentElement as HTMLDetailsElement).open = true;
    });
    grabber.focus();
    fireEvent.keyDown(grabber, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Width' })
    );
  });
});
