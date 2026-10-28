# Paired cloud recovery

These operator tools back up the D1 export and every committed R2 reference
together. They are separate from a user's `.openzcad` export and cannot recover
an E2EE account whose user recovery key and devices have all been lost.

Prerequisites: Linux, Python 3.10+, GnuPG 2.2+, a private `/dev/shm` tmpfs,
disabled or encrypted disk swap, and enough free RAM for verified readback.
No Python packages are required. The current implementation supports migrations
0001 through 0044, including the intentional 0035 gap, SQL exports up to 512 MiB,
snapshots up to 4 GiB and individual stored objects up to 100 MiB in both backup
and restore (logical gzip content may be up to 2 GiB). Object metadata is bounded
to 64 MiB before sealing and again during authenticated extraction. It refuses
larger inputs. Review and qualify new schemas before changing those bounds.

## Backup

Keep the operator JSON configuration outside the repository, mode 0600. It names:

- `source`: explicit `account`, `database` UUID and `bucket`.
- `readTokenFile`: an owner-only source read token file.
- `exportTokenCommand`: a command array returning Wrangler's `auth token --json`
  response, using encrypted credential storage. D1 export may require broader
  D1 permission than the source object reader; that credential is used only for
  the fixed export endpoint. The source client refuses SQL query/import, object
  writes/deletes and unrelated endpoints.
- `passphraseCommand`: a command array returning a separately generated random
  backup passphrase of at least 32 bytes from an encrypted secret store.

Commands are trusted local operator configuration. Never put credentials in
these arrays, shell arguments, source files or logs.

```sh
python3 scripts/recovery/cloud.py backup --config /private/operator.json \
  --archive /private/backups/unique-run.gpg
python3 scripts/recovery/cloud.py verify --config /private/operator.json \
  --archive /private/backups/unique-run.gpg
```

The source's [D1 polling export](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
can briefly interrupt database queries. Measure a representative isolated
export and select an authorized service window before a production export.
The export bookmark stays fixed. Required object bodies are fenced by their
ETags and checked against a second metadata inventory. Missing references,
changed metadata, invalid gzip/logical checksums or incomplete migration ledgers
invalidate the entire run. Multipart ETags are not used as content hashes.

SQL, original keys, HTTP/custom metadata and object bodies are staged only in
private tmpfs with encrypted or disabled disk swap. The tool verifies SQL/FKs
and stored-byte hashes, then uses GnuPG AES-256 with authenticated MDC packets.
The passphrase travels on an inherited descriptor. It decrypts and verifies the
complete archive before reporting success; only ciphertext persists to disk.
Use a fresh destination for every attempt. A failed command's output is not a
qualified recovery point.

Preserve the encrypted archive and its SHA-256 receipt in independent storage.
Keep the backup decryption key in a password manager outside the backup host,
and rehearse recovery with that independently held key. Backups may contain
plaintext predating an E2EE migration; expire complete paired runs together.
Do not promise erasure before the documented backup retention expires.

## Disposable restore

Create empty D1 and R2 resources whose names start with
`openzcad-recovery-drill-`. Deploy `restore-worker.mjs` as a private restore
ingress, binding only its `TARGET` R2 bucket, setting `TARGET_BUCKET` to the
same bucket name and storing a new random `RESTORE_TOKEN` as a Worker secret.
The ingress exposes no database or object-read route; uploads require the
secret and use create-only conditions. Never bind it to production.

The private operator configuration additionally supplies `target` (account,
Worker, database name/UUID, bucket, HTTPS origin, ingress Worker/origin,
workers.dev subdomain and target Wrangler config path), `wranglerCommand`
(encrypted-auth command prefix) and `ingressTokenCommand` (encrypted secret
lookup). The restore refuses source and official production resources, checks
provider identities and the actual ingress binding, and requires empty targets.

```sh
python3 scripts/recovery/restore.py --config /private/disposable-drill.json \
  --archive /private/backups/qualified-run.gpg
```

The archive is authenticated and safely extracted before remote writes. The
tool restores the paired SQL and opaque R2 keys/metadata, exports the new D1
again, compares every table's columns and rows, and reads back every R2 body
and its metadata. Failed/partial drills are retained for investigation; retry
with new resources. It never overwrites a source or resumes a partial restore.

Before exposing an application, add a separate private perimeter and disable
outbound integrations and scheduled cleanup. A production SQL copy contains
sessions and capabilities: keep it private until a reviewed target-only
sanitation procedure has run. A real recovery test also needs an unlocked
legitimate client to open encrypted CAD data and an already pinned client to
retain rollback refusal. Byte equality alone is not an application restore.
Start fresh collaboration rooms; these tools do not back up Durable Object
storage or unsynced client edits.

## Operations

The tools do not create credentials, retention policies, production deployments
or scheduled jobs. After the first verified paired backup and private restore,
schedule daily runs with overlap prevention and bounded retries; alert when no
successful run exists within 24 hours. Retain 30 complete daily runs and
rehearse monthly. Use a private, separately administered backup bucket with no
application binding and test its retention lock before relying on it. A same
account copy still shares the account administrator's failure boundary.

```sh
python3 -m unittest discover -s scripts/recovery -p 'test_*.py'
pnpm exec vitest run test/recovery-snapshot.test.ts
```

These tests cover missing objects, SQL/metadata/ciphertext changes, incomplete
runs, gzip integrity, unsafe archive members, source endpoint restrictions,
restore target isolation, authenticated ingress and create-only writes.
