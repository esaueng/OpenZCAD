import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { defineConfig, type PluginOption } from 'vite';
import wasm from 'vite-plugin-wasm';
import {
  PDFJS_ASSET_BASE,
  PDFJS_ASSET_DIRS
} from './src/lib/assistant/pdfjsAssets';
import { resolveSourceCommit } from './build/sourceCommit';
import { buildAppVersion } from '../../scripts/app-version.mjs';
import { localRemusPackages } from './build/localRemus';
import {
  remusArtifactGate,
  remusOutputStampPlugin,
  type RemusArtifactStamp
} from './build/remusArtifactGate';
import { remusTranslatorRetry } from './build/remusTranslatorRetry';
import { lazyChunkPrefetch } from './build/lazyChunkPrefetch';
import {
  FONT_ASSET_BASE,
  FONT_FAMILIES
} from '../../packages/geometry/src/text/registry';

if (typeof globalThis.File === 'undefined') {
  // Node 18 lacks the global File constructor that some dependencies expect.
  class NodeFile extends Blob {
    name: string;
    lastModified: number;

    constructor(bits: BlobPart[], name: string, options?: FilePropertyBag) {
      super(bits, options);
      this.name = name;
      this.lastModified = options?.lastModified ?? Date.now();
    }
  }

  Object.assign(globalThis, { File: NodeFile });
}

const WORKSPACE_PACKAGES = [
  'shared',
  'geometry',
  'document-core',
  'command-system',
  'kernel-adapter',
  'ai-contracts',
  'viewport',
  'io-step',
  'io-shapr',
  'io-stl',
  'jobs',
  'cloudflare-adapters',
  'persistence',
  'crypto',
  'mls',
  'scripting'
] as const;

const workspaceAliases = {
  '@openzcad/ai-contracts/auto-parameterize': fileURLToPath(
    new URL(
      '../../packages/ai-contracts/src/auto-parameterize.ts',
      import.meta.url
    )
  ),
  ...Object.fromEntries(
    WORKSPACE_PACKAGES.map((name) => [
      `@openzcad/${name}`,
      fileURLToPath(
        new URL(`../../packages/${name}/src/index.ts`, import.meta.url)
      )
    ])
  )
};

async function remusBuildInfo(): Promise<{
  version: string;
  commit: string;
}> {
  const [packageText, lockfile] = await Promise.all([
    readFile(
      fileURLToPath(
        new URL(
          '../../packages/kernel-adapter/node_modules/remus-wasm/package.json',
          import.meta.url
        )
      ),
      'utf8'
    ),
    readFile(
      fileURLToPath(new URL('../../pnpm-lock.yaml', import.meta.url)),
      'utf8'
    )
  ]);
  const packageJson = JSON.parse(packageText) as { version?: unknown };
  // The kernel and translator packages must come from one Remus commit: the
  // arena document format they exchange is versioned by that commit.
  const commits = new Set(
    [
      ...lockfile.matchAll(
        /https:\/\/codeload\.github\.com\/esaueng\/remus\/tar\.gz\/([0-9a-f]{40})#path:\/crates\/wasm(?:-io)?\/pkg/g
      )
    ].map((match) => match[1]!)
  );
  const [commit] = commits;
  if (
    typeof packageJson.version !== 'string' ||
    commits.size !== 1 ||
    !commit
  ) {
    throw new Error(
      `Unable to resolve one pinned Remus build identity (found ${commits.size} commits).`
    );
  }
  return { version: packageJson.version, commit };
}

function sourceCommit(): string {
  return resolveSourceCommit(process.env, () => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        encoding: 'utf8'
      });
    } catch {
      return null;
    }
  });
}

function buildMetadata(
  version: string,
  commit: string,
  remus: {
    version: string;
    commit: string;
    artifacts?: RemusArtifactStamp;
  }
): PluginOption {
  return {
    name: 'openzcad-build-metadata',
    generateBundle(_options, bundle) {
      const assets = Object.values(bundle)
        .map((entry) => entry.fileName)
        .filter((fileName) => /\.(?:css|js|mjs|wasm)$/.test(fileName))
        .sort();
      this.emitFile({
        type: 'asset',
        fileName: 'build-meta.json',
        source: `${JSON.stringify(
          {
            format: 'openzcad-build-metadata',
            formatVersion: 2,
            version,
            commit,
            remus,
            assets
          },
          null,
          2
        )}\n`
      });
    }
  };
}

/**
 * Serves the pdf.js runtime data directories in dev and copies them into the
 * build. They are plain data, not importable modules, so pdf.js is given a URL
 * prefix instead — see `pdfjsAssets.ts` for why each one is needed.
 */
/**
 * Serves the bundled text fonts at `FONT_ASSET_BASE` (`/fonts/`).
 *
 * The faces live in `packages/geometry/assets/fonts` because that is where the
 * registry and the golden tests read them from. The browser needs them over
 * HTTP, and copying 21 files into `public/` would vendor them into the source
 * tree twice. Same shape as `pdfjsAssets` above: stream from source in dev,
 * copy into the build output on write.
 */
function textFontAssets(): PluginOption {
  const sourceRoot = fileURLToPath(
    new URL('../../packages/geometry/assets/fonts/', import.meta.url)
  );
  let outDir = 'dist';
  return {
    name: 'openzcad-text-font-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? '';
        if (!url.startsWith(FONT_ASSET_BASE)) {
          next();
          return;
        }
        const relative = url.slice(FONT_ASSET_BASE.length).split('?')[0] ?? '';
        // Only the flat asset directory, and never a traversal out of it.
        if (!/^[\w.-]+\.(?:ttf|otf)$/.test(relative)) {
          next();
          return;
        }
        const stream = createReadStream(`${sourceRoot}${relative}`);
        stream.on('error', () => next());
        stream.on('open', () => response.setHeader('content-type', 'font/ttf'));
        stream.pipe(response);
      });
    },
    async writeBundle() {
      const target = join(outDir, FONT_ASSET_BASE.replace(/^\/|\/$/g, ''));
      await mkdir(target, { recursive: true });
      // Only the faces themselves; the licence texts and manifest beside them
      // are for the repo, not the wire.
      for (const family of FONT_FAMILIES) {
        for (const face of family.faces) {
          await cp(`${sourceRoot}${face.file}`, join(target, face.file));
        }
      }
    }
  };
}

function pdfjsAssets(): PluginOption {
  const sourceRoot = fileURLToPath(
    new URL('./node_modules/pdfjs-dist/', import.meta.url)
  );
  let outDir = 'dist';
  return {
    name: 'openzcad-pdfjs-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // Dev: serve straight from node_modules instead of copying on every boot.
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? '';
        if (!url.startsWith(PDFJS_ASSET_BASE)) {
          next();
          return;
        }
        const relative = url.slice(PDFJS_ASSET_BASE.length).split('?')[0] ?? '';
        // Anything outside the three known directories, or containing a
        // traversal segment, would expose the workspace over the dev server.
        if (
          !PDFJS_ASSET_DIRS.some((dir) => relative.startsWith(`${dir}/`)) ||
          relative.split('/').includes('..')
        ) {
          next();
          return;
        }
        const stream = createReadStream(`${sourceRoot}${relative}`);
        stream.on('error', () => next());
        stream.on('open', () =>
          response.setHeader('content-type', 'application/octet-stream')
        );
        stream.pipe(response);
      });
    },
    // Copied into the build output rather than into `public/`, so a build never
    // leaves 4 MB of vendored data behind in the source tree.
    async writeBundle() {
      const target = join(outDir, PDFJS_ASSET_BASE.replace(/^\/|\/$/g, ''));
      await mkdir(target, { recursive: true });
      for (const dir of PDFJS_ASSET_DIRS) {
        await cp(`${sourceRoot}${dir}`, join(target, dir), {
          recursive: true
        });
      }
    }
  };
}

export default defineConfig(async ({ command, isPreview, mode }) => {
  const localRemus = await localRemusPackages(process.env);
  // Every build, web or desktop, filtered or not, verifies the Remus packages
  // it bundles; dev and preview only warn. See build/remusArtifactGate.ts.
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const remusArtifacts = remusArtifactGate({
    command,
    repoRoot,
    env: process.env,
    overlay: localRemus?.aliases ?? null
  });
  const remus = {
    ...(localRemus?.build ?? (await remusBuildInfo())),
    ...(remusArtifacts && !localRemus ? { artifacts: remusArtifacts } : {})
  };
  const commit = sourceCommit();
  // Fails when a manifest disagrees with package.json. A build counts the
  // user-facing merges since the base version, deepening a shallow CI or
  // Workers Builds clone; CI and release builds fail rather than report the
  // bare base. Dev and preview servers never fetch.
  const isCiBuild =
    command === 'build' &&
    Boolean(
      process.env.CI ||
      process.env.WORKERS_CI ||
      process.env.WORKERS_CI_COMMIT_SHA
    );
  const appBuildVersion = buildAppVersion(repoRoot, {
    fetch: command === 'build',
    required: isCiBuild
  });
  if (!appBuildVersion.exact) {
    console.warn(
      `OpenZCAD: reporting base app version ${appBuildVersion.base} (${appBuildVersion.reason}).`
    );
  }
  const appVersion = appBuildVersion.version;
  const isDesktop = mode === 'desktop';
  const isIPad = mode === 'ipad';
  const isBundled = isDesktop || isIPad;
  const plugins = [];
  const react = (await import('@vitejs/plugin-react')).default;
  plugins.push(
    react(),
    wasm(),
    remusTranslatorRetry(),
    pdfjsAssets(),
    textFontAssets(),
    buildMetadata(appVersion, commit, remus),
    lazyChunkPrefetch(),
    // Last: ties the stamp to the written output (emitted module paths and a
    // digest of every file) for scripts/check-release-build.mjs.
    remusOutputStampPlugin({
      repoRoot,
      stamped: Boolean(remusArtifacts && !localRemus)
    })
  );

  const nodeMajor = Number.parseInt(
    process.versions.node.split('.')[0] ?? '0',
    10
  );
  // `vite preview` also reports command === 'serve', but the Cloudflare
  // plugin expects build output it did not produce; load it for dev only.
  // The bundled desktop app talks to native commands and its configured
  // hosted API, not an embedded Workers runtime. Keeping Miniflare out of this
  // mode also makes the Tauri dev server deterministic and self-contained.
  const isDevServer = command === 'serve' && !isPreview && !isBundled;
  if (isDevServer && nodeMajor >= 20) {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    plugins.push(cloudflare());
  } else if (isDevServer) {
    console.warn(
      `OpenZCAD beta: skipping @cloudflare/vite-plugin because Node ${process.versions.node} is below the plugin's expected runtime.`
    );
  }

  return {
    // Native hosts serve the production bundle from their own asset protocol. Relative
    // URLs keep workers, WASM, fonts, and pdf.js data inside that bundle.
    base: isBundled ? './' : '/',
    plugins,
    define: {
      'import.meta.env.VITE_E2E': JSON.stringify(process.env.VITE_E2E ?? ''),
      'import.meta.env.OZ_DESKTOP': JSON.stringify(isDesktop),
      'import.meta.env.OZ_PERF': JSON.stringify(process.env.OZ_PERF ?? ''),
      'import.meta.env.OZ_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.OZ_BUILD_COMMIT': JSON.stringify(commit),
      'import.meta.env.OZ_REMUS_VERSION': JSON.stringify(remus.version),
      'import.meta.env.OZ_REMUS_COMMIT': JSON.stringify(remus.commit)
    },
    optimizeDeps: {
      // The exact CAD kernel and its file-format translators ship as
      // WebAssembly and must remain runtime assets.
      exclude: ['remus-wasm', 'remus-wasm-io', '@sqlite.org/sqlite-wasm']
    },
    worker: {
      format: 'es' as const,
      rollupOptions: {
        preserveEntrySignatures: false,
        output: {
          // Worker builds have their own output configuration. Keep the
          // exact adapter splits there without pulling unrelated dependencies
          // into every worker. Preserve evaluation order across the split.
          strictExecutionOrder: true,
          codeSplitting: {
            groups: [
              {
                name: 'exact-mesh-payload',
                test: (id: string) =>
                  id.includes(
                    '/packages/kernel-adapter/src/imported-mesh-payload.ts'
                  ),
                // Keep mesh payload helpers behind the exact adapter's lazy
                // boundary without moving the shared document dependencies.
                includeDependenciesRecursively: false
              },
              {
                name: 'exact-analysis',
                test: (id: string) =>
                  id.includes(
                    '/packages/kernel-adapter/src/imported-feature-query.ts'
                  ) ||
                  id.includes(
                    '/packages/kernel-adapter/src/exact-sync-memo.ts'
                  ) ||
                  id.includes(
                    '/packages/kernel-adapter/src/remus-load-error.ts'
                  ) ||
                  id.includes(
                    '/packages/kernel-adapter/src/union-connectivity.ts'
                  ) ||
                  id.includes(
                    '/packages/kernel-adapter/src/feature-profile-dependencies.ts'
                  ),
                includeDependenciesRecursively: false
              },
              {
                // I01 projection geometry is reached both from the geometry
                // barrel, which every worker loads eagerly, and from the lazy
                // exact adapter. Left unassigned, the bundler hosts it in the
                // exact chunk, and the barrel's re-export then makes every
                // worker load that chunk (and its mesh-payload split) at
                // startup. Its own leaf chunk keeps the exact boundary lazy.
                name: 'geometry-sketch-projection',
                test: (id: string) =>
                  id.includes('/packages/geometry/src/sketch-projection.ts'),
                includeDependenciesRecursively: false
              }
            ]
          }
        }
      },
      // The plugin supports several Vite majors, so narrow its cross-version
      // return type to the Vite version used by this workspace.
      plugins: (): PluginOption[] => [
        {
          name: 'openzcad-worker-core-wasm-loader',
          enforce: 'pre',
          resolveId(source, importer) {
            if (
              source === '/__vite-plugin-wasm-helper' &&
              importer?.endsWith('/remus_wasm_bg.wasm')
            ) {
              return fileURLToPath(
                new URL(
                  '../../packages/kernel-adapter/src/load-pattern-kernel.ts',
                  import.meta.url
                )
              );
            }
          }
        },
        wasm() as PluginOption,
        remusTranslatorRetry()
      ]
    },
    resolve: {
      alias: {
        ...localRemus?.aliases,
        // Imported dynamically so opentype.js lands in its own chunk instead
        // of the entry bundle. Reaching it through the geometry index would
        // not split — that index is statically imported all over the app.
        '@openzcad/geometry/text-loader': fileURLToPath(
          new URL('../../packages/geometry/src/text/loader.ts', import.meta.url)
        ),
        '@openzcad/kernel-adapter/exact': fileURLToPath(
          new URL('../../packages/kernel-adapter/src/exact.ts', import.meta.url)
        ),
        '@openzcad/kernel-adapter/sketch-2d-ops': fileURLToPath(
          new URL(
            '../../packages/kernel-adapter/src/sketch-2d-ops.ts',
            import.meta.url
          )
        ),
        // The mesh import format table is reached only from the lazy mesh
        // import client and its worker. Importing it through the adapter's
        // index barrel would put it in the eager graph — and would make the
        // whole eager kernel-adapter slice shared between first paint and a
        // lazy chunk, which rolldown answers by hoisting it into an anonymous
        // `src-*` chunk the launcher preloads. Same reason as the text loader
        // above: reach the leaf module directly.
        '@openzcad/kernel-adapter/mesh-import-formats': fileURLToPath(
          new URL(
            '../../packages/kernel-adapter/src/mesh-import-formats.ts',
            import.meta.url
          )
        ),
        // The extrude operation classifier is pure arithmetic, but reaching it
        // through the adapter's index barrel put the whole exact kernel — and
        // its multi-megabyte wasm — into the launcher's entry chunk
        // (ZCAD-004). Same leaf-module rule as the two above.
        '@openzcad/kernel-adapter/extrude-inference': fileURLToPath(
          new URL(
            '../../packages/kernel-adapter/src/extrude-inference.ts',
            import.meta.url
          )
        ),
        // The flat-pattern DXF/SVG writers are pure; the lazy flat-pattern
        // dialog reaches them as a leaf module, by the rule above.
        '@openzcad/kernel-adapter/sheet-metal-flat-pattern': fileURLToPath(
          new URL(
            '../../packages/kernel-adapter/src/sheet-metal-flat-pattern.ts',
            import.meta.url
          )
        ),
        '@openzcad/kernel-adapter/topology-lineage': fileURLToPath(
          new URL(
            '../../packages/kernel-adapter/src/topology-lineage.ts',
            import.meta.url
          )
        ),
        '@openzcad/kernel-adapter/face-attachment': fileURLToPath(
          new URL(
            '../../packages/kernel-adapter/src/face-attachment.ts',
            import.meta.url
          )
        ),
        '@openzcad/viewport/move-transform': fileURLToPath(
          new URL(
            '../../packages/viewport/src/gizmo/moveTransform.ts',
            import.meta.url
          )
        ),
        // App.tsx is in the entry chunk and needs only this walk, which
        // imports nothing but types; the package index would bring three.
        '@openzcad/viewport/edge-chain': fileURLToPath(
          new URL(
            '../../packages/viewport/src/pick/edgeChain.ts',
            import.meta.url
          )
        ),
        '@openzcad/viewport/input-bindings': fileURLToPath(
          new URL(
            '../../packages/viewport/src/input/bindings.ts',
            import.meta.url
          )
        ),
        // The 3D mouse connection lives in the entry chunk (App and
        // Settings share it); its decoder imports nothing.
        '@openzcad/viewport/space-mouse': fileURLToPath(
          new URL(
            '../../packages/viewport/src/input/spaceMouse.ts',
            import.meta.url
          )
        ),
        // M09's overlay drawing loads with the first analysis switched on,
        // in its own chunk rather than the entry's.
        '@openzcad/viewport/analysis-overlay': fileURLToPath(
          new URL(
            '../../packages/viewport/src/scene/analysisOverlay.ts',
            import.meta.url
          )
        ),
        '@openzcad/viewport/types': fileURLToPath(
          new URL('../../packages/viewport/src/types.ts', import.meta.url)
        ),
        // The drawing chunk reads the wheel the way Build does; the package
        // index would bring three into it.
        '@openzcad/viewport/wheel-gesture': fileURLToPath(
          new URL(
            '../../packages/viewport/src/input/wheelGesture.ts',
            import.meta.url
          )
        ),
        // Same reason as the text loader above: the io-shapr index pulls the
        // zip reader, SQLite-WASM and the MessagePack decoder, and the module
        // that wants this one pure string helper is in the entry chunk.
        '@openzcad/io-shapr/truncate': fileURLToPath(
          new URL('../../packages/io-shapr/src/truncate.ts', import.meta.url)
        ),
        ...workspaceAliases
      }
    },
    build: {
      outDir: isIPad ? 'dist-ipad' : isDesktop ? 'dist-desktop' : 'dist',
      target: isBundled ? 'safari17' : 'esnext',
      rollupOptions: {
        output: {
          // Rolldown accepts functional chunk routing. three.js dominates the
          // bundle, so isolate it for better caching without relying on the
          // object form supported by Rollup-only Vite releases.
          manualChunks: (id: string) => {
            // Imported-feature, profile-dependency and union analysis stay
            // behind the exact adapter's lazy boundary in its existing chunk.
            if (
              id.includes(
                '/packages/kernel-adapter/src/imported-feature-query.ts'
              ) ||
              // Runtime refusal classification shares the existing lazy
              // analysis boundary without bringing the loader dependencies.
              id.includes('/packages/kernel-adapter/src/remus-load-error.ts') ||
              id.includes(
                '/packages/kernel-adapter/src/union-connectivity.ts'
              ) ||
              id.includes(
                '/packages/kernel-adapter/src/feature-profile-dependencies.ts'
              )
            ) {
              return 'exact-analysis';
            }
            // The MLS client wrapper (ADR-024) is imported only dynamically,
            // with its Worker and WASM; a name keeps it from passing as an
            // anonymous chunk and lets the bundle gate refuse it at launch.
            if (id.includes('/packages/mls/')) {
              return 'mls';
            }
            if (id.includes('/node_modules/three/examples/')) {
              return 'three-addons';
            }
            if (id.includes('/node_modules/three/')) {
              return 'three';
            }
            if (
              id.includes('/node_modules/react/') ||
              id.includes('/node_modules/react-dom/') ||
              id.includes('/node_modules/scheduler/')
            ) {
              return 'react';
            }
            if (id.includes('/node_modules/lucide-react/')) {
              return 'icons';
            }
            // The document model is shared by the eager workspace, the lazy
            // Assistant, and exact-preview modules. Give that deliberate
            // first-paint dependency a stable name so it is not mistaken for
            // an app-code `src-*` leak by the bundle gate. The command layer
            // and AI contracts ride along: they are the same eager-workspace /
            // lazy-Assistant dependency (command-system imports ai-contracts,
            // so routing one without the other would strand a shared anonymous
            // chunk in first paint), and keeping them here keeps the launcher
            // `index-*` chunk clear of the document machinery entirely.
            if (
              id.includes('/packages/shared/') ||
              id.includes('/packages/document-core/') ||
              id.includes('/packages/command-system/') ||
              id.includes('/packages/ai-contracts/') ||
              // History dependency and suppression validation belong beside
              // the document machinery. The existing model chunk is already
              // preloaded, so this adds no request or async commit boundary.
              id.includes('/apps/web/src/lib/featureHistory.ts') ||
              id.includes('/apps/web/src/lib/featureSuppression.ts') ||
              // Sanitized document diagnostics are shared by the workspace
              // and interaction captures. Keep this pure document helper in
              // the same preloaded model chunk without another request.
              id.includes('/apps/web/src/lib/projectDiagnostics.ts') ||
              // Static top-bar modes and save-state presentation remain in
              // the existing preloaded UI/model graph, including offline.
              id.includes('/apps/web/src/lib/topBarPresentation.ts') ||
              // Export eligibility and sweep disclosure inspect document
              // history/topology. Keep them with the same preloaded model
              // helpers so their integration does not grow the entry chunk.
              id.includes('/apps/web/src/lib/failedHistoryExport.ts') ||
              id.includes('/apps/web/src/lib/sweepFaceting.ts') ||
              // Feature forms and History summaries turn stored feature data
              // to and from what the workspace shows (M01 hole placement and
              // standard sizes among them). Pure document helpers: keep them
              // with the preloaded model helpers too.
              id.includes('/apps/web/src/lib/modelingOperations.ts') ||
              id.includes('/apps/web/src/lib/featureSummary.ts') ||
              // Standard part and Thread resolve sizes and build requests
              // from the shared catalogues. Keep those specs with the
              // existing preloaded model helpers.
              id.includes('/apps/web/src/lib/inPlace/standardPart.ts') ||
              id.includes('/apps/web/src/lib/inPlace/thread.ts') ||
              // Canonical worker transport and revision/reference helpers are
              // already workspace dependencies. Reuse the preloaded model
              // chunk rather than adding another first-paint request.
              id.includes('/apps/web/src/lib/projectionStream.ts') ||
              id.includes('/apps/web/src/lib/meshTransport.ts') ||
              id.includes('/apps/web/src/lib/editTrace.ts') ||
              id.includes('/apps/web/src/lib/topologyResolution.ts') ||
              id.includes('/apps/web/src/lib/topologyLabels.ts') ||
              // Room transport validation is shared by the eager socket hook
              // and named saves. Keep it in this already preloaded chunk.
              id.includes('/apps/web/src/lib/collaborationProtocol.ts') ||
              // Thumbnail coordination and shelf version checks must be
              // resident before leave-time flush. Reuse this preloaded chunk.
              id.includes('/apps/web/src/lib/projectThumbnailCapture.ts') ||
              id.includes('/apps/web/src/lib/sharedThumbnailCapture.ts') ||
              id.includes('/apps/web/src/lib/projectShelf.ts') ||
              // Device durability and its save indicators are synchronous
              // workspace dependencies. Keep them resident in this existing
              // preloaded chunk, including before a reload or navigation.
              id.includes('/apps/web/src/lib/localProjectAutosave.ts') ||
              id.includes('/apps/web/src/lib/localProjectStore.ts') ||
              id.includes('/apps/web/src/lib/localAutosaveFailure.ts') ||
              id.includes(
                '/apps/web/src/lib/workspaceSaveStatePresentation.ts'
              ) ||
              // Chunk recovery is shared by the launcher, worker and lazy
              // panels. Keep it resident beside device durability in the
              // existing preloaded chunk, including while offline.
              id.includes('/apps/web/src/lib/staleChunk.ts') ||
              id.includes('/apps/web/src/lib/buildVersionWatch.ts')
            ) {
              return 'model';
            }
            // Sketch geometry, shared by the eager workspace and by lazily
            // loaded features. Without a name it becomes an anonymous `src-*`
            // chunk, which `report-bundle-sizes` rejects when the launcher
            // preloads it — the pattern exists to catch app code leaking into
            // first paint, and an unnamed chunk makes that impossible to tell
            // apart from a deliberate shared dependency. This one is
            // deliberate: Build mode needs it immediately.
            // The text loader is the sole opentype.js import site and is
            // reached only through `textFonts.ts`'s dynamic import. Name it
            // before the geometry rule claims it, or the font parser rides
            // in the preloaded `geometry` chunk for every cold visit.
            if (
              id.includes('/packages/geometry/src/text/loader.ts') ||
              id.includes('/node_modules/opentype.js/')
            ) {
              return 'text-loader';
            }
            if (id.includes('/packages/geometry/')) {
              return 'geometry';
            }
            // Sketch editing and viewport interaction: Build-mode code the
            // workspace needs at once. Named for the same reason as
            // `geometry` above — once the exact kernel left the eager graph
            // (ZCAD-004), rolldown folded these into the entry chunk, which
            // is measured against a per-file budget meant to catch launcher
            // growth, not a regrouping of workspace modules it already
            // preloaded.
            // The batch fillet planner runs only while the tool is armed.
            if (id.endsWith('/apps/web/src/lib/sketch/filletBatch.ts')) {
              return undefined;
            }
            if (
              id.includes('/apps/web/src/lib/sketch/') ||
              id.includes('/apps/web/src/lib/interaction/')
            ) {
              return 'sketching';
            }
            return undefined;
          }
        }
      }
    }
  };
});
