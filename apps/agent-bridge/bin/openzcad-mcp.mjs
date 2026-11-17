#!/usr/bin/env node
/**
 * Starts the OpenZCAD agent API (MCP) over stdio. See apps/agent-bridge/README.md.
 *
 * The server runs from this checkout's TypeScript sources through Vite's
 * server-side module runner, so every workspace package resolves its own
 * dependencies — in particular the exact kernel loads the same pinned
 * `remus-wasm` build the app uses, through that package's Node entry. The
 * runner stays open for the session (the preflight imports modules lazily).
 * It is created in middleware mode with no HMR socket and no file watcher:
 * nothing listens on any port.
 */
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  envFile: false,
  logLevel: 'silent',
  clearScreen: false,
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] }
});
const runner = createServerModuleRunner(server.environments.ssr, {
  hmr: false
});
try {
  const { main } = await runner.import(
    fileURLToPath(new URL('../src/main.ts', import.meta.url))
  );
  process.exitCode = await main(process.argv.slice(2));
} finally {
  await runner.close();
  await server.close();
}
