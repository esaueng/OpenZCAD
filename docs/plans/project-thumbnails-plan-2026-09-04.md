# Project thumbnails: diagnosis and hardening plan (2026-09-04)

## Symptom

Most cards on the start screen show the wire-cube placeholder instead of a
rendered preview. Today's shelf on the beta: 82 projects, one card with an
image. The thumbnail code has taken 12 fix commits across 7 files since 30 July
and the symptom keeps coming back, so this plan targets the structure rather
than another cell of the state matrix.

## What was measured

Reproduced locally against the dev server (signed out, one tab):

1. Create a project. Four seconds after the empty workspace is ready, the
   idle timer in `ProjectThumbnailSyncAgent` writes
   `{ source: null, version: 1 }` to the `projectThumbnails` store.
2. Add a box. The document goes to version 3 and is saved locally.
3. Press the logo within four seconds of the last edit.
4. The shelf shows the placeholder. The store still holds the null record from
   step 1; the summary says version 3.

The same journey with a five-second pause before leaving produces an image,
and a later edit followed by an immediate leave keeps the earlier image, which
is the intended stale-image trade. So the only capture path is a 4 s idle
timer that lives inside the workspace, and the one record that defeats every
later read is the null written during the empty phase.

Why the shelf cannot recover on its own: `PartThumbnail` calls
`loadThumbnail` and then `backfillThumbnail`. The backfill does not render. It
consults the same cache and only answers when `cached.version ===
project.documentVersion`, which a project that moved on can never satisfy. The
prop's doc comment still describes an older design that rendered previews on
the shelf; that design was removed on purpose (large STEP sources must never
be loaded to draw a card), but the comment and the name survived.

## Other placeholder classes (inferred from code, not reproduced)

- **Recovery copies.** Seeding a copy's preview landed in #222 (merged 13:11
  EDT, deployed with #223 at 13:25). The copies from 12:21 predate it. The
  5:11 PM copy most likely came from a tab still running the pre-#222 bundle;
  the seed otherwise writes a record unconditionally. A reload of the beta tab
  settles this.
- **Cloud id mismatch.** `cachedThumbnailSource` rejects a local image when
  the listing's `thumbnailArtifactId` differs from the record's. The loader
  then downloads the listed artifact, and on failure returns `undefined`
  rather than the local image. The Worker deletes superseded thumbnail
  objects on every new upload, so a listing that is one refresh stale points
  at a 404 and the card goes blank even though a good image sits on the
  device.
- **A hung queue.** `queuePartThumbnail` serialises WebGL renders, which is
  right, but `App.backfillThumbnail` runs the cloud upload inside the same
  queue slot. One stalled upload blocks every later render, including the
  recovery-copy seed, which then blocks `writeRecoveryCopy` itself.

## Why it keeps coming back

Three keys (`version`, `updatedAt`, `artifactId`) are compared with three
different rules in three places (`cachedThumbnailSource`, the backfill, the
sync agent). Each incident so far fixed one cell of that matrix. Nothing
covers the actual user journey end to end: the unit tests exercise the helper
functions with hand-built records, and no Playwright spec ever looks at a
card after modelling.

## Plan

### 1. Capture is deterministic: render on leave, not only on idle

New framework-free module `apps/web/src/lib/projectThumbnailCapture.ts`:

- `stage({ projectId, version, updatedAt, bodies })` records what the
  workspace currently shows. Called by the sync agent whenever geometry is
  ready. Keeps the 4 s idle timer as the routine path.
- `flush(): Promise<void>` renders the staged bodies synchronously via
  `renderThumbnailFrame` if that version has not been written yet, then saves
  the record. Idempotent, safe to call with nothing staged.
- The bodies staged are the ones geometry reported ready, keyed by the version
  they belong to, so a leave in the middle of a rebuild writes the last ready
  state under its own version and the next open re-renders.

`App.tsx` awaits `flush()` on every path that leaves the document, next to the
existing document flush: `handleGoHome`, switching projects, the
`pagehide`/`visibilitychange` flush, and before `writeRecoveryCopy` seeds the
copy. The record is on disk before `loadProjectSummaries` runs, so the shelf's
first read sees it.

`ProjectThumbnailSyncAgent` becomes a thin adapter over the module. Cloud
publish stays in the agent but runs after the local record is written and
outside the render queue.

### 2. The null record cannot poison a project

- A null is written only when the capture actually sees no bodies for that
  version. With step 1 the leave flush overwrites the empty-phase null before
  the shelf can read it.
- `cachedThumbnailSource` already sends a null from another version back to
  the backfill; keep that, and add the same rule to the backfill so a stale
  null is a miss everywhere.

### 3. The shelf prefers any image over a placeholder

- `loadThumbnail`: when the cloud download fails, fall back to the local
  record's image. The cloud only upgrades a card, never blanks one.
- One helper, `thumbnailRecordMatches(record, summary)`, becomes the single
  definition of "does this record still describe this listing", used by the
  loader, the backfill, and the sync agent. Its rules go in one table in the
  doc comment.
- Rename `backfillThumbnail` to `publishThumbnail` (or fold it into the
  loader) and fix the comment that claims it renders.

### 4. The render queue only holds renders

Move the upload and IndexedDB writes in `App.backfillThumbnail` out of the
`queuePartThumbnail` slot. With only synchronous renders inside, the queue
cannot hang and the recovery-copy seed cannot block the recovery write.

### 5. Tests that cover the journey

- Unit: capture module (stage then flush renders once; flush with a written
  version is a no-op; flush with no bodies writes null; stage after flush
  re-arms), loader fall-through on download failure, matcher table.
- Playwright `test/e2e/project-thumbnails.spec.ts`: create project, add a box,
  press the logo within one second, expect `.start-tile-thumb img`; reload,
  expect it again; reopen, resize the box, leave immediately, expect the image
  `src` to change. `modeling.spec.ts` already builds boxes in Playwright, so
  this is feasible in CI.

### 6. Existing placeholders

They self-heal: opening a project once and leaving now writes the record on
the way out. No bulk backfill, deliberately, because that would reintroduce
document loads on the shelf. The recovery copies on the beta shelf are dedupe
leftovers from before #223 and can be trashed.

## Diagnostic for the beta tab

Run in the browser console on zcad.app (read-only) to see which class each
placeholder is in. Records with `source: null` and a version behind the
summary are class 1; missing records are recovery copies or a stale tab;
records whose `artifactId` differs from the listing are class 3.

```js
const db = await new Promise((res, rej) => {
  const r = indexedDB.open('openzcad-v2');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const all = (s) =>
  new Promise((res, rej) => {
    const r = db.transaction(s).objectStore(s).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
const th = new Map(
  (await all('projectThumbnails')).map((r) => [r.projectId, r])
);
console.table(
  (await all('projectSummaries')).map((s) => {
    const t = th.get(s.projectId);
    return {
      name: s.name,
      docVersion: s.documentVersion,
      record: t ? (t.source === null ? 'null' : 'image') : 'missing',
      recVersion: t?.version,
      artifactId: t?.artifactId ?? ''
    };
  })
);
db.close();
```
