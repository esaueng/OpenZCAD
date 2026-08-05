import {
  test,
  expect,
  createProject,
  openAssistant,
  stubApi,
  stubAssistant,
  waitForSurfacesToSettle
} from './openzcad-fixtures';

test('keeps command names visible at the compact desktop breakpoint', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Palette Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: 'Search commands (Ctrl+K)' }).click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(
    palette.locator('.palette-label', { hasText: 'Box' })
  ).toBeVisible();
  await palette.getByRole('textbox', { name: 'Search commands' }).fill('box');
  await expect(
    palette.locator('.palette-label', { hasText: 'Box' })
  ).toBeVisible();
});

test('keeps the top-bar order fixed and dismisses the file menu outside', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Top Bar Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();

  const topbar = page.locator('.topbar');
  const actions = topbar.getByRole('group', {
    name: 'Workspace status and actions'
  });
  const actionSlots = actions.locator(':scope > *');
  await expect(actionSlots).toHaveCount(5);
  await expect(actionSlots.nth(0)).toHaveClass(/save-state/);
  await expect(actionSlots.nth(1)).toHaveClass(/account-state/);
  await expect(actionSlots.nth(1)).toHaveText('Signed in');
  await expect(topbar).not.toContainText('E2E user');
  await expect(actionSlots.nth(2)).toHaveAttribute(
    'aria-label',
    'Open project sharing'
  );
  await expect(actionSlots.nth(3)).toHaveClass(/file-menu/);
  await expect(actionSlots.nth(4)).toHaveAttribute(
    'aria-label',
    'Open settings'
  );

  const fileMenu = topbar.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  await expect(fileMenu).toHaveAttribute('open', '');

  await topbar.locator('.topbar-divider').click();
  await expect(fileMenu).not.toHaveAttribute('open', '');

  const slotBounds = async () =>
    actions.locator(':scope > *').evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right };
      })
    );
  const beforeStateChanges = await slotBounds();
  await actions.locator('.save-state').evaluate((element) => {
    element.lastChild!.textContent = 'Autosave off';
  });
  await actions.locator('.account-state').evaluate((element) => {
    element.lastChild!.textContent = 'Unavailable';
  });
  await actions.locator('.collaboration-state').evaluate((element) => {
    element.lastChild!.textContent = 'Update required';
  });
  expect(await slotBounds()).toEqual(beforeStateChanges);
});

test('opens new projects blank with the assistant collapsed', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  await createProject(page, 'First Blank Part');

  const workspace = page.locator('.workspace');
  await expect(page.locator('.viewer-notice')).toHaveCount(0);
  await expect(page.getByText('No geometry yet')).toHaveCount(0);
  await expect(page.locator('.assistant-panel')).toHaveCount(0);
  await expect(page.locator('.assistant-launcher')).toBeVisible();
  await expect(workspace).not.toHaveClass(/with-assistant/);

  await openAssistant(page);
  await expect(workspace).toHaveClass(/with-assistant/);

  await page.getByTitle('Back to projects').click();
  await expect(
    page.getByRole('button', { name: 'Create project' })
  ).toBeVisible();
  await page.getByLabel('Project name').fill('Second Blank Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.locator('.assistant-panel')).toHaveCount(0);
  await expect(page.locator('.assistant-launcher')).toBeVisible();
  await expect(workspace).not.toHaveClass(/with-assistant/);
  await expect(page.locator('.viewer-notice')).toHaveCount(0);
});

test('keeps every workspace surface inside a narrow viewport', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page, { assistantEnabled: true });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Narrow Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await openAssistant(page);

  const selectors = [
    '.topbar',
    '.workspace',
    '.sidebar',
    '.viewer-area',
    '.assistant-panel',
    '.status-bar'
  ];
  // What has to hold is where these surfaces come to rest. The dock opens with
  // a 200 ms slide from `translateX(12px)`, which deliberately starts it past
  // the right edge (the shell clips it), so measure once that has landed.
  await waitForSurfacesToSettle(page, selectors);
  for (const selector of selectors) {
    const bounds = await page.locator(selector).boundingBox();
    expect(bounds, `${selector} should be laid out`).not.toBeNull();
    expect(
      bounds!.x,
      `${selector} should not start offscreen`
    ).toBeGreaterThanOrEqual(0);
    expect(
      bounds!.x + bounds!.width,
      `${selector} should not end offscreen`
    ).toBeLessThanOrEqual(390.5);
  }

  const sidebarBounds = await page.locator('.sidebar').boundingBox();
  const viewerBounds = await page.locator('.viewer-area').boundingBox();
  expect(viewerBounds!.y).toBeGreaterThanOrEqual(
    sidebarBounds!.y + sidebarBounds!.height - 0.5
  );
  await expect(page.locator('.status-groups')).toBeHidden();
  await expect(page.locator('.status-filters > b')).toBeHidden();
  const statusStateBounds = await page.locator('.status-state').boundingBox();
  const statusFilterBounds = await page
    .locator('.status-filters')
    .boundingBox();
  expect(statusStateBounds).not.toBeNull();
  expect(statusFilterBounds).not.toBeNull();
  expect(statusStateBounds!.x).toBeGreaterThanOrEqual(0);
  expect(statusFilterBounds!.x + statusFilterBounds!.width).toBeLessThanOrEqual(
    390.5
  );
  await expect(page.locator('.viewer-rail-stack')).toBeVisible();

  const overflowingTopbarChildren = await page.locator('.topbar').evaluate(
    (topbar) =>
      [...topbar.children].filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < -0.5 || bounds.right > window.innerWidth + 0.5;
      }).length
  );
  expect(overflowingTopbarChildren).toBe(0);
});

test('refuses an invalid project name instead of working locally', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');

  // The form itself blocks an over-long name and explains the limit.
  await page.getByLabel('Project name').fill('n'.repeat(201));
  await expect(page.getByRole('alert')).toContainText('at most 200 characters');
  await expect(
    page.getByRole('button', { name: 'Create project' })
  ).toBeDisabled();

  // A server-side rejection must surface too. It used to be swallowed into
  // local mode, persisting the very project the API had just refused.
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 400,
          json: { error: '"name" must be at most 200 characters.' }
        })
      : route.fulfill({ json: { projects: [] } })
  );
  await page.getByLabel('Project name').fill('Rejected Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.locator('.start-status')).toContainText(
    'at most 200 characters'
  );
  // Still on the start screen: no workspace, and nothing persisted locally.
  await expect(page.getByLabel('Project name')).toBeVisible();
  await expect(page.locator('.start-status')).not.toContainText(
    'Working locally'
  );
});

test('settings name their sections and search individual settings', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  const settingsTrigger = page.getByRole('button', { name: 'Open settings' });
  await settingsTrigger.click();

  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.locator(':focus')).toHaveCount(1);
  await expect(page.locator('.start-screen')).toHaveAttribute('inert', '');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Settings' })
  ).toBeVisible();

  // "Default units" is a setting title, not a section label; searching it used
  // to empty the nav while the setting stayed visible in an unchanged section.
  await page.getByLabel('Find a setting').fill('Default units');
  await expect(
    page.getByRole('button', { name: 'General', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Viewport', exact: true })
  ).toHaveCount(0);

  await page.getByLabel('Find a setting').fill('zzzz-no-match');
  await expect(page.locator('.settings-nav-empty')).toContainText(
    'No settings match'
  );
  await page.getByLabel('Find a setting').fill('');

  await page.getByRole('button', { name: 'Sketching', exact: true }).click();
  await page.getByLabel('Linear snap increment').fill('0');
  await page.getByRole('button', { name: 'Viewport', exact: true }).click();
  await page.getByRole('button', { name: 'Sketching', exact: true }).click();
  await expect(page.getByLabel('Linear snap increment')).toHaveValue('1');
  await page.getByRole('button', { name: 'General', exact: true }).click();

  // The search itself is desktop-only, but below 580px the nav collapses to
  // icons whose labels are hidden; those buttons used to reach the
  // accessibility tree with no name at all.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: 'General', exact: true })
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('button', { name: 'Viewport', exact: true })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await expect(settingsTrigger).toBeFocused();
  await expect(page.locator('.start-screen')).not.toHaveAttribute('inert', '');
});

test('settings restore the exact non-sensitive view after reload', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
  await page.getByLabel('Find a setting').fill('mouse');

  await expect(
    page.getByRole('heading', { level: 2, name: 'Controls & shortcuts' })
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const scrollTop = await page
    .locator('.settings-content')
    .evaluate((content) => {
      content.scrollTop = 240;
      content.dispatchEvent(new Event('scroll'));
      return content.scrollTop;
    });
  expect(scrollTop).toBeGreaterThan(0);

  await page.reload();

  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByLabel('Find a setting')).toHaveValue('mouse');
  await expect(
    page.getByRole('button', { name: 'Shortcuts', exact: true })
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Controls & shortcuts' })
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const restoredScroll = await page
    .locator('.settings-content')
    .evaluate((content) => ({
      scrollTop: content.scrollTop,
      maximum: content.scrollHeight - content.clientHeight
    }));
  expect(restoredScroll.scrollTop).toBe(
    Math.min(scrollTop, restoredScroll.maximum)
  );

  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
});

test('command palette and shortcut overlay behave as modal dialogs', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('A11y Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();

  const paletteTrigger = page.getByRole('button', {
    name: 'Search commands (Ctrl+K)'
  });
  await paletteTrigger.click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toHaveAttribute('aria-modal', 'true');
  // The highlighted row is now exposed, not merely styled.
  await expect(palette.locator('.palette-row.active')).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByLabel('Search commands')).toHaveAttribute(
    'aria-activedescendant',
    /command-palette-option-\d+/
  );
  await expect(page.getByLabel('Search commands')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(paletteTrigger).toBeFocused();

  await page.keyboard.press('?');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts).toHaveAttribute('aria-modal', 'true');
  // Focus used to stay on BODY, leaving the dialog unreachable by keyboard.
  await expect(shortcuts.locator(':focus')).toHaveCount(1);
});

test('launcher semantics, empty states, and demo cards hold at mobile width', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1, name: 'OpenZCAD' })
  ).toBeVisible();
  await page.getByLabel('Project name').fill('Search Fixture');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^OpenZCAD/ }).click();
  await page.getByLabel('Search parts').fill('no-match');
  await page.getByRole('tab', { name: 'Archive 0' }).click();

  await expect(
    page.getByText('Nothing archived.', { exact: false })
  ).toBeVisible();
  await expect(page.getByText('No parts match', { exact: false })).toHaveCount(
    0
  );

  const widths = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.start-body');
    const demos = document.querySelector<HTMLElement>('.demo-list');
    return {
      body: body
        ? { client: body.clientWidth, scroll: body.scrollWidth }
        : null,
      demos: demos
        ? { client: demos.clientWidth, scroll: demos.scrollWidth }
        : null,
      document: {
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth
      }
    };
  });
  expect(widths.body?.scroll).toBeLessThanOrEqual(widths.body?.client ?? 0);
  expect(widths.demos?.scroll).toBeLessThanOrEqual(widths.demos?.client ?? 0);
  expect(widths.document.scroll).toBeLessThanOrEqual(widths.document.client);
});

test('settings leave the conversation and its in-flight reply intact', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  let releaseReply!: () => void;
  await stubAssistant(
    page,
    new Promise<void>((resolve) => {
      releaseReply = resolve;
    })
  );
  await createProject(page, 'Shell State Part');
  await openAssistant(page);

  await page.getByLabel('CAD change request').fill('Add a 10 mm cube');
  await page.getByLabel('CAD change request').press('Enter');
  const thread = page.locator('.assistant-thread');
  await expect(thread).toContainText('Add a 10 mm cube');

  // Settings used to replace the whole shell. That unmounted the panel, which
  // aborts the request on its way out and takes the thread with it.
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();

  releaseReply();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await expect(settings).toHaveCount(0);

  await expect(thread).toContainText('Add a 10 mm cube');
  // The reply that landed while Settings was up survived the round trip.
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );
});

test('disabling the assistant takes its live preview with it', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Orphan Preview Part');
  await openAssistant(page);

  await page.getByLabel('CAD change request').fill('Add a 10 mm cube');
  await page.getByLabel('CAD change request').press('Enter');
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('Previewing exact proposed geometry.');
  // The preview is unapplied geometry: it shows a body the document does not
  // have, which is what makes an orphaned preview visible at all.
  await expect(status.locator('[title*="1 bodies"]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('checkbox', { name: 'AI assistant' }).uncheck();
  await page.getByRole('button', { name: 'Back to workspace' }).click();

  // The panel is gone, so nothing is left that could retire the preview — the
  // workspace has to drop it rather than render a proposal forever.
  await expect(page.locator('.assistant-panel')).toHaveCount(0);
  await expect(status.locator('[title*="0 bodies"]')).toHaveCount(1);
});

test('settings swallow workspace shortcuts instead of editing behind them', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Shortcut Guard Part');

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  const feature = page.locator('.feature-row', { hasText: 'Box' });
  await expect(feature).toBeVisible();

  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  // Move focus off the search field so nothing is merely absorbed by an input.
  await page.getByRole('heading', { level: 1, name: 'Settings' }).click();

  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+k');
  await page.keyboard.press('b');

  await page.getByRole('button', { name: 'Back to workspace' }).click();

  // Every one of those keys edited or opened something behind the settings UI
  // before the workspace map learned to stand down.
  await expect(feature).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Command palette' })
  ).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Box operation' })).toHaveCount(
    0
  );
});

test('a direct mode hides the assistant without ending the conversation', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Direct Mode Part');
  await openAssistant(page);

  await page.getByLabel('CAD change request').fill('Add a 10 mm cube');
  await page.getByLabel('CAD change request').press('Enter');
  const thread = page.locator('.assistant-thread');
  await expect(thread).toContainText('Add a 10 mm cube');
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  const panel = page.locator('.assistant-panel');
  await page.keyboard.press('m');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
  // Hidden, not unmounted: the panel owns the conversation, so entering a
  // direct-manipulation mode has to give back its column without dropping it.
  await expect(panel).toBeHidden();
  await expect(panel).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(thread).toContainText('Add a 10 mm cube');
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );
});

test('collapsing the assistant frees its column and keeps the thread', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Collapse Part');
  await openAssistant(page);

  await page.getByLabel('CAD change request').fill('Add a 10 mm cube');
  await page.getByLabel('CAD change request').press('Enter');
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );

  const viewerBefore = await page.locator('.viewer-area').boundingBox();
  await page.getByRole('button', { name: 'Collapse the assistant' }).click();

  // A collapse has to give the dock's whole column back, not just its contents.
  await expect(page.locator('.assistant-panel')).toHaveCount(0);
  await expect(page.locator('.workspace.with-assistant')).toHaveCount(0);
  const launcher = page.getByRole('button', {
    name: /Open the modeling assistant/
  });
  await expect(launcher).toBeVisible();
  const viewerAfter = await page.locator('.viewer-area').boundingBox();
  expect(viewerAfter!.width).toBeGreaterThan(viewerBefore!.width + 100);

  await launcher.click();
  await expect(page.locator('.assistant-thread')).toContainText(
    'Add a 10 mm cube'
  );

  // The thread belongs to the project, not to the tab that was open at the
  // time: it has to survive a reload, proposal and all.
  await page.reload();
  await expect(page.locator('.assistant-thread')).toContainText(
    'Add a 10 mm cube'
  );
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );
});
