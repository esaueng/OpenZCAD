# openzcad-mcp: the OpenZCAD agent API

A local [Model Context Protocol](https://modelcontextprotocol.io) server that
lets the AI agent of your choice read and edit an OpenZCAD project with the
same validated patch operations and exact-kernel preflight the in-app
assistant uses. Design: [L14 agent API design](../../docs/plans/l14-agent-api-design.md).

It runs on your machine over stdio. It opens no network connection, never
contacts OpenZCAD, and holds no account credentials or keys. It works on
`.openzcad` project files you grant it.

## Use

1. In OpenZCAD, export the project: **File → Export project**. An encrypted
   project is decrypted in your browser for the export, exactly as a manual
   backup is.
2. Make the file yours alone if it is not already: `chmod go-w Block.openzcad`.
   The server refuses a file another user owns or can write, or one under any folder
   other users can write (unless the folder has the sticky bit, as `/tmp` does)
   or that another account owns.
   It checks again on every read and write, and refuses a file that was moved
   or replaced by a link after it started.
3. Add the server to your MCP host's configuration. From a checkout of this
   repository (after `pnpm install`):

   ```json
   {
     "mcpServers": {
       "openzcad": {
         "command": "node",
         "args": [
           "/path/to/OpenZCAD/apps/agent-bridge/bin/openzcad-mcp.mjs",
           "--project",
           "/path/to/Block.openzcad",
           "--scope",
           "edit"
         ]
       }
     }
   }
   ```

4. Ask your agent for the change. When it is done, import the file into
   OpenZCAD with **Import project** on the projects screen (or File → Import project…). The agent's change is one undo step, labelled
   **Apply agent patch**.

Keep the server and the app on the same release: the server writes its own
document schema version.

## Scope

Granted on the command line, never requested by the agent:

| `--scope`             | Tools                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `read`                | `list_projects`, `get_document`, `get_digest`, `get_patch_schema`          |
| `preflight` (default) | `read` plus `preflight_patch`, which checks a patch and writes nothing     |
| `edit`                | `preflight` plus `apply_patch`, the only tool that writes the project file |

Only the files named with `--project` are reachable; tools address them by
alias or project id, never by path.

## Limits

One exact-kernel job runs at a time and one more may wait. Each server
process allows 120 read calls and 12 exact-kernel calls a minute (bursts of 30
and 4); `--reads-per-minute` and `--kernel-per-minute` can lower these. A
request line is at most 2 MiB, `get_document` at most 4 MiB. A derivation is
asked to stop after 120 s; one kernel operation cannot be interrupted, so a
very large one can run longer, but a call past its budget never writes.

## Privacy

Whatever a tool returns — the document, the digest, preflight reports — goes
from your agent to its model provider under that provider's terms. OpenZCAD
does not choose or reach that provider. The in-app assistant's consent dialog
does not apply here: granting a file to an agent is that consent.

## Limitations

- Drawing-sheet operations are not available yet.
- Text features need the app's fonts, which the server does not load; a
  project with text features may not derive.
- It edits a file, not the open workspace. A live bridge to an open project is
  a separate, later decision (see the design note, Phase 2).
