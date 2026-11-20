import {
  askAssistant,
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  openAssistant,
  pickPlanarFace,
  stubApi,
  test
} from './openzcad-fixtures';

// F03: a typed hole in the selected flat face is a provider-free proposal
// built on the manual Hole command; it previews exactly before Apply and
// lands as one undoable history step.
test(
  'drills a plain-language hole in the selected face without a provider, then undoes it in one step',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page, { assistantEnabled: true });
    await page.route('**/api/assistant/status', (route) =>
      route.fulfill({ json: { configured: false } })
    );
    let providerRequests = 0;
    await page.route('**/api/assistant/proposals', (route) => {
      providerRequests++;
      return route.abort();
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    await page.getByLabel('Project name').fill('Assistant hole');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await openAssistant(page);

    // Without a face picked the ask says what it needs and changes nothing.
    await askAssistant(page, 'Drill a 5 mm hole 8 mm deep');
    await expect(page.locator('.assistant-panel')).toContainText(
      'Select the one flat face to drill',
      { timeout: 30_000 }
    );
    await expect(
      page.getByRole('heading', { name: 'History 1' })
    ).toBeVisible();

    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }), {
        timeout: 30_000
      })
      .not.toBeNull();
    await askAssistant(page, 'Drill a 5 mm hole 8 mm deep');
    const proposal = page.locator('.assistant-card.proposal.open').last();
    await expect(proposal).toContainText('5 mm hole 8 mm deep', {
      timeout: 30_000
    });
    // Previewed, not applied.
    await expect(
      page.getByRole('heading', { name: 'History 1' })
    ).toBeVisible();
    await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(
      page.locator('.assistant-card.proposal.applied').last()
    ).toContainText('Applied');
    await expect(
      page.getByRole('heading', { name: 'History 2' })
    ).toBeVisible();
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'History 1' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'History 2' })
    ).toBeVisible();
    await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'History 2' })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    expect(providerRequests).toBe(0);
    expect(errors).toEqual([]);
  }
);
