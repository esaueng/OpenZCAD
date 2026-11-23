import {
  createPrimitiveInPlace,
  createProject,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';

// W01: the stage's lane heights, written on `.viewer-area` as an edit lands,
// must reach the notice lanes but stop at the model panels' frame, so that a
// write restyles the lanes and not every History and Objects row
// (test/stage-metric-isolation.test.ts keeps the property list complete).
test('stage lane metrics reach the lanes but not the model panels', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Stage metric isolation');
  await createPrimitiveInPlace(page, 'box');
  const row = page.locator('.model-panel .feature-row').first();
  await expect(row).toBeVisible();

  const read = await page.evaluate(() => {
    const viewer = document.querySelector<HTMLElement>('.viewer-area')!;
    viewer.style.setProperty('--workspace-guidance-h', '37px');
    viewer.style.setProperty('--in-place-command-h', '40px');
    const style = (selector: string) =>
      getComputedStyle(document.querySelector(selector)!);
    const lane = style('.viewer-area > :not(.panel-dock-layer)');
    const panel = style('.model-panel');
    const panelRow = style('.model-panel .feature-row');
    return {
      laneGuidance: lane.getPropertyValue('--workspace-guidance-h').trim(),
      laneCommand: lane.getPropertyValue('--in-place-command-h').trim(),
      laneBase: style('.viewer-area').getPropertyValue('--lane-base').trim(),
      panelGuidance: panel.getPropertyValue('--workspace-guidance-h'),
      panelBase: panel.getPropertyValue('--lane-base'),
      rowGuidance: panelRow.getPropertyValue('--workspace-guidance-h'),
      rowCommand: panelRow.getPropertyValue('--in-place-command-h'),
      rowBase: panelRow.getPropertyValue('--lane-base')
    };
  });
  // The stage still works its lanes out from what was published…
  expect(read.laneGuidance).toBe('37px');
  expect(read.laneCommand).toBe('40px');
  expect(read.laneBase).toContain('37px');
  // …and a panel's style does not depend on it at all.
  expect(read).toMatchObject({
    panelGuidance: '',
    panelBase: '',
    rowGuidance: '',
    rowCommand: '',
    rowBase: ''
  });
});
