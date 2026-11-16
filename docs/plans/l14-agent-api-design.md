# L14 agent API (MCP) design

**Status:** design accepted for delivery. Phase 1 (the local stdio server on
project files) is the L14 delivery; Phase 2 (a live bridge to an open
workspace) is designed here but needs its own owner decision before any code,
because it opens a local network listener or a new desktop IPC surface.

[L14](../../ROADMAP.md#l14) asks for a Model Context Protocol (MCP) server
that gives a user-chosen AI agent the canonical document, the
schema-constrained patch operations and exact preflight, so users can bring
their own model. Every change keeps the assistant's contract: a validated
patch, exact preflight before anything applies, and one undoable transaction.
The bridge runs on the user's machine, so an end-to-end encrypted project
never reaches the server in plaintext ([L11](../../ROADMAP.md#l11),
[ADR-024](../adrs/ADR-024-end-to-end-encrypted-projects.md)).
[L15](../../ROADMAP.md#l15) scripting shares this operation surface.

## What already exists

The assistant's contract is three pieces of code, and the agent API reuses
each of them unchanged rather than restating it:

| Contract        | Code                                                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validated patch | `CAD_PATCH_JSON_SCHEMA`, `parseCadPatchProposal` and `validateCadPatchProposalAgainstDigest` in `@openzcad/ai-contracts`; `MAX_PATCH_OPERATIONS` (60) bounds a proposal. `createCadDocumentDigest` is the compact model summary the assistant sends.             |
| Exact preflight | `preflightCadPatch` in `apps/web/src/lib/aiPatchPreflight.ts`: builds the deterministic command list (`commandsForCadPatch`), derives the candidate on the exact kernel, refuses new exact warnings, missing result bodies, unresolved datums or geometry drift. |
| One transaction | `CommandManager.runTransaction(label, commands)` in `@openzcad/command-system` records a single ADR-023 `editHistory` entry inside the document, so one undo reverts the whole change on any device that opens it.                                               |

Two facts make a headless server possible. `preflightCadPatch` takes its
exact derivation as a callback, and the root test suites already run it in
Node against the real Remus kernel (`createExactKernelAdapter().syncDocument`,
for example `test/all-edge-fillets.test.ts`). And the `remus-wasm` package
ships a Node entry, so the same kernel build that the browser runs can run in
a local process. Durable undo (ADR-023) lives in the document, not in the
browser, so a transaction committed outside the app is still one Ctrl+Z
once the app opens the file.

## Transport

Three options were considered.

| Option                               | Network surface                                                       | Works with                                            | Live document | Decision                |
| ------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------- | ------------- | ----------------------- |
| stdio server on local project files  | None. The agent host spawns the server and owns its stdin and stdout. | Every MCP host that can launch a local server.        | No            | Phase 1                 |
| Localhost relay to an open app tab   | A loopback listener, plus a `connect-src` widening of the app's CSP.  | Browsers that permit an HTTPS page to reach loopback. | Yes           | Phase 2, owner decision |
| Tauri desktop shell hosts the server | A local socket or named pipe owned by the signed app.                 | macOS desktop builds ([L06](../../ROADMAP.md#l06)).   | Yes           | Phase 2, owner decision |

**Phase 1 is a stdio MCP server, `openzcad-mcp`, that operates on
`.openzcad` project files the user names when configuring it.** It is a Node
program in this repository (`apps/agent-bridge`) that runs from the
checkout's TypeScript sources through Vite's server-side module runner, so
every package resolves its own dependencies and the kernel loads the same
pinned `remus-wasm` build as the app, through that package's Node entry. The
runner is created in middleware mode with no HMR socket and no file watcher.
The agent host
starts it as a child process; JSON-RPC 2.0 messages travel one per line on
stdin and stdout, and diagnostics go to stderr. It opens no listener, makes no
network request, and holds no OpenZCAD account credentials or keys.

This shape needs no security-posture change: nothing new is reachable from
the network, from a web page or from the OpenZCAD server. It works with any
MCP host, offline, and on every platform the kernel's Node build supports. The
cost is that it edits a file, not the open workspace: the user exports the
project (File → Export project, an existing path), lets the agent work, and
imports the result, which opens as a project copy as any backup does today.

The server implements the MCP subset it needs by hand — `initialize`,
`notifications/initialized`, `ping`, `tools/list` and `tools/call` — rather
than taking the MCP SDK as a dependency. The protocol surface is small, and a
hand-rolled one keeps the supply chain and the bundle unchanged. It
negotiates the client's requested protocol revision when it supports it and
otherwise answers with its latest.

**Phase 2** keeps the same tool core and swaps the workspace: tools run
against the document open in the app, where the kernel worker, the edit
lease, collaboration and the assistant consent already live. Either a loopback
relay (the stdio server listens on `127.0.0.1` and the open tab connects to it
after the user pairs them) or the desktop shell (the signed app exposes a
socket the stdio server connects to) can carry it. Both widen what can reach
the app, so Phase 2 starts only after the owner chooses between them; see
[Phase 2 requirements](#phase-2-requirements).

## Authentication

Phase 1 has no remote caller to authenticate. The only party that can send a
request is the process that spawned the server and owns its stdin, and that
process already runs as the user with the same file access the server has. A
bearer token would add nothing: any process able to read it could edit the
project file directly. The server's authority is therefore bounded by what the
user grants on its command line (scope, below), not by a credential, and the
note says so plainly rather than adding a token that protects nothing.

What Phase 1 does enforce:

- It never authenticates to OpenZCAD. It reads no cookie, session, API key,
  device key or recovery key, and the bundle contains no client for the
  OpenZCAD API. A test pins that `fetch` and socket creation are never called
  during an end-to-end session.
- It refuses a file that is not a plaintext `openzcad-project` backup — an
  ADR-024 envelope or any other ciphertext is rejected by format before
  parsing — so it cannot be pointed at encrypted data it has no key for.
- On POSIX systems it refuses a granted file that another user owns or that
  group or other users can write: the server acts with the launching user's
  authority, so it does not accept a file another account could swap.
- It refuses to start with stdin attached to a terminal, so a stray
  interactive launch does not sit waiting with edit scope.

## Scope

Scope is granted when the user configures the server, never requested by the
agent at run time.

- **Projects.** `--project <path>` (repeatable) names each file the server may
  open. Paths are resolved through symlinks once at startup; tools address a
  project by its short alias or `projectId`, never by a path, so an agent
  cannot name another file. `--project` is required; there is no directory or
  glob grant.
- **Capability.** `--scope read|preflight|edit`, defaulting to `preflight`:

  | Scope       | Tools                                                             |
  | ----------- | ----------------------------------------------------------------- |
  | `read`      | `list_projects`, `get_document`, `get_digest`, `get_patch_schema` |
  | `preflight` | `read` plus `preflight_patch`                                     |
  | `edit`      | `preflight` plus `apply_patch`, the only tool that writes         |

  A tool outside the granted scope is not listed by `tools/list`, and a call
  to it is refused with an error naming the scope it needs. `apply_patch`
  carries MCP's `readOnlyHint: false` and `destructiveHint: true` annotations
  so a host that confirms writes asks the user; those hints are advisory, and
  scope is the enforcement.

- **Operations.** The patch vocabulary is exactly the assistant's
  (`CAD_PATCH_JSON_SCHEMA`, with `AI_CAD_OPERATION_CAPABILITIES` gates).
  Drawing-sheet proposals are refused in Phase 1: their preflight needs the
  Draw workspace state the app holds.

## Rate limits and budgets

Exact derivation costs real CPU and memory on the user's machine, and an agent
loop can retry fast. Limits protect the machine, not a server:

- **One kernel job at a time.** Preflight, apply and the first digest of a
  project are serialized on one kernel; at most one further call waits, and a
  third is refused as busy rather than queued without bound.
- **Token buckets per server process**: 120 read calls per minute (burst 30)
  and 12 kernel calls per minute (burst 4), shared by `preflight_patch`,
  `apply_patch` and an uncached `get_digest`. A refused call returns a tool
  error with a `retryAfterMs` the agent can honour. Flags may lower these
  defaults, never raise them.
- **Per-call budgets.** A request line is at most 2 MiB of JSON; a proposal is
  at most `MAX_PATCH_OPERATIONS` operations (the parser's existing bound);
  `get_document` answers at most 4 MiB and otherwise tells the agent to use
  the digest. A project file is at most the backup reader's 256 MB.
- **A cooperative deadline, not a hard one.** A derivation is signalled to
  stop after 120 s through the adapter's cancellation signal, which is checked
  between indivisible kernel operations. A single running WASM call cannot
  observe it, and it holds Node's event loop, so one very expensive boolean or
  fillet can run past the deadline and the server answers nothing until it
  returns. When the deadline fires the call is reported as timed out and
  never writes, even if its derivation finishes later; the kernel stays held
  until it does, so no second derivation starts beside it. The agent host's
  own request timeout, and ending the server process, remain the backstop. A
  hard deadline would need the kernel in a separately terminable worker; that
  is a later refinement, not a Phase 1 promise.

## Operation surface

All tools take a `project` (alias or id). Every model-changing call names the
document `expectedVersion` it was planned against, as the app's version fence
does.

| Tool               | Does                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_projects`    | Alias, `projectId`, name, units, version and schema version of each granted project, and the server's scope.                                                                                                                                                                                                                                     |
| `get_document`     | The canonical `ProjectDocument` without its derived projection or edit history.                                                                                                                                                                                                                                                                  |
| `get_digest`       | `createCadDocumentDigest` of the exactly derived document: the same compact summary the assistant sends, with measured faces, edges and editable dimensions.                                                                                                                                                                                     |
| `get_patch_schema` | `CAD_PATCH_JSON_SCHEMA`, the enabled operation kinds and `MAX_PATCH_OPERATIONS`. The same schema is the `proposal` input schema of the two patch tools, so a host that constrains tool arguments constrains the patch.                                                                                                                           |
| `preflight_patch`  | `parseCadPatchProposal` against the digest, then `preflightCadPatch` on the exact kernel. Returns each operation's description, the result bodies it proved, each changed body's volume and bounds before and after, and the candidate version — or the exact refusal text. Writes nothing.                                                      |
| `apply_patch`      | Re-reads the file, refuses if its version moved since `expectedVersion`, then runs the same validation and preflight and commits the preflight's commands with `CommandManager.runTransaction('Apply agent patch', …)`: one `editHistory` entry. Writes the backup atomically with the derived projection stripped, under the write rules below. |

`apply_patch` never reuses an earlier `preflight_patch` result: it preflights
again against the bytes it is about to replace, so nothing applies that the
exact kernel has not just checked.

Write rules:

- **No lost updates.** Preflight can take a while, and another server
  instance or a person can save the same file meanwhile. The SHA-256 of the
  bytes the call loaded is its revision fence: the commit re-hashes the file
  before writing the temporary copy and again immediately before the rename,
  and refuses with `conflict`, writing nothing, if either differs. The
  temporary file sits in the same directory, is created exclusively with the
  original's mode, and is `fsync`ed before the rename. What remains is the
  interval between the last hash and the rename, which no portable advisory
  lock closes against editors that do not take it; the user grants a file to
  one agent at a time.
- **The undo entry must survive.** ADR-023 bounds history to 100 steps and
  8,000,000 serialized bytes and drops the oldest entries first, so an edit
  that alone exceeds the byte budget drops its own entry. A proposal can be
  tiny and still do that (renaming a node snapshots the whole node). The
  commit refuses, before writing, unless the transaction's own entry is the
  newest kept step. Phase 1 writes the file only; the agent
  cannot undo through the API, and the user undoes in the app once they import
  the result, where the change is one step.

## E2EE plaintext boundary

ADR-024 moves every content transformation into the user's browser so the
Worker, D1, R2 and the room hold only ciphertext. The agent API keeps that:

- **Phase 1 never contacts the OpenZCAD server.** The plaintext it handles is a
  `.openzcad` file the user exported to their own disk, which ADR-024 already
  allows (it is the documented exit from encryption). The edited file goes back
  into the app through Import, and an account with encryption on encrypts it in
  the browser before its first upload. No step routes plaintext through the
  Worker.
- **The model provider is the user's choice.** Like the assistant, the agent's
  model sees the plaintext it is given. Unlike the assistant, OpenZCAD neither
  picks nor reaches that provider: the user's own agent host does. The
  server's help text and README say that whatever a tool returns is sent to the
  agent's model provider under that provider's terms.
- **Phase 2 must not weaken it.** A live bridge carries plaintext between the
  user's tab and a process on the same machine, never through the Worker or
  the collaboration room, and on an encrypted project it asks the same
  per-project consent the assistant asks (ADR-024 "AI assistant") with copy
  that names the local agent instead of a provider route.

## Phase 2 requirements

These bind whichever transport the owner chooses; they are not decided here.

- **Pairing.** A one-time code shown in the app and entered in the agent host
  (or the reverse), exchanged for a per-session secret; no long-lived token on
  disk.
- **Origin.** A loopback listener binds `127.0.0.1` only, refuses any
  WebSocket `Origin` other than the deployment's own, and refuses browsers'
  cross-site loopback probes before pairing. The CSP gains only the exact
  loopback scheme and port range it needs.
- **Workspace authority.** Calls run through the app's own preview and apply
  paths (`handlePreviewPatch` and `applyPatch` in `App.tsx`), so the edit
  lease, viewer role, Draw/Build mode and the version fence apply unchanged.
  A visible indicator shows while an agent is connected, with a one-click
  disconnect.
- **Same core, same limits.** The tool definitions, scopes and rate limits
  above apply unchanged; only the workspace adapter differs.

## Delivery slices

1. **This note.** Merged before code; L15 builds on its operation surface.
2. **Tool core** (`packages/agent-api`): the transport-agnostic tool
   definitions, scope and rate-limit enforcement, the MCP JSON-RPC dispatcher
   and its framing, against an injected workspace interface. Unit tests cover
   protocol negotiation, malformed and oversized input, scope refusals and
   limits.
3. **stdio host** (`apps/agent-bridge`): the file workspace, Node kernel
   wiring, atomic write and the `openzcad-mcp` launcher. An end-to-end
   test spawns the real server over stdio, drives a real edit on a sample
   project (initialize, digest, preflight, apply), and checks the file gained
   exactly one undo entry whose undo restores the original model, that a
   refused patch leaves the file byte-identical, and that no network call was
   made.
4. **Evidence.** An `l14--…` fragment with the tests and PRs.

Slices 2 and 3 may land in one pull request: the core has no other host to
exercise it end to end yet.

Phase 2 is a separate row decision after the owner chooses its transport.

## Risks

- **The preflight module lives in the web app.** The bridge imports
  `apps/web/src/lib/aiPatchPreflight.ts` directly so there is one preflight,
  not a copy. If that module ever gains a browser-only import, the bridge
  build fails; the end-to-end test is the guard, and the fix is to move the
  module into a shared package then.
- **Kernel memory.** A local server holds one kernel for its lifetime. The
  one-job limit bounds peak use to one derivation of the largest granted
  project.
- **Schema skew.** The server refuses a project whose schema is newer than its
  own `PROJECT_DOCUMENT_SCHEMA_VERSION`, as the backup reader does, and
  normalizes older ones as import does. It writes its own schema version, so
  an app older than the server cannot import the result; the help text says
  to keep the server and the app on the same release.
