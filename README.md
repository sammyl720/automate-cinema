# Frame / Work — Cinematic production studio

A runnable local vertical slice of an autonomous cinematic content platform. Develop concepts, select a direction, create a structured script and storyboard, run persistent generation jobs, review assets, render an MP4 with FFmpeg, and export platform packages.

**Development mode remains free and deterministic.** You can now opt into OpenAI for real concepts, structured scripts, storyboards and spoken narration when creating a project. Choose Runway for real Gen-4.5 video, or development for free test patterns. Publishing and analytics remain disconnected.

See [Enable OpenAI creative generation and narration](docs/OPENAI_SETUP.md) for API-key setup, per-project choices, cost reservations and a first paid preview.

## MVP quick start

See [Brief to an AI-generated film](docs/MVP_QUICKSTART.md) for the two API keys, the AI MVP preset, costs, recovery behavior and the first film workflow.

## Detailed setup and usage guide

See [Setup, credentials and daily use](docs/SETUP_AND_USAGE.md) for password setup, login, provider-credential availability, a complete dashboard walkthrough, configuration, backups and troubleshooting.

## Quick start

Requirements:

- Node.js 22.13+ (tested with 23.8; `node:sqlite` may print an experimental warning).
- npm, FFmpeg and FFprobe on PATH. On macOS: `brew install ffmpeg`.
- Ports 3001 (dashboard) and 4311 (API) available.

Keep the checkout outside cloud-synced Desktop/Documents folders. For a fresh installation:

```sh
mkdir -p ~/Developer
cd ~/Developer
git clone https://github.com/sammyl720/automate-cinema.git
cd automate-cinema
nvm use
npm ci
if [ ! -f .env ]; then cp .env.example .env; fi
npm run dev:studio
```

For later starts, run `nvm use` and `npm run dev:studio` from the project folder. Run `npm ci` only for initial setup or a deliberate dependency reinstall, with the studio stopped.

Open **http://localhost:3001**. This single command seeds missing example data, starts the API, starts the persistent worker, and starts the dashboard. Existing records are preserved. Stop it with Ctrl+C.

`npm start` is an alias for this local studio. It is not a production deployment command. `npm run dev` starts only the frontend, useful when running the API and worker separately.

No API keys, Redis, PostgreSQL, cloud accounts, or paid generation services are required. Files and SQLite data live under `data/`, excluded from Git. With all studio processes stopped, run `npm run backup` to save and verify the database and media outside the repository. See the setup guide for verification and restoration; do not delete data to restart a workflow.

### Run a complete demo from the terminal

```sh
npm run demo
```

This creates a new 6-second autonomous fiction project, runs all stages through packaging, prints its MP4 path, and exits. It runs its own worker and works even when the dashboard is stopped. The video export is 1080 × 1920, 24 fps, H.264 with AAC audio. The development assets remain clearly labeled.

### Use the dashboard

1. Open a seeded production or choose **New production**. Use 6–15 seconds for a quick local demo.
2. Choose **Run workflow** in assisted mode. It develops and selects a concept, writes a script, creates a storyboard, then pauses before generation.
3. Inspect the **Concepts**, **Script**, and **Storyboard** tabs. In manual mode, select the concept yourself before writing the script.
4. Choose **Generate scenes**. Inspect persistent jobs in **Generations** and media in **Assets**.
5. Once scenes complete, choose **Generate test audio** (or **Generate AI narration** for OpenAI), **Render film**, **Evaluate render**, then **Create platform packages**. Alternatively resume **Run workflow** after authorizing generation.
6. Use **Review** to play/download the assembled film and **Delivery** for video, captions, thumbnail and platform JSON files.
7. Edit or regenerate a scene to create a new revision. Previous assets and generation lineage remain in the library; previous delivery packages are invalidated.

Factual projects, including the Saturn example, require a source URL, a specific claim and explicit human verification in **Research**. The app does not fetch the URL or claim automated fact-checking.

## Commands

| Command                            | Purpose                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `npm run dev:studio` / `npm start` | All local services and dashboard                              |
| `npm run api`                      | API only; default loopback port 4311                          |
| `npm run worker`                   | Separate persistent worker                                    |
| `npm run seed`                     | Add example data to an empty database                         |
| `npm run demo`                     | Full development render workflow                              |
| `npm run typecheck`                | TypeScript checks                                             |
| `npm run lint`                     | Application lint checks; generated UI primitives excluded     |
| `npm test`                         | Domain and integration tests, including real FFmpeg rendering |
| `npm run build`                    | Build the Sites/Vinext frontend                               |
| `npm run format`                   | Format source                                                 |

Tests use a temporary database and media directory, mock external providers, and remove temporary files. No paid API requests are made. The render integration test requires FFmpeg/FFprobe.

## Configuration

See `.env.example` for defaults. `dev:studio` reads `.env`; individual commands can receive variables from their shell. OpenAI is `configured` when a server key exists; account access is checked on the first request. Runway, ElevenLabs and TypeSafe Jev are also opt-in integrations; configured means a key is present, not a successful live account check.

| Variable                      | Meaning                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `STUDIO_HOST`                 | API bind address; default `127.0.0.1`                                                 |
| `STUDIO_PORT`                 | API port; default `4311` (update Vite proxy if changed)                               |
| `STUDIO_DATA_DIR`             | SQLite and managed media directory                                                    |
| `STUDIO_ORIGIN`               | Exact allowed browser origin, default `http://localhost:3001`                         |
| `STUDIO_TOKEN`                | Optional local studio password; at least 32 characters required on non-loopback binds |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Executable locations                                                                  |
| `OPENAI_API_KEY` | Optional server key for explicitly selected OpenAI creative/speech |
| `OPENAI_TIMEOUT_MS` | Timeout for one OpenAI request, default 90000 ms |
| `WORKER_CONCURRENCY`          | Maximum concurrent jobs across projects; 1–8, default 2                               |
| `JOB_TIMEOUT_MS`              | Job timeout, default 180000 ms                                                        |

A configured studio token is submitted through the dashboard login and retained in an HttpOnly, SameSite=Strict session cookie. API clients may use `Authorization: Bearer <token>`. This is a single-user boundary, not multi-tenant identity. Use TLS and a proper identity gateway before remote access. The OpenAI key is read only from the server environment and is never sent to the browser. Database credential storage is not implemented.

## Implemented and deferred

Implemented: persistent workflows, bounded retries/cancellation/timeouts, resumable queue leases, deterministic concepts and independent hook scores, structured scripts/storyboards, cinematic prompts with a creative bible, prompt/generation history, budget reservations, scene revisions, local managed assets, three aspect-ratio exports, audio normalization, SRT/WebVTT, technical export evaluation, platform packages, seed data and tests.

Deferred: live research; music and image generation; reference uploads; S3 and PostgreSQL adapters; multi-user workspaces; credential encryption/webhooks for real providers; automated moderation and rights review; semantic vision/film critique; autonomous creative revision; word-level alignment/burned captions; layered audio ducking; social publishing; analytics ingestion; experiment management. Interfaces and extensible records provide starting points, not working integrations for these features.

The local API and FFmpeg worker cannot run inside a Cloudflare Worker. The frontend build alone is therefore **not a deployable full studio**. A hosted version needs a reachable authenticated Node API/worker and durable storage, or a separate hosted backend implementation. No incomplete frontend-only service has been published.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for domain boundaries, recovery semantics, limitations and the next implementation order.

## Automated checks

GitHub Actions runs type checking, lint, tests (including real FFmpeg rendering and backup verification), and the production build on pushes and pull requests. It uses development providers and mocked OpenAI responses, requiring no provider credentials.

### Narration and music options

Select ElevenLabs narration and optional Eleven Music when creating a production. See [audio setup](docs/AUDIO_SETUP.md) for credentials and usage.

### Independent evaluation with Jev

Choose **Decision evaluator → jev** for independent concept judgments, confidence-aware automatic selection, and a storyboard preflight before video generation. See [Jev setup](docs/JEV_SETUP.md) for credentials, thresholds, costs and recovery. Development remains the default.
