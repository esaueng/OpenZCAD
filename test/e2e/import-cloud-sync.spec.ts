import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type CreateUploadSessionRequest,
  type FinalizeArtifactRequest,
  type SaveProjectDocumentRequest
} from '@openzcad/shared';
import { test, expect, stubApi, createProject } from './openzcad-fixtures';

function backup() {
  const bytes = readFileSync('test/parity/corpus/b-unit-mm-cube.step');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const document = importStepBody(
    createProjectDocument('Imported cube', toUserId('foreign-owner')),
    {
      name: 'Cube source',
      artifactId: 'artifact_original',
      sourceName: 'cube.step',
      stepSourceRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: checksum,
        logicalBytes: bytes.length
      }
    }
  ).document;
  return {
    format: 'openzcad-project',
    version: 1,
    document,
    files: [],
    sources: [
      {
        sha256: checksum,
        logicalBytes: bytes.length,
        base64: bytes.toString('base64')
      }
    ]
  };
}

for (const { failFirstUpload, editDuringUpload } of [
  { failFirstUpload: false, editDuringUpload: false },
  { failFirstUpload: true, editDuringUpload: false },
  { failFirstUpload: false, editDuringUpload: true }
])
  test(`import stays editable and account save includes sources${failFirstUpload ? ' with retry' : editDuringUpload ? ' while editing' : ''}`, async ({
    page
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page, { collaborationRole: 'owner' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Focus this flow on project access; the lease protocol has separate coverage.
    await page.route('**/api/collaboration/config', (route) =>
      route.fulfill({
        json: {
          sharingEnabled: true,
          editLeasesEnforced: false,
          personalSyncEnabled: true,
          canary: false
        }
      })
    );
    await page.route('**/api/health', (route) =>
      route.fulfill({
        json: {
          status: 'ok',
          environment: 'beta',
          projectSharingEnabled: true,
          projectEditLeasesEnforced: false,
          projectPersonalSyncEnabled: true
        }
      })
    );
    let uploadAttempts = 0;
    let finishUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    if (!editDuringUpload) finishUpload();
    const artifact = {
      artifactId: 'artifact_uploaded_cube',
      projectId: '',
      name: 'cube.step',
      kind: 'step-import',
      contentType: 'model/step',
      objectKey: 'cube.step',
      createdAt: new Date().toISOString(),
      metadata: {}
    };
    await page.route('**/api/uploads', (route) => {
      const input = route
        .request()
        .postDataJSON() as CreateUploadSessionRequest;
      if (input.kind !== 'step-import') return route.fallback();
      uploadAttempts++;
      if (failFirstUpload && uploadAttempts === 1)
        return route.fulfill({
          status: 503,
          json: { error: 'Temporarily unavailable' }
        });
      artifact.projectId = input.projectId;
      return route.fulfill({
        json: {
          session: {
            uploadSessionId: 'upload_cube',
            artifactId: artifact.artifactId,
            projectId: input.projectId,
            uploadUrl: '/api/uploads/upload_cube/content'
          }
        }
      });
    });
    await page.route('**/api/uploads/upload_cube/content', async (route) => {
      await uploadGate;
      await route.fulfill({ status: 204 });
    });
    await page.route('**/api/artifacts/finalize', (route) =>
      (route.request().postDataJSON() as FinalizeArtifactRequest).artifactId ===
      artifact.artifactId
        ? route.fulfill({ json: { artifactId: artifact.artifactId } })
        : route.fallback()
    );
    await page.route('**/api/artifacts/artifact_uploaded_cube', (route) =>
      route.fulfill({ json: { artifact } })
    );
    const writes: ProjectDocument[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith('/document'))
        writes.push(
          (request.postDataJSON() as SaveProjectDocumentRequest).document
        );
      if (request.method() === 'POST' && request.url().endsWith('/revisions'))
        writes.push(
          (request.postDataJSON() as SaveProjectDocumentRequest).document
        );
    });
    await createProject(page, 'Connected before import');
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'cube.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup()))
    });
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toHaveText('Imported cube');
    await expect(
      page.getByRole('button', { name: 'Save to my account', exact: true })
    ).toBeVisible();
    // This edit was blocked by the old cloudAvailable flag after import.
    await page.getByRole('button', { name: 'Rename project' }).click();
    await page
      .getByRole('textbox', { name: 'Project name', exact: true })
      .fill('Editable imported cube');
    await page
      .getByRole('textbox', { name: 'Project name', exact: true })
      .press('Enter');
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toHaveText('Editable imported cube');
    const beforeUrls = await page.evaluate(
      () =>
        (window as unknown as { __e2eCollaborationSocketUrls: string[] })
          .__e2eCollaborationSocketUrls
    );
    expect(beforeUrls.length).toBe(1);
    await page.getByRole('button', { name: /Open project sharing/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Project sharing' });
    await expect(
      dialog.getByText('Save this project to your account')
    ).toBeVisible();
    await expect(
      dialog.getByText(
        'Only the project owner can manage members and invitations.'
      )
    ).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save to my account' }).click();
    await expect.poll(() => uploadAttempts).toBe(1);
    await dialog.getByRole('button', { name: 'Close sharing' }).click();
    if (editDuringUpload) {
      await page.getByRole('button', { name: 'Rename project' }).click();
      await page
        .getByRole('textbox', { name: 'Project name', exact: true })
        .fill('Edited during upload');
      await page
        .getByRole('textbox', { name: 'Project name', exact: true })
        .press('Enter');
      await expect(
        page.getByRole('button', { name: 'Rename project' })
      ).toHaveText('Edited during upload');
      finishUpload();
    }

    if (failFirstUpload) {
      await expect(page.locator('.save-state')).toHaveClass(/is-local-source/);
      await expect(page.locator('.save-state')).toHaveAttribute(
        'title',
        /Click Save to upload/
      );
      await page.locator('.save-state').click();
      await expect.poll(() => uploadAttempts).toBe(2);
    }
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    await expect(page.locator('.file-menu-attention')).toHaveCount(0);
    await expect
      .poll(() =>
        writes.some((doc) =>
          Object.values(doc.nodes).some(
            (node) =>
              node.kind === 'feature' &&
              node.data.featureKind === 'imported-step' &&
              node.data.artifactId === artifact.artifactId
          )
        )
      )
      .toBe(true);
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toHaveText(
      editDuringUpload ? 'Edited during upload' : 'Editable imported cube'
    );
    expect(errors).toEqual([]);
    await expect(page).toHaveTitle(/OpenZCAD/);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('source-sync.png') });
  });
