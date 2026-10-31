import type { Page } from '@playwright/test';
import type {
  CadDigestDrawingEdge,
  CadDocumentDigest
} from '@openzcad/ai-contracts';
import {
  askAssistant,
  createPrimitiveInPlace,
  expect,
  openAssistant,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * D06 slice E: asked from Draw, the assistant reads the open sheet's digest
 * and proposes dimensions by its edge refs. The proposal is checked against
 * the drawn model, previewed on the sheet, and applied as one undo step.
 * The provider is a stub that answers from the digest it is sent, the way a
 * model must.
 */

function mode(page: Page, name: 'Build' | 'Draw') {
  return page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name, exact: true });
}

const level = (edge: CadDigestDrawingEdge) =>
  edge.curve === 'line' &&
  edge.ends![0][1] === edge.ends![1][1] &&
  edge.ends![0][0] !== edge.ends![1][0];
const plumb = (edge: CadDigestDrawingEdge) =>
  edge.curve === 'line' &&
  edge.ends![0][0] === edge.ends![1][0] &&
  edge.ends![0][1] !== edge.ends![1][1];

test('the assistant dimensions a Draw sheet from its digest', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'drawing-assistant-test',
        reasoningEffort: 'high'
      }
    })
  );
  let sent: CadDocumentDigest | null = null;
  await page.route('**/api/assistant/proposals', async (route) => {
    const { digest } = route.request().postDataJSON() as {
      digest: CadDocumentDigest;
    };
    sent = digest;
    const drawing = digest.drawing!;
    const front = drawing.views.find((view) => view.orientation === 'front')!;
    const top = front.edges
      .filter(level)
      .reduce((a, b) => (b.ends![0][1] > a.ends![0][1] ? b : a));
    const right = front.edges
      .filter(plumb)
      .reduce((a, b) => (b.ends![0][0] > a.ends![0][0] ? b : a));
    const linear = (
      ref: string,
      direction: string,
      placementMm: { x: number; y: number }
    ) => ({
      annotationKind: 'linear',
      viewId: front.viewId,
      direction,
      from: { edgeRef: ref, anchor: 'first' },
      to: { edgeRef: ref, anchor: 'second' },
      edgeRefs: [],
      text: null,
      placementMm,
      decimals: null
    });
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: JSON.stringify({
          replyKind: 'patch',
          questions: null,
          message: null,
          readings: null,
          proposal: {
            proposalId: 'dimension_box',
            summary: 'Dimension the box in the front view.',
            assumptions: [],
            preserveGeometry: false,
            operations: [
              {
                kind: 'add_drawing_annotations',
                sheetId: drawing.sheetId,
                annotations: [
                  linear(top.ref, 'horizontal', {
                    x: 0,
                    y: front.heightMm / 2 + 10
                  }),
                  linear(right.ref, 'vertical', {
                    x: front.widthMm / 2 + 10,
                    y: 0
                  })
                ]
              }
            ]
          }
        })
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('Dimensioned by AI');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '30', depth: '20', height: '10' }
  });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  await mode(page, 'Draw').click();
  const drawings = page.getByRole('region', { name: 'Drawings' });
  await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
  const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
  await expect(
    canvas.locator('[data-view="front"]:not(.is-placeholder)')
  ).toHaveCount(1, { timeout: 20_000 });

  // The assistant is there in Draw, and its ask carries the sheet.
  await openAssistant(page);
  await askAssistant(page, 'Add the dimensions');
  const card = page.locator('.assistant-card', {
    hasText: 'Dimension the box in the front view.'
  });
  await expect(card).toBeVisible({ timeout: 30_000 });
  expect(sent!.drawing?.ready).toBe(true);

  // Previewed on the sheet before anything is applied.
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension 30' })
  ).toBeVisible();
  await expect(
    canvas.getByRole('button', { name: 'Vertical dimension 10' })
  ).toBeVisible();

  await card.getByRole('button', { name: /Apply/ }).click();
  await expect(card).toContainText('undo reverses it');
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension 30' })
  ).toBeVisible();

  // One step: a single undo takes both away.
  await canvas.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(canvas.getByRole('button', { name: /dimension/ })).toHaveCount(
    0
  );
});
