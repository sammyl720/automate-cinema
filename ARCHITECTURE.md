# Architecture

## Scope and architectural decision

The repository was empty. The first delivery is a complete, testable local production flow through platform packaging, with development video and opt-in OpenAI creative/speech providers. It deliberately does not impersonate unavailable AI or publishing integrations.

The modular monolith has three process roles:

```text
React / Vinext / Sites frontend :3001
          │ same-origin /api and /media proxy
          ▼
Node HTTP API :4311 ── SQLite WAL + domain records + jobs
                                      ▲
                               Node background worker
                                      │
                       provider adapters → managed files
                                      │
                            FFmpeg / FFprobe subprocesses
```

The Sites scaffold supplies React, TypeScript, Tailwind and accessible Base UI/Shadcn primitives. The API and worker use Node because FFmpeg, filesystem storage and SQLite are needed for the requested local demonstration. The frontend's Cloudflare build does not package or host those processes.

SQLite rather than PostgreSQL is a deliberate local milestone tradeoff: no Docker/database account is required, and the entire demo is reproducible. This is not a claim that JSON records are a complete relational production schema. A multi-tenant deployment should move to PostgreSQL with explicit foreign keys, tenant keys and normalized high-volume entities.

## Code map

- `shared/domain.ts`: Zod inputs and domain DTOs, shared by API and frontend.
- `server/config.ts`: validated startup configuration and non-loopback token requirement.
- `server/migrations/001_initial.sql`: initial schema, indexes and migration marker.
- `server/db.ts`: WAL connection, immediate transactions, persistence and events.
- `server/service.ts`: domain operations, workflow transitions, review and autonomy gates.
- `server/queue.ts`: durable enqueue, unique keys, claims, leases, retry and cancellation.
- `server/worker.ts`: concurrency, timeout and cancellation supervision, workflow progression.
- `server/creative.ts`: development creative services, central prompt versions and continuity injection.
- `server/providers.ts`: capability registry and video, image, narration and publishing interfaces.
- `server/handlers.ts`: bounded job handlers for the creative/media pipeline.
- `server/media.ts`: managed media paths, FFmpeg assembly, probing and caption export.
- `server/index.ts`: HTTP routing, input validation, session gate, rate limit and byte-range media delivery.
- `lib/studio-api.ts`: typed browser transport and display helpers.
- `app/page.tsx`: dashboard presentation and user interactions.

## Domain and persistence

All creative entities use UUIDs, creation/update timestamps and optional soft deletion. `records` stores a discriminated `kind`, optional indexed `project_id` and validated JSON data. Projects, concepts, script versions, scenes, scene revisions, assets, evaluations, research sources, prompt executions, generations, platform packages and events are persisted. Jobs use an independent indexed table with explicit scheduling columns and a unique idempotency key.

Assets retain provider, prompt, parameters, scene/project association, size, dimensions, duration, cost, revision and parent-asset lineage. The local path is controlled by the application; no media depends on expiring provider URLs. Prior script and scene revisions remain available after an edit.

The initial migration is idempotently applied at startup and records version 1. Add ordered migrations and a migration runner before introducing schema versions beyond this first one. Database access is confined to the backend; no secrets or database credentials enter client bundles.

The creative bible currently belongs to a project and contains palette, visual rules and character descriptions. It is injected by the prompt builder. Series-wide inheritance, reference assets and character management remain future modules.

## Workflow and autonomy

```text
idea → concept_selected → script_drafting → storyboarding
     → assets_planned → generating → assembling → evaluating
     → approved → packaged
```

The domain declares the larger lifecycle including research, revision, scheduling, publication and analytics. Unimplemented publishing states cannot be entered through a fake success path. `approved` means technical export acceptance in this milestone, not editorial approval of finished media.

Manual mode waits between major steps and does not automatically select a concept. Assisted mode develops the story and pauses at `assets_planned`; generation requires a separate action. Autonomous mode advances through packaging. Publishing is always disabled and the publishing adapter returns an explicit unsupported failure.

Factual projects cannot develop concepts until the user has recorded at least one verified source/claim. This is a human attestation gate, not a guarantee that every subsequent claim is grounded. Real factual scripting requires claim-level source bindings and an independent verification pass before enabling live providers.

The reconciler inspects persisted states after restarts and schedules the next eligible stage. Failed jobs pause automation without deleting completed outputs. Cancellation stops automatic progression; a currently running subprocess is aborted by worker polling. Pause stops progression while allowing current jobs to finish.

## Queue and recovery

Enqueue uses a unique project/stage/revision or scene/revision key. Duplicate enqueue requests refer to the same job. The API acknowledges work immediately; expensive operations execute only in the worker.

`BEGIN IMMEDIATE` makes claim/update atomic. At most one job runs per project; separate projects can run concurrently. Every claim increments its attempt count and records a lease. Expired leases are reclaimed after a crash; exhausted jobs fail. Retries use capped exponential backoff and at most three dispatch attempts. Domain errors, such as budget exhaustion, are terminal. The queue schema includes priority, and claims order by priority then age.

The worker aborts subprocesses on timeout, cancellation or shutdown. Lease duration exceeds the configured timeout by 30 seconds. This design assumes bounded operations, not arbitrarily long external generation calls. A future asynchronous vendor should split submission and polling into durable jobs rather than hold a worker slot indefinitely.

The development provider writes deterministic filenames keyed by scene/revision. Generation reservations are persisted before dispatch and reused after an interrupted attempt. A real provider must support its own idempotency keys or reconcile a persisted request ID before resubmission: local queue deduplication alone cannot guarantee exactly-once external billing.

Asset writes and external work cannot be one SQLite transaction. Completed handlers inspect durable outputs where possible; an interrupted render may be safely repeated. Failed/partial local files are never served as assets until a successful asset record is created. Disk quotas and orphan-file cleanup are production follow-ups.

## Costs and generation

A generation reserves its estimate transactionally, counts against total project attempts and per-scene regeneration limits, then calls the routed provider. On completion, reserved spend is released, actual cost is recorded and the asset is linked. On failure, reservations are released; attempted work remains traceable. Budgets count attempts even when a free development render fails.

The development provider charges zero, supports up to 30 seconds per scene and all three aspect ratios, and produces simple test patterns. It never labels output as premium AI footage. Narration produces a quiet sine-wave track with explicit `isSpeech: false` metadata. Scripts and captions preserve the intended narration, but these are not speech-aligned timings.

Routing checks connection state, text-to-video support, duration and aspect ratio before cost-based selection. Unimplemented vendors have `unsupported` status and ineligible capabilities. OpenAI status is configured when its key exists, never falsely reported as verified connected.

## Adding a real provider

1. Implement `VideoGenerationProvider`, `NarrationProvider`, or the relevant interface in a dedicated module.
2. Add truthful capabilities and cost estimates to the registry. Validate its credentials server-side and distinguish missing authentication from unsupported functionality.
3. Register the implementation in `videoProviders`; the handler selects by routed provider ID.
4. For asynchronous jobs, persist request IDs before polling and reconcile uncertain responses. Never resubmit blindly after an API timeout.
5. Validate structured provider output. Download allowlisted HTTPS media into managed storage with size, MIME, duration and decode checks. Add SSRF protection before introducing remote downloads.
6. Keep original prompts, model/settings, version, request IDs, timing, attempts and cost. Never log secrets.
7. Add provider contract tests for timeouts, rate limits, invalid output, cancellation, duplicate submission and price reconciliation before enabling autonomous spending.

There is an image-provider interface but no implemented image workflow. Encrypted stored credentials, signed webhook verification and moderation are required additions when real providers are introduced; unused pseudo-integrations are intentionally absent.

## Storage and rendering

`mediaPath` validates generated storage keys against the managed root. Browser downloads use opaque asset IDs; the API resolves only persisted assets. HTTP byte ranges support playback seeking. Files are not written from arbitrary user-supplied paths, and uploads/remote downloads are not exposed.

`renderTimeline` orders scenes, normalizes frame rate and timestamps, scales and center-crops to the target ratio, concatenates, maps the development audio track, normalizes audio loudness and encodes H.264/AAC. Exports use 1080×1920, 1920×1080 or 1080×1080 at 24 fps. Draft source clips use smaller dimensions for speed; the final container still uses the target dimensions. Upscaling is not additional source detail.

SRT and WebVTT are produced from scene-level canonical narration times. A thumbnail is extracted from the render. Advanced transitions, subject-aware reframing, word alignment, burned-in captions, music ducking and sound-effect mixing are extension work.

FFmpeg receives argument arrays, never a shell-interpolated command. Editable prompts and narration are not interpreted as FFmpeg filters or shell text.

## Evaluation and revision

FFprobe checks for a video stream, target dimensions, expected duration and audio. Evaluations explicitly state that no creative, speech, artifact, copyright or factual review was performed. The numeric score represents only technical checks.

Failed technical checks enter `revision_required` and pause automation. Scene edits/regenerations preserve old records, increment revisions and invalidate evaluations and platform packages. The current implementation supports human-directed regeneration with bounded attempts. A semantic AI critic and autonomous selective revision loop remain future work; no fabricated quality judgement is returned.

## Packaging, publishing and learning

Packaging creates TikTok, Instagram Reels and YouTube Shorts records with platform-specific text lengths, hashtags, media references, thumbnail, subtitles and synthetic/development disclosure. JSON exports refer to managed media files; the dashboard exposes separate downloads. They are not bundled ZIP archives or API-certified publishing payloads.

`PublishingProvider` exists; the unavailable adapter fails explicitly. No publication, schedule or analytics result is fabricated. The pure `contentValue` utility demonstrates a weighted completion/watch/engagement score. Analytics ingestion, publication history, experiments and evidence-based creative memory require actual metrics and dedicated persisted entities before the dashboard can show performance.

## Security and operational limits

The API binds to loopback by default. Optional token authentication uses constant-time comparison and HttpOnly SameSite cookies; non-loopback binding requires a long token. Requests enforce a known Host, exact Origin when present, body-size limits, Zod validation, in-memory rate limits and managed file paths. All API and media routes share the same single-user session gate.

This is not multi-tenant authorization or a hardened public deployment. It has no user/workspace administration, persistent distributed rate limiter, upload scanner, encrypted provider credential store, webhook ingress, moderation service or audit-log retention policy. Do not expose it as a public paid-generation service without implementing those boundaries.

Structured domain events record transitions, job outcomes, retries and generation metadata. Worker/API failures use JSON logs. Node/FFmpeg diagnostic logs are local and no provider secrets are read into them.

## Validation and next slices

Automated checks cover workflow gates, scoring, output validation, capability routing, budgets, retries, queue leases/idempotency, input and Origin rejection, factual gating, actual FFmpeg rendering, byte-range downloads, revision lineage, packaging, and manual/assisted autonomy boundaries. Expensive external providers are never used. The browser WebMCP surface is feature-detected; no compatible tool-validation context was available, so browser WebMCP execution is not claimed as tested.

Next implementation order:

1. Introduce authenticated workspaces, relational PostgreSQL migrations and managed object storage.
2. Extend the OpenAI creative adapter with independent research verification and moderation.
3. Add a production video provider with durable submit/poll/reconcile jobs; extend the implemented speech pipeline with word alignment.
4. Add multimodal asset/film critique, bounded selective revisions and layered audio mixing.
5. Add one publishing platform with explicit publication permission, then analytics and experiments.


## OpenAI creative and speech extension (2026-09-08)

Projects now have `creativeProvider`, `narrationProvider` and `voice` fields, defaulting to development/development/alloy. Missing fields in older records are interpreted as development. The existing JSON record schema accepts these additions without rewriting old projects.

`creative-providers.ts` implements a provider interface for concepts, structured scripts and storyboard direction. The OpenAI adapter uses Responses strict JSON Schema plus local Zod/domain validation, central versioned instructions, source-ID validation and timeline-length checks. Concept scores remain editorial opinions. `narration.ts` synthesizes each scene through TTS-1, preserves source WAVs, fits speech by modest acceleration or silence padding, and exports a complete narration timeline with scene-level captions. Render selection excludes scene-source audio and chooses the complete timeline.

`openai-client.ts` owns fixed API endpoints, bounded response reads, sanitized errors, request timeouts and paid-call accounting. Each `apiCall` record persists project/job/scene IDs, a stable logical key, model, request, outcome, response checkpoint, provider request ID, usage, estimate and calculated charge. Reservations and settlement are immediate SQLite transactions. Completed results are replayed without another network call. Network/server uncertainty retains the reservation and blocks automatic paid retries; reconciliation against provider billing remains a manual operational follow-up. There is no automatic billing reconciliation service.

OpenAI keys stay in the server environment; no key is returned by the API. Project selection opts into paid calls; assisted mode authorizes creative requests when started but pauses before video generation. Rates are centralized and documented in [OpenAI setup](docs/OPENAI_SETUP.md). They are calculations from published rates, not imported invoices. Publishing remains disabled, video remains a development pattern, and all real speech is explicitly disclosed as synthetic.
