# Download your data

Roadmap: L01. Settings → Privacy & data → Download all data prepares a ZIP on
the user's device. Signed-out and offline users can export device data. A
signed-in user with cloud features enabled also gets their account data and
all projects currently readable by that account.

The ZIP contains:

- `manifest.json`, mapping project IDs to separately preserved local and cloud
  `.openzcad` backups. Extract and import a backup from the projects screen to
  open an independent copy. The ZIP itself is not an account-restore format.
- An optional readonly snapshot of every record in the local project database, including
  sources, measurements, thumbnails, recovery copies, save states, shelf state
  and identity mappings. Binary records use explicit paths into `device/binary`.
- Device settings, saved views, selected UI preferences, assistant history and
  the current diagnostic report. An explicit preference allowlist excludes
  unrelated origin storage and credentials.
- Cloud profile, stored settings, consent, session metadata, collaboration
  records and stored workspace/measurement records. Credential values, session
  and invitation/share tokens, token hashes and private encryption keys are
  excluded by explicit server-side projections.
- Readable project backups, source files and archived exports, plus retained
  cloud revisions that are no longer named by a current checkpoint. Archive
  and Trash are included while the underlying project remains retained.

Encrypted project contents use the existing verified browser readers and blob
decoder. Their exported copies are unencrypted. A locked device must unlock
its keys first; server-side decryption and key export are not involved.

Project backups always carry the canonical STEP sources, mesh payloads and
reference-image pixels needed to reopen and rebuild the current model, undo
history and retained save states. Legacy embedded imports are externalized in
the exported copy using the existing source-reference format; the live project
is unchanged. A checksum identifies one source payload across those snapshots.
STEP sources are no longer repeated as original files in `files` as well as
`sources`, including when original files were explicitly requested.

**Include original import files** is off by default. Enable it to add optional
original interchange files to the portable project backups. It never controls
whether rebuild data is included. **Include extra device recovery data** stays
on by default; turning it off skips the optional raw device database snapshot
for a smaller, faster download. That snapshot can contain original files held
on this device independently of the project-backup option. The manifest records
both choices (`originalImportFilesInBackups` and `deviceSnapshotRequested`),
and the README explains them.

The existing 256 MiB project-backup bound remains. The ZIP is capped at
512 MiB, including duplicate local/cloud copies and the raw device snapshot.
Projects can be downloaded individually with File → Export project after
opening them, subject to the same per-project bound.
The archive uses ZIP stored entries through `fflate` 0.8.3, already used by
other workspace packages and now a direct, lazy-loaded web dependency.

Unavailable, unreadable or oversized project copies are skipped while later
projects are still attempted. Each project is staged with its retained history
before adding any of its files to the ZIP, so a failure leaves no incomplete
project folder and spends no archive space. Portable project backups take
priority over the optional raw device snapshot. If that snapshot cannot fit or
be read, its entire section is omitted and reported.
Capacity checks budget both staged bytes and their ZIP output alongside the
existing archive. Before each project or retained revision is built, its
remaining byte budget also leaves conservative headroom for source/base64
data, JSON serialization/validation and UTF-8 encoding. The builder checks
source sizes before reading their bytes. Bulk downloads can therefore omit a
project or raw snapshot even when its payload alone would fit the ZIP; an
individual project export keeps its existing 256 MiB bound. Staged input
references are released as entries are written, and completed backup strings
and parsed history data do not remain in scope while the next revision builds.

The completion screen lists every skipped project's name, ID, local/cloud copy
and reason, with instructions to open the project and choose File → Export
project. The same list is in `NOT-INCLUDED.txt` and `manifest.json` in the ZIP,
along with any omitted data sections. Space is reserved for the report even
when the archive fills up; ZIP entry overhead counts toward the size limit.
A download with no successful project backups still includes available
settings/account data and the omissions report. A skipped portable backup may
still have raw device records or account metadata in the ZIP; the manifest
identifies the complete backups that were included.

Account changes, failed account discovery and ZIP errors still cancel the
download. Nothing is saved, adopted, purged or overwritten by the exporter.
Other devices' unsynced data, expired/deleted data, encryption key
stores, transient collaboration traffic and operational/security logs are
outside this archive. Cloud readers run sequentially; changes during export
can require a retry and are not a transaction spanning device and server.
Within a project, independent revision/file catalog reads overlap. The file
catalog is reused across its backups, and retained-save coverage is collected
while building each backup instead of parsing its completed JSON again.
Source preparation drops derived geometry before cloning; it never copies a
large rendered mesh only to discard it. Capacity checks and per-project atomic
staging remain in force.

Coverage: `dataExport.test.ts` unzips and parses backups, verifies source bytes,
Trash, local/cloud separation, unlinked revisions, account changes, size
reservation and failure/retry. `projectBackupTransfer.test.ts` covers encrypted
source and export bytes. `DataDownload.test.tsx` covers progress and retry.
`test/account-export.test.ts` uses the real migrated schema and verifies account
scoping, secret exclusion, authentication, origin checks and cache headers.
`test/e2e/data-download.spec.ts` downloads the actual ZIP at desktop and mobile
widths. Live production verification remains separate.
