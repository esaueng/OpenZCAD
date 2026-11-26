# AI assistant (experimental)

An optional console assistant turns plain-language requests into reviewable document patches. It is experimental and entirely optional — the workspace is fully functional without it. Provider-backed requests stay dormant until a provider key is configured; verified local recipes remain available without one.

For agents you run yourself, see the local [agent API](../apps/agent-bridge/README.md) (`openzcad-mcp`) and [history text and scripts](scripting.md). Both submit the same validated patch operations and exact preflight the assistant uses.

## Using it

Enable the assistant in **Settings → AI**. Its conversation opens above the bottom prompt, leaving the model at full width; `Ctrl/Cmd+J` toggles it. Plain-language input asks the assistant, while `/` lists commands. Click outside the conversation to tuck it away; the prompt indicates work in progress and unread replies. Each project's thread — what was asked, what the assistant asked back, and which proposals were applied or rejected — is kept on the device and read back when the project reopens, so the scrollback is a record rather than a session.

The built-in assistant (NVIDIA Nemotron 3.5 Super VL, free, through OpenRouter) uses the Responses API with native schema enforcement; a model without it, such as MiniMax, uses Chat Completions in JSON mode. It sees compact feature history, live exact-topology summaries, and the active selection, so "fillet all edges" resolves stable edge fingerprints without manual picking. Output is constrained to a strict CAD patch schema; you preview, apply, or reject, and apply is one normal undoable transaction. PDF and image drawings can be attached as references. The AI can only propose an allowlisted command patch — it cannot directly mutate a document, viewport, or kernel.

## Provider-free recipes

**Fillet all edges** is available without a provider key. Ask "add a fillet on all edges" or "fillet all edges by 1 mm", or choose the matching assistant action. It uses the complete local edge inventory of the named, selected, or sole part, excludes periodic seams, and previews one fillet feature before Apply. Without a radius it uses the manual tool's default of 2 document units. Explicit radius units are converted to document units. Unsupported corner combinations refuse the entire proposal and preserve the original part; joined box corners are covered, while concave bracket corners remain a kernel limitation. The viewport fillet/chamfer card also offers **Select all edges**.

**Auto-parameterize model** is a provider-free verified recipe. It replaces independent literal native dimensions with named parameters, and binds kernel-proven imported through holes, blind holes, counterbores, and countersinks as one operation per physical feature. Counterbore bore diameter, outer diameter, and depth stay grouped; countersink bore diameter, opening diameter, and proof-authoritative included angle stay grouped. Exact preview must prove that body geometry is unchanged before Apply is enabled; sketch line/arc coordinates and unrecognized imported features remain untouched rather than guessing design intent.

## Configuration

OpenRouter is the default provider. For local development, export the key in the launching shell or set it in `apps/web/.dev.vars` (git-ignored):

```dotenv
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here
AI_MODEL=nvidia/nemotron-3.5-super-vl:free
AI_DEPLOYMENT_FREE_ENABLED=true
```

Runtime bindings are configured as Wrangler vars or secrets:

- `AI_PROVIDER` — `openrouter`, `openai`, or `responses-compatible`.
- `OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `AI_API_KEY` — the server-side secret for the configured provider; `AI_API_KEY` is never sent to OpenRouter (see below). Never shipped to the browser or committed.
- `AI_BASE_URL` — optional endpoint override; required for `responses-compatible`.
- `AI_MODEL` — defaults to `nvidia/nemotron-3.5-super-vl:free` on OpenRouter or `gpt-6-luna` on direct OpenAI. Personal model settings remain independent; users can choose another exact provider model identifier with their own key.
- `AI_REASONING_EFFORT` — `low`/`medium`/`high`/`xhigh`, default `high`. Personal settings also offer the provider's default and, where the model allows, Off.
- `AI_MAX_OUTPUT_TOKENS` — default `32000`; reasoning shares the budget, and too low a ceiling truncates patches mid-stream as a normal incomplete response.
- `AI_SITE_URL` / `AI_APP_NAME` — optional OpenRouter attribution.
- `AI_ALLOWED_BASE_URL_HOSTS` — exact, comma-separated hostnames approved for saved Responses-compatible endpoints outside development. Redirects are never followed.
- `AI_ACCOUNT_RATE_LIMIT_REQUESTS` / `AI_ACCOUNT_COST_LIMIT_UNITS` / `AI_ACCOUNT_CONCURRENCY_LIMIT` — Free account limits; defaults are 6 requests and 24 weighted units per 10 minutes, with 2 concurrent requests. Premium account limits default to 600 requests and 2,400 weighted units per 10 minutes, with 8 concurrent requests. See [account tiers](plans/account-tiers.md) for overrides.
- `AI_DEPLOYMENT_FREE_ENABLED` — opt in to built-in AI for every signed-in account, only with an OpenRouter `:free` model and the standard endpoint. Enabled in the checked-in configurations. A missing `OPENROUTER_API_KEY` leaves the public free assistant unavailable, without falling back to a paid provider.
- `AI_ENCRYPTED_FREE_TRAINING_ENABLED` — opt in to the built-in free model on encrypted projects after each user consents for the project to possible retention and training. This applies only to the public free OpenRouter deployment route. The hosted configurations enable it. Self-hosted deployments keep stricter encrypted routing by default.
- `AI_DEPLOYMENT_ALLOWED_EMAILS` — optional secret, comma-separated email allowlist for accounts permitted to use a paid or private deployment model. Premium membership also grants this access.

Funding AI from the deployment's own provider key needs the provider secret. The built-in free OpenRouter model admits every verified account with `AI_DEPLOYMENT_FREE_ENABLED`; paid or private models require Premium membership or `AI_DEPLOYMENT_ALLOWED_EMAILS`. Without the provider key, users supply their own tokens instead.

Signed-in users can instead store a personal provider token (Settings → AI) for OpenRouter, OpenAI, Anthropic (default model `claude-sonnet-5-5`; the deployment itself has no Anthropic key binding) or a Responses-compatible endpoint. Tokens are encrypted with AES-GCM by the Worker (`SETTINGS_ENCRYPTION_KEY`) and never enter project documents or browser storage. `GET /api/assistant/status` never exposes provider secrets or deployment availability to a signed-out or ineligible request. Public request identities use HMAC-SHA-256 values keyed by `AI_IDENTITY_PEPPER`.

## The built-in free model

The built-in assistant uses **NVIDIA Nemotron 3.5 Super VL (free)** through OpenRouter: it reads attached drawings and images, reasons, and enforces the CAD reply's JSON schema natively. (It replaced MiniMax M3.1 Flash (free), which OpenRouter withdrew on 2026-11-14.) It has no personal-key requirement or model usage charge, but account quotas, shared OpenRouter free-tier limits and provider availability apply; free access is not unlimited or guaranteed. Free-model requests keep the exact `:free` model identifier and cap prompt, completion and per-request provider prices at zero. They never substitute a paid model.

A model chosen in `AI_MODEL` or personal settings may lack native schema enforcement. MiniMax M3.1 Flash, for one, supports JSON output [without native JSON-schema enforcement](https://openrouter.ai/minimax/minimax-m3.1-flash:free). Its requests therefore include the exact capability-filtered CAD reply schema in the system prompt and use JSON mode on the Chat Completions endpoint. The Worker buffers the bounded response and checks every required field, value type, enum, numeric/array/pattern constraint and extra key against that schema, then runs the existing semantic CAD reply parser with the current digest. Only valid output is returned to the client. Invalid output becomes a sanitized failure event; the existing client retry makes at most one new request, with corrective schema instructions, a fresh account quota permit and the same free model/price caps. A second invalid reply fails closed. Connection tests use the same validation. Native-schema providers retain strict structured output.

## Data handling

Settings → AI Assistant explains that prompts, conversation, compact model context and user-selected attachments go to the AI service. OpenRouter and its model providers may retain data or use it for training and service improvement according to their [data policies](https://openrouter.ai/docs/guides/privacy/provider-logging). The notice does not claim zero retention or that a personal key prevents training; the selected provider’s policies and charges apply. Raw STEP files and meshes are not sent.

The assistant cannot read an end-to-end encrypted project's ciphertext. On an encrypted project it asks each user once per project, listing exactly what leaves the device, before any request reaches the AI provider.

## Limitations and gates

- **Assistant usage is bounded before provider dispatch** — beta requests require a verified account and server-granted hosted-AI access, D1-backed per-account request and token-weighted cost quotas, and per-account expiring concurrency leases. There is no shared deployment usage cap; provider-side billing controls remain separate.
- Deterministic contracts are implemented for face-attached sketches, multi-profile extrudes, mirror, shell, solid offset, transforms, edge modifiers, patterns, datum geometry, and the existing validated direct-edit subset. The checked-in configurations enable the mature operation families, partial revolve, and datum-plane and datum-geometry proposals behind independent `AI_PATCH_*_ENABLED` flags; client capability negotiation also limits the operations offered to each browser. Growing-holder hole controls remain disabled. Topology-dependent proposals must repeat the exact digest witness and are rejected when stale. Configuration describes rollout intent; it is not proof of a live deployment.
- Exact `add_direct_edit` coordination for proved imported blind holes, counterbores, and countersinks is enabled in `AI_CAD_OPERATION_CAPABILITIES`; the standalone `recognized_imported_feature` operation name remains unsupported. Diameter changes re-cut ordinary proved holes, while blind/counterbore depth changes, countersink angle changes, and diameter changes on a counterbore with an entry chamfer fail with an explicit not-yet-supported error. Proposals cannot import geometry or perform collaboration actions.
