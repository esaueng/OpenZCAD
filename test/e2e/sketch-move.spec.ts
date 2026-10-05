import { type Locator, type Page } from '@playwright/test';
import {
  bareCanvasDrags,
  expect,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * Sketch objects move by dragging their grab point: a circle by its centre,
 * text by its baseline origin, with the same snaps a new point gets. The
 * release commits through the entity editor's own path, so the editor's
 * fields are the stored values these tests read; Escape mid-drag drops the
 * drag and nothing else.
 */

const CIRCLE_DRAG_PX = 30;

async function openTopSketch(page: Page, name: string) {
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(page.locator('.sketch-rail')).toBeVisible();
  await waitForStillViewport(page);
  return page.getByRole('toolbar', { name: 'Sketch tools' });
}

/**
 * Draws one circle per slot. The rail button flips before the viewport owns
 * the tool; the adaptive grid readout is written from the render pass that
 * has the sketch rig, so a gesture made after it lands on the plane.
 */
async function drawCircles(
  page: Page,
  sketchTools: Locator,
  centers: readonly { x: number; y: number }[]
) {
  const circleTool = sketchTools.getByRole('button', { name: /^Circle/ });
  const gridReadout = page.locator('.viewport-dock-grid');
  for (const [index, center] of centers.entries()) {
    await circleTool.click();
    await expect(circleTool).toHaveAttribute('aria-pressed', 'true');
    await expect(gridReadout).toBeVisible();
    await expect(gridReadout).not.toHaveText('');
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + CIRCLE_DRAG_PX, center.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByRole('contentinfo')).toContainText(
      index === 0 ? 'Sketch 01 started.' : 'Added circle.'
    );
  }
  await sketchTools.getByRole('button', { name: /^Select/ }).click();
}

/** Selects a circle by its rim and returns its stored centre. */
async function selectCircle(page: Page, center: { x: number; y: number }) {
  await page.mouse.click(center.x + CIRCLE_DRAG_PX, center.y);
  const editor = page.getByRole('form', { name: 'Edit circle' });
  await expect(editor).toBeVisible();
  return {
    editor,
    x: await editor.getByLabel('Center X').inputValue(),
    y: await editor.getByLabel('Center Y').inputValue()
  };
}

/**
 * Where the selected object's grab dot is drawn. The dot is placed by the
 * render loop, so waiting for it proves a frame with the selection was drawn
 * — a plain timeout would prove nothing.
 */
async function grabHandleCenter(page: Page) {
  const handle = page.locator('.sketch-grab-handle');
  await expect(handle).toBeVisible();
  // The view can still be moving after a selection lands, so read the
  // handle once the loop is still.
  await waitForStillViewport(page);
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

test('dragging a circle by its centre snaps it onto another centre', async ({
  page
}) => {
  test.setTimeout(90_000);
  const sketchTools = await openTopSketch(page, 'Sketch Move Circle');
  const [first, second] = await bareCanvasDrags(page, {
    count: 2,
    dragX: CIRCLE_DRAG_PX
  });
  await drawCircles(page, sketchTools, [first!, second!]);

  const target = await selectCircle(page, second!);
  const moved = await selectCircle(page, first!);
  expect(`${moved.x},${moved.y}`).not.toBe(`${target.x},${target.y}`);

  const handle = await grabHandleCenter(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  // A few pixels short of the other centre: the snap, not the pointer,
  // decides where the centre lands.
  await page.mouse.move(second!.x + 3, second!.y - 2, { steps: 12 });
  await expect(page.locator('.sketch-grab-handle')).toHaveAttribute(
    'data-active',
    'true'
  );
  const marker = page.locator('.sketch-snap-marker');
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAttribute('data-label', 'Center');
  await page.mouse.up();

  await expect(page.getByRole('contentinfo')).toContainText('Moved circle.');
  // The editor re-keys on the document version, so its fields are the
  // stored centre, and the selection survived the drag.
  await expect(moved.editor.getByLabel('Center X')).toHaveValue(target.x);
  await expect(moved.editor.getByLabel('Center Y')).toHaveValue(target.y);
});

test('dragging a text origin moves it, and its ring turns it', async ({
  page
}) => {
  test.setTimeout(90_000);
  const sketchTools = await openTopSketch(page, 'Sketch Move Text');
  const [circleCenter, textPoint] = await bareCanvasDrags(page, {
    count: 2,
    dragX: CIRCLE_DRAG_PX
  });
  await drawCircles(page, sketchTools, [circleCenter!]);
  const target = await selectCircle(page, circleCenter!);

  // Text is typed first: the card opens focused, and a click places the
  // typed string.
  await sketchTools.getByRole('button', { name: /^Text/ }).click();
  const card = page.getByRole('form', { name: 'Place text' });
  await expect(card.getByLabel('Text', { exact: true })).toBeFocused();
  await page.keyboard.type('Text');
  await expect(card.getByRole('button', { name: 'Place' })).toBeEnabled();
  await page.mouse.click(textPoint!.x, textPoint!.y);
  await expect(card).toHaveCount(0);
  const editor = page.getByRole('form', { name: 'Edit text' });
  await expect(editor).toBeVisible();
  const placed = {
    x: await editor.getByLabel('X', { exact: true }).inputValue(),
    y: await editor.getByLabel('Y', { exact: true }).inputValue()
  };
  expect(`${placed.x},${placed.y}`).not.toBe(`${target.x},${target.y}`);

  // Where the circle sits on screen now: placing the text can reframe the
  // view, so the point it was drawn at is stale. The drag's own readout
  // calibrates the plane: with Shift held nothing snaps, and the readout is
  // the exact origin under the pointer.
  const origin = await grabHandleCenter(page);
  const readout = async () => {
    const text = (await page.locator('.sketch-dim-label').textContent()) ?? '';
    const match = /X (-?[\d.]+) · Y (-?[\d.]+)/.exec(text);
    expect(match, text).not.toBeNull();
    return { x: Number(match![1]), y: Number(match![2]) };
  };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  const across = { x: origin.x - 300, y: origin.y };
  await page.mouse.move(across.x, across.y, { steps: 8 });
  const acrossAt = await readout();
  const up = { x: across.x, y: across.y - 100 };
  await page.mouse.move(up.x, up.y, { steps: 4 });
  const upAt = await readout();
  await page.keyboard.up('Shift');
  // Screen-to-plane is linear here; two strokes give its columns, so the
  // circle's screen point follows whatever the camera did meanwhile.
  const col1 = {
    x: (acrossAt.x - Number(placed.x)) / (across.x - origin.x),
    y: (acrossAt.y - Number(placed.y)) / (across.x - origin.x)
  };
  const col2 = {
    x: (upAt.x - acrossAt.x) / (up.y - across.y),
    y: (upAt.y - acrossAt.y) / (up.y - across.y)
  };
  const want = {
    x: Number(target.x) - upAt.x,
    y: Number(target.y) - upAt.y
  };
  const det = col1.x * col2.y - col2.x * col1.y;
  const circleOnScreen = {
    x: up.x + (want.x * col2.y - col2.x * want.y) / det,
    y: up.y + (col1.x * want.y - want.x * col1.y) / det
  };
  // A few pixels short of the centre: the snap decides where it lands.
  await page.mouse.move(circleOnScreen.x - 2, circleOnScreen.y + 3, {
    steps: 8
  });
  await expect(page.locator('.sketch-snap-marker')).toHaveAttribute(
    'data-label',
    'Center'
  );
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText('Moved text.');
  await expect(editor.getByLabel('X', { exact: true })).toHaveValue(target.x);
  await expect(editor.getByLabel('Y', { exact: true })).toHaveValue(target.y);

  // The ring sits around the origin. A quarter turn counter-clockwise on
  // screen is +90° on a plane seen head-on; measure it through the same
  // screen-to-plane map rather than assume the view is square to the plane.
  const ring = page.locator('.sketch-rotate-ring');
  await expect(ring).toBeVisible();
  const ringBox = await ring.boundingBox();
  expect(ringBox).not.toBeNull();
  const ringCenter = {
    x: ringBox!.x + ringBox!.width / 2,
    y: ringBox!.y + ringBox!.height / 2
  };
  const radius = ringBox!.width / 2 - 1;
  await page.mouse.move(ringCenter.x + radius, ringCenter.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    const angle = (step / 12) * (Math.PI / 2);
    await page.mouse.move(
      ringCenter.x + radius * Math.cos(angle),
      ringCenter.y - radius * Math.sin(angle)
    );
  }
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText('Rotated text.');
  const planeAngle = (dx: number, dy: number) =>
    Math.atan2(col1.y * dx + col2.y * dy, col1.x * dx + col2.x * dy);
  const turned =
    ((planeAngle(0, -radius) - planeAngle(radius, 0)) * 180) / Math.PI;
  const expected = Math.round(((((turned + 180) % 360) + 360) % 360) - 180);
  expect(Math.abs(Math.abs(expected) - 90)).toBeLessThanOrEqual(10);
  // Within a degree or two: the ring's drawn centre is whole pixels, and
  // a half-pixel at this radius is about a degree of turn.
  await expect
    .poll(async () =>
      Math.abs(
        Number(await editor.getByLabel('Rotation').inputValue()) - expected
      )
    )
    .toBeLessThanOrEqual(2);
  expect(
    Number.isInteger(Number(await editor.getByLabel('Rotation').inputValue()))
  ).toBe(true);
  // Turning is not moving: the origin stayed on the centre.
  await expect(editor.getByLabel('X', { exact: true })).toHaveValue(target.x);
  await expect(editor.getByLabel('Y', { exact: true })).toHaveValue(target.y);
});

test('Escape mid-drag restores the circle and keeps it selected', async ({
  page
}) => {
  test.setTimeout(90_000);
  const sketchTools = await openTopSketch(page, 'Sketch Move Escape');
  const [center] = await bareCanvasDrags(page, {
    count: 1,
    dragX: CIRCLE_DRAG_PX
  });
  await drawCircles(page, sketchTools, [center!]);
  const before = await selectCircle(page, center!);

  const handle = await grabHandleCenter(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 60, handle.y + 40, { steps: 10 });
  const grab = page.locator('.sketch-grab-handle');
  await expect(grab).toHaveAttribute('data-active', 'true');
  // The preview really moved before Escape takes it back.
  const dragged = await grab.boundingBox();
  expect(dragged!.x + dragged!.width / 2).toBeGreaterThan(handle.x + 30);

  await page.keyboard.press('Escape');
  await page.mouse.up();

  // One press cancels the drag only: the object and its editor stay, at
  // the stored centre, and nothing was written.
  await expect(grab).toHaveAttribute('data-active', 'false');
  await expect(before.editor).toBeVisible();
  await expect(before.editor.getByLabel('Center X')).toHaveValue(before.x);
  await expect(before.editor.getByLabel('Center Y')).toHaveValue(before.y);
  await expect(page.getByRole('contentinfo')).not.toContainText(
    'Moved circle.'
  );
  await expect
    .poll(async () => {
      const box = await grab.boundingBox();
      return box ? Math.round(box.x + box.width / 2 - handle.x) : null;
    })
    .toBe(0);

  // The release after Escape was swallowed rather than read as a click on
  // empty canvas, so the next Escape is the one that deselects.
  await page.keyboard.press('Escape');
  await expect(before.editor).toBeHidden();
});

test('a press away from the grab point does not move the selection', async ({
  page
}) => {
  test.setTimeout(90_000);
  const sketchTools = await openTopSketch(page, 'Sketch Move Off Handle');
  const [center] = await bareCanvasDrags(page, {
    count: 1,
    dragX: CIRCLE_DRAG_PX
  });
  await drawCircles(page, sketchTools, [center!]);
  const before = await selectCircle(page, center!);

  // Between the centre and the rim is neither the grab point nor the curve:
  // the press keeps meaning what it meant before, and the circle stays put.
  const handle = await grabHandleCenter(page);
  const start = { x: handle.x - CIRCLE_DRAG_PX / 2, y: handle.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 50, start.y + 30, { steps: 8 });
  await expect(page.locator('.sketch-grab-handle')).toHaveAttribute(
    'data-active',
    'false'
  );
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).not.toContainText(
    'Moved circle.'
  );
  await expect(before.editor.getByLabel('Center X')).toHaveValue(before.x);
  await expect(before.editor.getByLabel('Center Y')).toHaveValue(before.y);
});

test('a click after Escape ended a drag released off the canvas still selects', async ({
  page
}) => {
  test.setTimeout(90_000);
  const sketchTools = await openTopSketch(page, 'Sketch Move Off Canvas');
  const [first, second] = await bareCanvasDrags(page, {
    count: 2,
    dragX: CIRCLE_DRAG_PX
  });
  await drawCircles(page, sketchTools, [first!, second!]);
  const other = await selectCircle(page, second!);
  const before = await selectCircle(page, first!);

  // Drag onto the sketch rail, end the drag with Escape there, and let go
  // over the rail: with capture dropped, that release never reaches the
  // canvas, so the viewport cannot consume it.
  const handle = await grabHandleCenter(page);
  const rail = await page.locator('.sketch-rail').boundingBox();
  expect(rail).not.toBeNull();
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(rail!.x + rail!.width / 2, rail!.y + 4, {
    steps: 10
  });
  await expect(page.locator('.sketch-grab-handle')).toHaveAttribute(
    'data-active',
    'true'
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(before.editor.getByLabel('Center X')).toHaveValue(before.x);

  // The next click on the other circle must select it, not be swallowed as
  // the release Escape was waiting for.
  await page.mouse.click(second!.x + CIRCLE_DRAG_PX, second!.y);
  await expect(before.editor.getByLabel('Center X')).toHaveValue(other.x);
  await expect(before.editor.getByLabel('Center Y')).toHaveValue(other.y);
});

test('a second pointer during a drag neither steals nor ends it', async ({
  page
}) => {
  test.setTimeout(90_000);
  const sketchTools = await openTopSketch(page, 'Sketch Move Two Pointers');
  const [first, second] = await bareCanvasDrags(page, {
    count: 2,
    dragX: CIRCLE_DRAG_PX
  });
  await drawCircles(page, sketchTools, [first!, second!]);
  const target = await selectCircle(page, second!);
  const moved = await selectCircle(page, first!);

  const handle = await grabHandleCenter(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 20, handle.y + 10, { steps: 4 });
  const grab = page.locator('.sketch-grab-handle');
  await expect(grab).toHaveAttribute('data-active', 'true');

  // A second pointer presses the grabbed object's handle and lets go, the
  // way a second finger or a stylus would, while the mouse still holds it.
  const dragged = await grab.boundingBox();
  await page.locator('.viewer-host canvas').evaluate(
    (canvas, point) => {
      const init = {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: false,
        button: 0,
        clientX: point.x,
        clientY: point.y
      };
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', { ...init, buttons: 1 })
      );
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          ...init,
          buttons: 1,
          clientX: point.x + 40
        })
      );
      canvas.dispatchEvent(
        new PointerEvent('pointerup', { ...init, buttons: 0 })
      );
    },
    {
      x: dragged!.x + dragged!.width / 2,
      y: dragged!.y + dragged!.height / 2
    }
  );
  await expect(grab).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('contentinfo')).not.toContainText(
    'Moved circle.'
  );

  // The first pointer's drag is intact: it still snaps, and its release is
  // the one that commits.
  await page.mouse.move(second!.x + 3, second!.y - 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText('Moved circle.');
  await expect(moved.editor.getByLabel('Center X')).toHaveValue(target.x);
  await expect(moved.editor.getByLabel('Center Y')).toHaveValue(target.y);
});

test('a click on the grab point keeps the object selected', async ({
  page
}) => {
  test.setTimeout(90_000);
  const sketchTools = await openTopSketch(page, 'Sketch Move Handle Click');
  const [center] = await bareCanvasDrags(page, {
    count: 1,
    dragX: CIRCLE_DRAG_PX
  });
  await drawCircles(page, sketchTools, [center!]);
  const before = await selectCircle(page, center!);

  // A press that never travels is a click, and a click on the selected
  // circle's own centre handle must not read as one on empty canvas.
  const handle = await grabHandleCenter(page);
  await page.mouse.click(handle.x, handle.y);
  await expect(before.editor).toBeVisible();
  await expect(page.locator('.sketch-grab-handle')).toBeVisible();
  await expect(before.editor.getByLabel('Center X')).toHaveValue(before.x);
  await expect(before.editor.getByLabel('Center Y')).toHaveValue(before.y);
  await expect(page.getByRole('contentinfo')).not.toContainText(
    'Moved circle.'
  );
});

test('a second pointer that outlasts the drag does not deselect', async ({
  page
}) => {
  test.setTimeout(90_000);
  const sketchTools = await openTopSketch(page, 'Sketch Move Late Release');
  const [first, second] = await bareCanvasDrags(page, {
    count: 2,
    dragX: CIRCLE_DRAG_PX
  });
  await drawCircles(page, sketchTools, [first!, second!]);
  const target = await selectCircle(page, second!);
  const moved = await selectCircle(page, first!);

  const handle = await grabHandleCenter(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 20, handle.y + 10, { steps: 4 });
  const grab = page.locator('.sketch-grab-handle');
  await expect(grab).toHaveAttribute('data-active', 'true');

  // A second pointer presses on empty canvas while the mouse holds the
  // drag, and is still down when the mouse lets go.
  const canvas = page.locator('.viewer-host canvas');
  const empty = {
    x: first!.x - CIRCLE_DRAG_PX * 2,
    y: first!.y + CIRCLE_DRAG_PX * 2
  };
  const touch = (type: string, buttons: number) =>
    canvas.evaluate(
      (element, args) => {
        element.dispatchEvent(
          new PointerEvent(args.type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: false,
            button: 0,
            buttons: args.buttons,
            clientX: args.x,
            clientY: args.y
          })
        );
      },
      { type, buttons, ...empty }
    );
  await touch('pointerdown', 1);

  await page.mouse.move(second!.x + 3, second!.y - 2, { steps: 8 });
  await page.mouse.up();
  // Only now does the second pointer let go, over empty canvas: a click
  // there would deselect, and the commit's selection guard would refuse it.
  await touch('pointerup', 0);

  await expect(page.getByRole('contentinfo')).toContainText('Moved circle.');
  await expect(moved.editor).toBeVisible();
  await expect(moved.editor.getByLabel('Center X')).toHaveValue(target.x);
  await expect(moved.editor.getByLabel('Center Y')).toHaveValue(target.y);
});

test('another press after Escape does not free the held release', async ({
  page
}) => {
  test.setTimeout(90_000);
  const sketchTools = await openTopSketch(page, 'Sketch Move Escape Then Tap');
  const [center] = await bareCanvasDrags(page, {
    count: 1,
    dragX: CIRCLE_DRAG_PX
  });
  await drawCircles(page, sketchTools, [center!]);
  const before = await selectCircle(page, center!);

  const handle = await grabHandleCenter(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  // Away to empty canvas, so the eventual release would be a deselecting
  // click if anything let it through.
  const empty = { x: handle.x - 90, y: handle.y + 70 };
  await page.mouse.move(empty.x, empty.y, { steps: 8 });
  const grab = page.locator('.sketch-grab-handle');
  await expect(grab).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Escape');

  // A second pointer taps the circle's rim while the mouse is still held:
  // an ordinary click that keeps the same selection.
  await page.locator('.viewer-host canvas').evaluate(
    (canvas, point) => {
      const init = {
        bubbles: true,
        cancelable: true,
        pointerId: 9,
        pointerType: 'touch',
        isPrimary: false,
        button: 0,
        clientX: point.x,
        clientY: point.y
      };
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', { ...init, buttons: 1 })
      );
      canvas.dispatchEvent(
        new PointerEvent('pointerup', { ...init, buttons: 0 })
      );
    },
    { x: center!.x + CIRCLE_DRAG_PX, y: center!.y }
  );

  // The mouse's release, over empty canvas, belongs to the drag Escape
  // already ended: the circle stays selected and unmoved.
  await page.mouse.up();
  await expect(before.editor).toBeVisible();
  await expect(before.editor.getByLabel('Center X')).toHaveValue(before.x);
  await expect(before.editor.getByLabel('Center Y')).toHaveValue(before.y);
  await expect(page.getByRole('contentinfo')).not.toContainText(
    'Moved circle.'
  );
});
