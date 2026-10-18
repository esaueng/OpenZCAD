import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, toProjectId } from '@openzcad/shared';
import { sanitizeStepHeaderPrivacy } from '@openzcad/io-step';
import {
  runStepImport,
  localStepImportSourceStore
} from '../apps/web/src/lib/stepImportRun';
import { createInFlightImportChecksums } from '../apps/web/src/lib/importArchival';
import {
  archiveArtifact,
  type ArchiveArtifactTransport
} from '../apps/web/src/lib/archiveArtifact';

const original =
  "ISO-10303-21;\nHEADER;\n/* FILE_NAME('decoy','',(),(),'','',''); */\nFILE_NAME('/private/workspaces/example/model.step','2026',('Example author'),('Example org'),'','','');\nENDSEC;\nDATA;\n#1=PRODUCT('Useful model label','',(),());\nENDSEC;\nEND-ISO-10303-21;";
const expected = sanitizeStepHeaderPrivacy(original, 'model.step');

describe('ordinary STEP source privacy at persistence boundaries', () => {
  it.each(['ready', 'unavailable'] as const)(
    'stores, inspects, embeds and uploads the same sanitized bytes with storage %s',
    async (readiness) => {
      const checksum = createHash('sha256').update(expected).digest('hex');
      const project = createProjectDocument(
        'Import privacy',
        toUserId('user_test')
      );
      let uploaded: Blob | undefined;
      const transport = {
        createUploadSession: vi.fn(async () => ({
          session: {
            uploadSessionId: 'upload_test',
            artifactId: 'artifact_test',
            uploadUrl: 'https://upload.test/source'
          }
        })),
        uploadArtifact: vi.fn(async (_url: string, body: Blob) => {
          uploaded = body;
        }),
        finalizeArtifact: vi.fn(async () => ({ artifactId: 'artifact_test' })),
        getArtifactMetadata: vi.fn(async () => ({ artifact: null }))
      } as unknown as ArchiveArtifactTransport;
      const put = vi.fn(async (blob: Blob) => {
        expect(await blob.text()).toBe(expected);
        expect(
          createHash('sha256')
            .update(new Uint8Array(await blob.arrayBuffer()))
            .digest('hex')
        ).toBe(checksum);
        return {
          created: true,
          ref: {
            marker: 'openzcad-source-ref' as const,
            version: 1 as const,
            hashAlgorithm: 'sha256' as const,
            checksumSha256: checksum,
            logicalBytes: new TextEncoder().encode(expected).length
          }
        };
      });
      const inspect = vi.fn(async (file: File) => {
        expect(await file.text()).toBe(expected);
        return [0];
      });
      const release = vi.fn();
      const result = await runStepImport({
        file: new File([original], 'model.step', { type: 'model/step' }),
        contentType: 'model/step',
        store: {
          ...localStepImportSourceStore,
          ensureLocalProjectStorage: async () => readiness,
          putSourceBlobIfAbsent: put,
          releaseSourceBlobClaim: async () => {}
        },
        inspectSolids: inspect,
        archive: (input) =>
          archiveArtifact(transport, toProjectId('project_test'), input),
        validatedFeature: {
          reserve: () => ({ release }),
          run: async (command, options) => {
            const candidate = command.apply(project);
            const serialized = JSON.stringify(candidate);
            expect(serialized).not.toContain('/private/workspaces');
            if (readiness === 'ready') expect(serialized).toContain(checksum);
            else expect(serialized).toContain('Useful model label');
            await options.finalize!();
            return 'committed';
          }
        },
        status: { setStatus() {}, setFeatureFormError() {} },
        marks: {
          inFlight: createInFlightImportChecksums(),
          abandoned: new Set()
        },
        currentDocument: () => project,
        editDisabledReason: () => null,
        newId: () => crypto.randomUUID()
      });
      expect(result.outcome).toBe('committed');
      expect(put).toHaveBeenCalledTimes(readiness === 'ready' ? 1 : 0);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(uploaded).toBeDefined();
      expect(await uploaded!.text()).toBe(expected);
      expect(transport.finalizeArtifact).toHaveBeenCalledTimes(1);
      expect(expected.slice(expected.indexOf('DATA;'))).toBe(
        original.slice(original.indexOf('DATA;'))
      );
      // This is filename/path sanitization, not anonymization of model metadata.
      expect(expected).toContain('Example author');
    }
  );
});
