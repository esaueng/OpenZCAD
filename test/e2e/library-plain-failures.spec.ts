import { expect, test } from '@playwright/test';

// 13 November design review I3 and I4: the library's Import showed the JSON
// parser's words ("Unexpected token 'I', "ISO-10303-"… is not valid JSON")
// in one truncated grey line at the foot of the sidebar.
test('a CAD file given to the library Import says what it is, in a warning toast @ci-smoke', async ({
  page
}) => {
  await page.goto('/');
  await page
    .getByLabel('Import project backup')
    .first()
    .setInputFiles({
      name: 'bracket.step',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\n')
    });
  const toast = page.locator('.toast.warning');
  await expect(toast).toContainText(
    'This is a STEP file, not an OpenZCAD project backup. Open a project and use Import CAD files to bring it in.'
  );
  await expect(page.locator('body')).not.toContainText('is not valid JSON');
});
