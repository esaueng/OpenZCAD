import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import worker, {
  type RestoreEnvironment
} from '../scripts/recovery/restore-worker.mjs';

it('verifies paired recovery snapshots, encrypted readback and refusal boundaries', () => {
  const output = execFileSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', 'scripts/recovery', '-p', 'test_*.py'],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  expect(output).toBe('');
}, 35_000);

const token = 'synthetic-restore-token-0123456789-0123456789-0123456789';
const metadata = {
  key: 'nested/../opaque-key',
  size: 4,
  storage_class: 'InfrequentAccess',
  http_metadata: { contentType: 'application/example' },
  custom_metadata: { fixture: 'true' }
};
function request(headers: Record<string, string> = {}, method = 'PUT') {
  return new Request('https://drill.example/restore', {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      'content-length': '4',
      'x-openzcad-metadata': encodeURIComponent(JSON.stringify(metadata)),
      ...headers
    },
    ...(method === 'GET' ? {} : { body: 'data' })
  });
}
function environment(
  put: RestoreEnvironment['TARGET']['put']
): RestoreEnvironment {
  return {
    TARGET_BUCKET: 'openzcad-recovery-drill-test',
    RESTORE_TOKEN: token,
    TARGET: { put }
  };
}
it('refuses access and production targets before any storage side effects', async () => {
  let calls = 0;
  const target = environment(async () => {
    calls++;
    return {};
  });
  expect(
    (await worker.fetch(request({ authorization: 'Bearer wrong' }), target))
      .status
  ).toBe(404);
  expect((await worker.fetch(request({}, 'GET'), target)).status).toBe(404);
  expect(
    (
      await worker.fetch(request(), {
        ...target,
        TARGET_BUCKET: 'openzcad-beta-artifacts'
      })
    ).status
  ).toBe(503);
  expect(calls).toBe(0);
});
it('restores the original opaque key and metadata only with create-only storage', async () => {
  let calls = 0;
  const target = environment(async (key, body, options) => {
    calls++;
    expect(key).toBe(metadata.key);
    expect(await new Response(body).text()).toBe('data');
    expect(options).toEqual({
      onlyIf: { etagDoesNotMatch: '*' },
      storageClass: metadata.storage_class,
      httpMetadata: metadata.http_metadata,
      customMetadata: metadata.custom_metadata
    });
    return {};
  });
  expect((await worker.fetch(request(), target)).status).toBe(201);
  expect(calls).toBe(1);
  expect(
    (
      await worker.fetch(
        request(),
        environment(async () => null)
      )
    ).status
  ).toBe(409);
});
it('refuses malformed, mismatched and oversized restore input', async () => {
  let calls = 0;
  const target = environment(async () => {
    calls++;
    return {};
  });
  const cases: Array<Record<string, string>> = [
    { 'x-openzcad-metadata': 'broken' },
    { 'content-length': String(101 * 1024 ** 2) },
    { 'content-length': '5' },
    {
      'x-openzcad-metadata': encodeURIComponent(
        JSON.stringify({ ...metadata, storage_class: 'unknown' })
      )
    },
    {
      'x-openzcad-metadata': encodeURIComponent(
        JSON.stringify({ ...metadata, storage_class: undefined })
      )
    },
    {
      'x-openzcad-metadata': encodeURIComponent(
        JSON.stringify({ ...metadata, key: 'bad\0key' })
      )
    }
  ];
  for (const headers of cases)
    expect((await worker.fetch(request(headers), target)).status).toBe(400);
  expect(calls).toBe(0);
});
