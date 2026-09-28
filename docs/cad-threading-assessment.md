# Browser kernel threading assessment

**Decision:** keep the shipped `wasm32` kernel serial. A separate threaded
artifact is an opt-in experiment after a representative edit trace identifies
tessellation or batched classification as a material latency cost. This review
does not change response headers, CI, package dependencies, or the deployed
kernel.

The modeling path creates one geometry worker in
[`useGeometryWorker.ts`](../apps/web/src/hooks/useGeometryWorker.ts), which
loads [`createExactKernelAdapter`](../apps/web/src/worker/geometryWorker.ts)
from the paired Remus packages. Other import workers serve separate tasks; they
do not parallelize one live geometry session. In Remus source
[`f69d05da`](https://github.com/esaueng/remus/tree/f69d05da37185b4fdfe4661fc10e4a975e0b452c),
[`tessellate/solid.rs`](https://github.com/esaueng/remus/blob/f69d05da37185b4fdfe4661fc10e4a975e0b452c/crates/operations/src/tessellate/solid.rs)
uses Rayon on native for edge sampling when there are at least 32 edges and
planar CDT when there are at least two jobs; the `wasm32` arms run those same
jobs serially. [`PreparedSolid::classify_points`](https://github.com/esaueng/remus/blob/f69d05da37185b4fdfe4661fc10e4a975e0b452c/crates/check/src/classify/prepared.rs)
is serial in both builds. There is no measured classification scaling result
here.

An isolated native Remus face-move probe at that source, with 1,000 unrelated
boxes, recorded 5.963 ms median edit time and 0.038 ms median mesh time.
With 10,000 boxes, those figures were 40.605 ms and 0.061 ms. These are
synthetic Rust measurements, not OpenZCAD frame times or an installed WASM
result. A candidate sharing two unchanged entry snapshots removed one full
arena copy; repeated host runs were too variable to establish a stable edit
latency improvement. This evidence favors measuring arena copies and history
replay before attributing this edit's delay to serial tessellation.

`memory64` addresses capacity, not edit latency. The current `wasm32` address
type can address at most 4 GiB of one linear memory; an `i64` memory changes
that address type, subject to browser and package support. Neither makes a
full-document snapshot or geometry operation faster. Even a 5 GB storage
allowance for saved models would be a separate persistence budget; files need
not all fit in one live WASM memory. [MDN documents the 32-bit 4 GiB limit and
64-bit memory descriptor](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/Memory).

If a browser trace shows a large parallelizable tessellation or classification
stage, the kernel experiment should build **two** source-matched artifacts:
the present serial package and a threaded variant with shared memory, an
initialized pool, and the same public geometry contract. The adapter should
select the threaded variant only after feature detection and successful pool
initialization in the geometry worker; every other case uses serial. Gate the
experiment on exact package/source identity, identical mesh buffers and face
attribution, watertightness and typed refusals, deterministic repeated output,
peak linear memory and worker count, cold load, and edit/mesh p50/p95 on the
same complex body across supported browsers. Compare the whole worker-to-paint
path, including transfer and viewport installation, before claiming a product
gain. [The Rayon WASM adapter describes a two-build fallback](https://github.com/GoogleChromeLabs/wasm-bindgen-rayon).

The site already has a [static `_headers` file](../apps/web/public/_headers),
but it does not set COOP or COEP. Shared WASM memory requires a compatible
cross-origin isolation policy. An ADR must qualify the hosted and local
preview headers, cross-origin resources such as the allowed Turnstile frame,
and embedding behavior before any header change; `crossOriginIsolated` must
be checked in the worker at runtime. [MDN describes those isolation
requirements](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/crossOriginIsolated),
and [Cloudflare documents `_headers` for static assets](https://developers.cloudflare.com/workers/static-assets/headers/).
