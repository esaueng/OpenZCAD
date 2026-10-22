# OpenZCAD privacy policy (draft)

> **Draft for review. Not published.** The owner and a legal reviewer must
> approve this text before it is published or linked from the app. It is not
> legal advice. It describes what the code on `main` does as of 2026-10-20;
> re-check every statement against the code before publishing.
>
> Placeholders look like `[OPERATOR LEGAL NAME]`. Notes for reviewers look
> like this block and are removed before publishing.

## Open questions for the owner

Every item below needs an answer before publication. None of them can be
read from the code.

1. **Operator.** The legal entity that runs the hosted service:
   `[OPERATOR LEGAL NAME]`, `[REGISTERED ADDRESS]`, `[COMPANY NUMBER, IF ANY]`.
2. **Contact.** A privacy contact address for requests and complaints:
   `[PRIVACY CONTACT EMAIL]`. The app has no privacy contact today. If GDPR
   or UK GDPR applies, also `[EU/UK REPRESENTATIVE, IF REQUIRED]` and
   `[DATA PROTECTION OFFICER, IF REQUIRED]`.
3. **Jurisdiction.** `[GOVERNING LAW]` and the audiences the service is
   offered to (EU/EEA, UK, US states with privacy laws, elsewhere). This
   decides which rights sections stay, the lawful bases in section 4, the
   response deadline in section 12 and the transfer wording in section 15.
4. **Service address.** `[SERVICE URL]`: the hosted origin(s) this policy
   covers, and whether the macOS desktop app is distributed under the same
   operator.
5. **Sub-processors.** Confirm the list in section 10, the regions each one
   uses, and that a data processing agreement is in place with each. Known
   from the code: Cloudflare (hosting, database, file storage, collaboration
   rooms, email sending, Turnstile, logs) and OpenRouter plus whichever model
   provider it routes to (today a free MiniMax model). OpenAI appears only if
   the deployment is configured for it.
6. **Cookies.** The app sets one sign-in cookie (section 9). Confirm whether
   Cloudflare Web Analytics is enabled on the hosted zone: the content
   security policy allows its script and beacon, but the app code never
   loads it. Confirm what Turnstile stores on the sign-in page, and whether
   a cookie notice is needed in the target jurisdictions.
7. **Retention that the code does not set.** Confirm or decide:
   - the D1 Time Travel and Durable Object point-in-time recovery windows on
     the account's plan (the design record assumes up to 30 days);
   - whether R2 has versioning, lifecycle rules or any backup copy;
   - Workers Logs retention and fields (observability is on with 100%
     sampling);
   - whether any manual database exports exist, where, and for how long;
   - retention by Cloudflare's email service of sent messages;
   - assistant usage counters, which the code never deletes except on
     account deletion;
   - the server secret that lists manually granted Premium email addresses.
8. **Lawful basis for Basic statistics.** Aggregate API request counts are
   collected without a consent prompt (section 8). Confirm the basis, as
   [docs/glimpse.md](../glimpse.md) asks before enabling collection.
9. **Minimum age.** `[MINIMUM AGE]`.
10. **Requests.** How requesters are verified, the response deadline, and
    how to handle requests from collaborators about shared projects.
11. **Changes.** How users learn about changes to this policy (in-app
    notice, email, changelog), and the effective date.

---

## 1. Who we are

OpenZCAD is a browser-first CAD application. This policy covers the hosted
OpenZCAD service at `[SERVICE URL]` and the OpenZCAD desktop app when it is
signed in to that service. The service is run by `[OPERATOR LEGAL NAME]`
("we"). Contact us at `[PRIVACY CONTACT EMAIL]`.

If you use an OpenZCAD instance that someone else runs, this policy does not
apply to it. See [section 14](#14-self-hosted-deployments).

## 2. Summary

- You can use OpenZCAD without an account. Your projects then stay in your
  browser and never reach us.
- If you sign in, we store your email address and, by default, your projects,
  so they sync between your devices and you can share them.
- **Your cloud projects are not end-to-end encrypted today.** They are stored
  in readable form on Cloudflare, which encrypts its disks. We, and anyone who
  gains control of our Cloudflare account, can read them. End-to-end
  encryption is planned; it is not available yet.
- The AI assistant sends your request and a summary of your model to an
  outside AI provider, which may keep it or train on it.
- Optional analytics are off until you turn them on, and contain no
  identifiers or model contents.
- You can delete your cloud projects, your profile, or both from Settings.
  Deleted data may remain in recovery copies or exports. Their retention
  windows must be confirmed before this draft is published (section 11).
- We do not sell your data and show no advertising.

## 3. Using OpenZCAD without an account

OpenZCAD runs in your browser. Modeling, imports, exports, drawings and
thumbnails are computed on your device. Without an account, everything you
make is stored only in your browser's storage (IndexedDB and local storage):

- projects, their full feature history and undo history;
- imported files (STEP, STL, 3MF, OBJ, glTF and PLY) and meshes;
- settings, saved views, panel layout and recovery copies;
- your AI assistant conversation history.

We do not receive this data unless you use a cloud feature described below.
Active local projects stay until you move them to the Trash or clear the
browser's site data. Local Trash entries become eligible for automatic,
permanent deletion after 30 days, on a later start-screen refresh, subject to
cloud-reconciliation deferrals in section 11. This deletes the main local
project copy; separate interaction diagnostics can retain a rebuildable copy
as described below. Anyone with access to your device or browser profile can
read this local data.

**Local interaction diagnostics.** Direct edits, including attempted edits,
automatically record diagnostic details and, for supported native parametric
models, a sanitized but rebuildable project document in a separate browser
IndexedDB database. Captures for documents with imported STEP or mesh
geometry omit the project document. These copies are
not removed by deleting the project or purging its Trash entry. They stay
until newer diagnostic captures evict them or you clear the browser’s site
data. The store keeps the newest 40 entries and targets 8 MiB, but always
retains its newest entry even when that entry alone exceeds 8 MiB. There is
no time-based expiry or in-app clearing control for these diagnostic copies.
The capture is local; it is not automatically sent to the hosted service.

**Cloud features switch.** Settings → Account → Cloud features is the master
switch for this device’s sign-in, sync, sharing, the AI assistant and optional
browser analytics. It is on by default. Turning it off leaves any separate
account-wide statistics grant active until you withdraw it or it expires, so
hourly account census collection can continue. It does not currently block or
abort every file transfer: rebuilding a cloud part can still start or
continue an authenticated download of an imported STEP or mesh source that
is missing from the local cache. Your browser also still downloads the app
itself from our servers, and Cloudflare processes that traffic (section 10).

**`.openzcad` files.** Export project writes a backup file to your device. We
do not receive it. It is not encrypted.

## 4. What we collect, and why

This table lists what the hosted service stores. How long each item is kept
is in [section 11](#11-how-long-we-keep-data).

| What                     | Details                                                                                                                                                                                                                                                                       | Why                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Email address            | The address you sign in with. Your account ID is computed from it. Your display name is the part before the `@`.                                                                                                                                                              | Sign-in, sharing, deletion confirmation                   |
| Sign-in codes            | A six-digit code sent by email, stored only as a keyed hash, with its attempt count. It works once and expires after 10 minutes.                                                                                                                                              | Sign-in, preventing code guessing                         |
| Sessions                 | A random session token in a cookie; we store only its hash. Desktop access- and refresh-token hashes are stored with session, account and client IDs, creation/expiry times, and revocation or rotation times. The desktop app keeps its refresh token in the macOS Keychain. | Keeping you signed in                                     |
| Desktop sign-in attempts | Attempt ID, hashed state and user code, PKCE challenge, client ID, associated account ID after approval, and creation, expiry, approval and exchange times.                                                                                                                   | Connecting the desktop app to your account                |
| Abuse protection         | Cloudflare Turnstile checks the sign-in form; we pass your IP address to that check. Rate limits count requests under keyed hashes of your email address and of your IP address. We do not store your IP address itself.                                                      | Preventing spam and account attacks                       |
| Projects                 | Each project's full document: name, units, parameters, sketches, text and feature history. Saved revisions with their names, reasons and author. Imported source files, meshes, thumbnails and exports you choose to keep in the cloud.                                       | Sync between your devices, history, sharing               |
| Unfinished file uploads  | Upload-session and artifact IDs, project/account IDs, filename, content type, file metadata, object-storage key and reservation or multipart-upload state, plus any bytes already received.                                                                                   | Completing uploads and reclaiming abandoned storage       |
| Deletion coordination    | Account ID, requested deletion scope, and start/update timestamps in a resumable erasure request.                                                                                                                                                                             | Completing deletion safely and refusing concurrent writes |
| Project details          | Measurements, workspace view state per device (camera, hidden and selected bodies, mode, panels) with a random device ID and a Desktop or Mobile label, shelf state (pinned, archived, in the Trash), sizes and counts used for storage quotas.                               | Restoring your workspace, quotas                          |
| Sharing                  | Members and their roles, invitations (the invitee's email address, role, inviter and expiry), share links and a history of sharing changes (who changed which role, when).                                                                                                    | Collaboration and access control                          |
| Live collaboration       | While a project is open with others, a collaboration room relays edits and shows who is active or idle. It keeps the latest document and up to 20 earlier snapshots.                                                                                                          | Real-time editing                                         |
| Synced settings          | Your application preferences, so they follow you between devices.                                                                                                                                                                                                             | Consistent settings                                       |
| Personal AI key          | If you add your own AI provider key, we store it encrypted (AES-GCM, under a server-held key) with a short hint so you can recognise it. It is the only data the application encrypts itself.                                                                                 | Calling your chosen provider                              |
| Assistant usage          | Per-account request and cost counters, and a service-wide daily total.                                                                                                                                                                                                        | Fair-use limits and cost control                          |
| Error logs               | Our own log lines record event names, error types, request paths and request IDs. They are written to exclude email addresses, project contents and IP addresses.                                                                                                             | Diagnosing failures                                       |

> **Reviewer note.** Add the lawful basis for each row once the jurisdiction
> is settled (likely contract for account and project data, legitimate
> interests for abuse protection and logs).

**Emails we send.** Sign-in codes go to your address. When you invite someone,
the invitation email shows them **your email address and the project name**.
We send no marketing email.

**When projects reach the cloud.** When you are signed in with cloud features
on, projects you create are saved to your account, and cloud autosave keeps
the account copy updated (Settings → Saving → Cloud autosave). Turning autosave
off stops those automatic account saves; you can still save a revision.

Live collaboration is a separate setting. For an open cloud project, leaving
Collaboration enabled (the default) sends document edits to its collaboration
room, even when Cloud autosave is off and even when nobody else is present.
The room keeps its own readable document and snapshots. Turn Collaboration
off too if you do not want that live synchronization. Turning Cloud features
off stops this device’s listed cloud paths, subject to the imported-source
download and account-wide statistics exceptions in section 3; it does not guarantee that the device makes no
OpenZCAD API requests. A project you made while signed out stays on that
device until you choose to add it to your account.

> **Reviewer trace (2026-10-22).** `App.tsx` admits a cloud project's room
> independently of `files.cloudAutosave`; `useCollaboration.ts` sends changed
> document versions after a 500 ms debounce. The account autosave and room
> synchronization paths must be rechecked separately before publication.

## 5. How cloud data is stored today

Cloud data is held on Cloudflare: account and project records in a D1
database, project files in R2 object storage, and live collaboration state in
Durable Objects. Connections use HTTPS.

**OpenZCAD does not encrypt your project data itself.** Project documents,
revisions, imported files, meshes, thumbnails, names and measurements are
stored in readable form. Cloudflare encrypts its stored data at rest, which
protects against lost or stolen disks. It does not protect against:

- the operator, or anyone who gains control of the operator's Cloudflare
  account, the server code or its access tokens;
- Cloudflare staff with access to the stored data;
- legal demands for stored data.

The server reads project documents to check them, convert old formats, merge
live edits, build share links and write invitation emails.

What we do protect beyond Cloudflare's encryption: sign-in codes and session
and invitation tokens are stored only as hashes, and personal AI keys are
encrypted by the application.

## 6. Planned end-to-end encryption

End-to-end encryption for cloud projects is **planned, and not available
today**. Its design is public in the repository
([ADR-024](../adrs/ADR-024-end-to-end-encrypted-projects.md)). We will update
this policy before we describe any project as end-to-end encrypted, and we
will say exactly what is encrypted, from when, and for whom.

Even after it ships, the design says the server will still see some
information, including email addresses, member lists and roles, project and
revision counts, file sizes, timestamps and when you are active in a shared
project. The AI assistant will still need to send your request and model
summary to the provider in readable form, and will ask first.

## 7. The AI assistant

The assistant runs only when you send it a request. It needs cloud features on
and an account; on the hosted service it is available to signed-in accounts.

**What is sent.** For each request, our server forwards to the AI provider:

- your prompt and the earlier turns of the conversation;
- a compact summary of the open model: project name, units, parameters,
  feature names and settings, body names, volumes, bounding boxes and a
  topology summary;
- your current selection;
- any drawings or images you attach.

Raw imported STEP files and meshes are not sent.

**Who receives it.** The built-in assistant on the hosted service uses
OpenRouter, which routes the request to a model provider (today a free model
from MiniMax). **OpenRouter and the model provider may keep this data, or use
it for training and service improvement, under their own policies.** Free
models are more likely to do so. Do not send sensitive or confidential designs
to the assistant. Settings → AI Assistant shows which provider applies and links to its
policy.

If you add your own API key, requests go through our server to the provider
and model you chose, under that provider's terms, data policy and charges.

**What we keep.** We do not store your prompts, conversations or the model's
replies on the server. Your conversation history stays in your browser. We
send the provider a pseudonymous identifier derived from your account ID with
a secret key, not your email address, so it can detect abuse. We keep usage
counters (section 4).

## 8. Analytics

There are three levels. None of them includes model contents, geometry, file
names, project names, email addresses, IP addresses, URLs, error text, account
IDs or device identifiers.

**Basic statistics (always on for the hosted service).** The server counts API
requests, server errors and response times in fixed ranges. These are
aggregate daily counters with no per-person record. They exclude health checks
and static files.

**Optional usage analytics (off unless you opt in).** Turn them on in
Settings → Privacy & data → Optional usage analytics. Your choice applies to
that browser only and is never linked to your account. When on, the app sends
fixed event names with fixed value ranges, such as which kind of feature was
used, size ranges and timing ranges. Browser "Do Not Track" and Global Privacy
Control signals switch them off. The desktop app never sends them. You can
turn them off at any time; sending stops immediately.

**Cloud account statistics (off unless you opt in).** In Settings → Privacy &
data you can allow aggregate counts of your account's projects (including
retained Trash), revisions and known stored bytes to be included in hourly
service-wide snapshots. This account-wide permission lasts 30 days and can be
withdrawn sooner with the same checkbox. The published aggregate snapshots
remain for up to 90 days; the permission window is not their retention period.
Turning this device’s Cloud features switch off or enabling browser DNT/GPC
does not withdraw the account-wide grant. The consent record contains your
account ID and expiry time; expiry stops census inclusion but does not delete
the record. It remains until you explicitly withdraw consent or delete the
full account. Profile-only deletion keeps the account row and this record.

Analytics go to Glimpse, our own analytics service, which runs on Cloudflare.
Basic statistics and optional usage analytics use daily aggregate counters,
with no raw events. Cloud account statistics use the separate hourly aggregate
snapshots described above. Totals already received cannot be traced to you,
so they cannot be removed after you withdraw.

> **Reviewer trace (2026-10-22).** `CloudStatisticsConsent` in
> `AnalyticsConsent.tsx` distinguishes the hourly snapshots, 30-day permission
> and up-to-90-day published retention; `docs/glimpse.md` describes the hourly
> census publication path.

## 9. Cookies and browser storage

**Cookies.** The app sets one cookie, `__Host-openzcad_session`, when you sign
in. It keeps you signed in, is sent only to our server over HTTPS, cannot be
read by page scripts, and expires after 30 days or when you sign out. We use
no advertising or cross-site tracking cookies.

The sign-in form loads Cloudflare Turnstile, which checks that a person is
signing in. Cloudflare processes information about your browser and network
for that check under its own terms. `[CONFIRM: what Turnstile stores; whether
Cloudflare Web Analytics is enabled on the hosted zone.]`

**Browser storage.** The app stores your local projects and files in
IndexedDB, and settings, your analytics choice, the cloud features switch,
saved views, panel layout, a random device ID for workspace sync and your
assistant conversation history in local storage. This data stays on your
device unless a cloud feature described above sends part of it. An invitation
link's unhashed access token may also be held in tab-scoped `sessionStorage`
while you sign in. Page scripts can read it. It stays until the app clears it
or the browser tab session ends; the token is removed from the address
fragment when captured.

Live collaboration also creates a random client identifier in
`sessionStorage` and includes it in collaboration messages. Page scripts can
read it, and the app reuses it for the browser tab session.

## 10. Who else sees your data

We do not sell personal data, and we do not share it for advertising.

**People you share with.**

- Members you invite see the project, its history and who else is in it. An
  invitation email shows the invitee your email address and the project name.
- **Anyone who has a share link can open the project without an account**, in
  Tweak or View mode, for 30 days after its server-assigned creation time,
  or until you revoke it earlier. This expiry also applies to existing links.
- In a live session, other members see when you are active or idle.

**Service providers** that process data for us:

| Provider                      | What it does                                                                                                 | Data                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Cloudflare                    | Hosting, network, database, file storage, collaboration rooms, sign-in and invitation email, Turnstile, logs | Everything the hosted service stores or receives, including IP addresses in transit |
| OpenRouter and model provider | Built-in AI assistant                                                                                        | Assistant requests (section 7)                                                      |
| `[OTHER, IF ANY]`             | `[ROLE]`                                                                                                     | `[DATA]`                                                                            |

**Legal reasons.** We may disclose data if the law requires it. Because cloud
projects are not end-to-end encrypted today, we are able to read stored
projects in response to a valid legal demand. `[OWNER: describe how such
requests are handled and whether users are notified.]`

## 11. How long we keep data

| Data                                | How long                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active local projects and settings  | Until you delete them or clear your browser's site data; moving a project to the Trash starts the separate retention window below                                                                                                                                                                                                                                                                                                               |
| Local projects in the Trash         | Eligible for permanent deletion after 30 days, on a later start-screen refresh. When that refresh reconciles cloud copies, an unavailable cloud listing defers local purging, and failed organization updates exclude the affected projects. Without a later successful refresh, entries can remain longer                                                                                                                                      |
| Local interaction diagnostics       | Direct-edit captures can include a sanitized, rebuildable native parametric project document; captures of imported STEP/mesh documents omit it. Kept separately after project deletion or Trash expiry until later captures evict them or browser site data is cleared. Newest 40 entries and an 8 MiB target, with the newest entry retained even if it alone exceeds the byte target. No time-based expiry or in-app clearing control         |
| Workspace sessions                  | Saved camera, selection, device/session identifiers and workspace state are hidden from session listings after 30 days without an update. That cutoff does not delete rows. A later workspace save prunes to the newest 20 sessions per account/project, regardless of age; otherwise records can remain until project deletion or profile/full-account cleanup                                                                                 |
| Deletion coordination records       | Removed after the requested erasure successfully completes. Failed/incomplete erasure requests retain account ID, scope and start/update timestamps for retry; no scheduled expiry, so they may remain indefinitely                                                                                                                                                                                                                             |
| Cloud projects                      | Until you delete them                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Projects in the Trash               | Eligible for permanent deletion, with their files, revisions and room, after 30 days. Project-list requests purge at most 100 eligible projects per pass; a backlog needs later requests, and without a return visit they may remain indefinitely                                                                                                                                                                                               |
| Saved revisions                     | Normally pruned to the newest 50 after a save. Pruning failures do not fail the save and are retried only on a later save; without one, older revisions can remain indefinitely                                                                                                                                                                                                                                                                 |
| Unfinished file uploads             | Sessions expire after 15 minutes. Expiry does not itself delete their records or received bytes. Hourly cleanup selects at most 100 eligible sessions per pass; starting another upload can also trigger bounded cleanup for that account. Failed storage cleanup keeps the indexed session for retry, so backlogs or repeated failures can retain data beyond expiry                                                                           |
| Collaboration room                  | The latest document and up to 20 earlier snapshots, for the life of the project                                                                                                                                                                                                                                                                                                                                                                 |
| Sign-in sessions                    | Valid for 30 days, unless you sign out earlier. Expired server rows become eligible for traffic-triggered cleanup; expiry is not a deletion deadline                                                                                                                                                                                                                                                                                            |
| Desktop sign-in attempts            | Valid for 10 minutes. Expired records become eligible for bounded cleanup on a later desktop-authorization start; without later traffic they can remain indefinitely                                                                                                                                                                                                                                                                            |
| Desktop access and refresh tokens   | Access tokens are valid for 15 minutes; refresh tokens use the configured sign-in session lifetime (30 days by default) and rotate on refresh. Revocation or rotation ends use, but does not itself delete their records. Expired records become eligible for bounded cleanup on a later desktop-authorization start and can otherwise remain indefinitely. A request using an expired access token can delete that access-token record earlier |
| Sign-in codes                       | Valid once for 10 minutes. The hashed record becomes eligible for cleanup 24 hours after expiry; bounded, traffic-triggered cleanup can retain it longer                                                                                                                                                                                                                                                                                        |
| Rate-limit counters                 | Eligible for cleanup after two of the longest shared-table windows have elapsed from the window start (currently two hours); removed in bounded, traffic-triggered passes                                                                                                                                                                                                                                                                       |
| Invitations and sharing history     | Invitation records remain for the life of the project or until the relevant account is deleted. Sharing audit history keeps only the newest 1,000 events per project; each new event removes older entries beyond that cap                                                                                                                                                                                                                      |
| Share links                         | Access expires 30 days after server-assigned creation, including existing links, or ends when revoked earlier. Expiry alone does not delete the record. The newest 100 revoked-link records per project retain token hashes, creators and timestamps; newer revocations prune older records. Unrevoked expired records can remain for the life of the project. Project or relevant account deletion can remove records earlier                  |
| Assistant usage counters            | Until your account is deleted `[OWNER: decide a shorter period]`                                                                                                                                                                                                                                                                                                                                                                                |
| Cloud account statistics permission | Permission lasts 30 days or until withdrawn; the account-ID/expiry record can remain indefinitely after expiry. Removed on explicit withdrawal or full account-row deletion, but not profile-only deletion                                                                                                                                                                                                                                      |
| Published cloud account statistics  | Hourly aggregate snapshots remain for up to 90 days, independently of the 30-day permission                                                                                                                                                                                                                                                                                                                                                     |
| Logs                                | `[CONFIRM: Workers Logs retention]`                                                                                                                                                                                                                                                                                                                                                                                                             |

**Cleanup timing.** Validity limits and cleanup eligibility do not promise a
deletion time. Authentication cleanup runs when a later email sign-in or
desktop-auth start reaches it, deleting at most 100 eligible rows from each
of the challenge, session and rate-limit tables per pass. API rate-limit
cleanup also depends on later requests and removes at most 100 eligible
counters per pass. If the relevant traffic never returns, expired records can
remain indefinitely; even with traffic, a backlog may need multiple passes.
Signing out removes the current session token separately. Trash cleanup is also
request-triggered and bounded: more than 100 eligible projects can require
multiple project-list requests to purge.

Desktop-authorization starts separately remove at most 100 expired records
from each of the desktop-attempt, access-token and refresh-token tables per
pass. A backlog requires more starts; validity, rotation and revocation are
not guaranteed deletion times.

> **Reviewer trace (2026-10-22).** `cleanExpiredAuthRows` in `auth.ts` and the
> sweep in `apiRateLimit.ts` define eligibility and bounded cleanup. They do
> not schedule a guaranteed purge.

**Backups.** Cloudflare D1 Time Travel and Durable Object recovery may retain
point-in-time copies after live data is deleted. The design assumes windows
of up to 30 days, but the actual plan windows have not been verified. R2
versioning, lifecycle rules, backup copies and manual exports are also
unconfirmed. There is therefore no verified maximum across all recovery
paths in this draft. `[CONFIRM before publication: each recovery mechanism,
its configured window, retained exports, and the incident-restore process for
deleted personal data.]`

## 12. Deleting your data and your rights

**Delete in the app.** Signed in, open Settings → Privacy & data → Delete
cloud data. Each choice asks you to type your email address to confirm.

- **Delete all cloud projects.** Every project you own, with its revisions,
  files and collaboration room. Your profile stays.
- **Delete cloud profile.** Your email address, synced settings, personal AI
  key, sessions, and invitations sent to your address. Your
  projects stay in the cloud under your account ID, with no email address
  attached. Because the account ID is computed from your email address,
  signing in again with the same address reconnects you to those projects.
  To remove them too, use the next option.
- **Delete all cloud data.** Your profile and every project you own.
  Collaborators lose access to your projects. Share links and invitations you
  created, and your memberships in other people's projects, are removed. Your
  account is removed from the author field of revisions in projects you do
  not own; your edits to those projects stay, because the project belongs to its
  owner.

Deletion does not touch projects stored in your browser; delete those from
the Trash on the start screen. Data already sent to an AI provider, and
aggregate analytics totals, cannot be recalled by us. Local interaction
diagnostics may retain rebuildable project copies after local deletion;
clear browser site data to remove those copies. Recovery copies may remain
under the unverified retention arrangements described in
[section 11](#11-how-long-we-keep-data).

**Your rights.** Depending on where you live, you may have the right to:

- access the personal data we hold about you, and get a copy;
- correct it (your email address cannot be changed in the app today; you can
  create a new account with a different address);
- delete it;
- object to, or restrict, some processing;
- withdraw consent you gave, without affecting earlier processing;
- take your data elsewhere: Export project writes an `.openzcad` file of any
  project at any time;
- complain to your data protection authority.

To use a right the app does not cover, email `[PRIVACY CONTACT EMAIL]`. We
answer within `[RESPONSE PERIOD]`. `[OWNER: verification process.]`

## 13. Security

We use HTTPS, hash sign-in codes and tokens, encrypt personal AI keys,
rate-limit sign-in and the API, and check that each request is allowed to
reach the project it names. No system is perfectly secure. As section 5
explains, cloud project contents are readable by anyone who controls the
hosting account. If we learn of a breach that affects your data, we will tell
you as the law requires.

## 14. Self-hosted deployments

OpenZCAD is open source, and anyone can run their own instance on their own
Cloudflare account ([self-hosting guide](../SELF_HOSTING.md)). The person or
organisation running that instance controls its data, chooses its AI provider
and decides its retention. **This policy does not apply to self-hosted
instances, and we receive no data from them.** Optional analytics in a
self-hosted instance stay off unless its operator connects their own
collector. Operators of self-hosted instances should publish their own privacy
policy; they may adapt this one.

## 15. International transfers

`[OWNER: where Cloudflare, OpenRouter and the model providers process data,
and the safeguards for transfers out of the EU/EEA or UK, if applicable.]`

## 16. Children

OpenZCAD is not directed at children under `[MINIMUM AGE]`, and we do not
knowingly collect their personal data.

## 17. Changes to this policy

We will update this policy when the service changes, and before end-to-end
encryption is described as available. `[OWNER: how users are notified.]`
Effective date: `[EFFECTIVE DATE]`.

## 18. Contact

`[OPERATOR LEGAL NAME]`, `[POSTAL ADDRESS]`, `[PRIVACY CONTACT EMAIL]`.
