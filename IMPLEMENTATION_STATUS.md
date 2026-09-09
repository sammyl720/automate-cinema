# Implementation status — OpenAI creative and speech

## Implemented

- Opt-in per-project OpenAI concepts, scripts, storyboards and TTS-1 narration.
- Strict JSON Schema responses, local validation, versioned prompts and source-ID checks.
- Persisted paid API calls, cost calculations and budget reservations; completed results replay without another request.
- Unknown paid outcomes retain reservations and pause instead of retrying automatically.
- Scene speech sources, fitted narration timeline and scene-aligned captions.
- Dashboard provider choices, voice choice, request ledger and synthetic-speech disclosure.
- Detailed [credential setup](docs/OPENAI_SETUP.md) and [usage guide](docs/SETUP_AND_USAGE.md).

## Validation

The original Documents checkout was offloaded by iCloud again. A separate working copy has been recovered under `~/Developer/automate-cinema-recovered`. See [recovery notes](RECOVERY.md).

Using Node 23.8.0, full-project TypeScript checks, lint, all **28 tests**, and the production build passed. Tests include a real FFmpeg render/package workflow, queue recovery, authentication, mocked OpenAI responses, budget accounting, paid-result replay and speech fitting. No live OpenAI request was made; account billing, key permissions and model access remain unverified.

Use Node 22.13+; this machine's default shell Node was 22.2.0, which lacks node:sqlite. `.nvmrc` pins the installed and tested 23.8.0.

```sh
nvm use
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run dev:studio
```

## Dependency maintenance

Miniflare’s image dependency is overridden to Sharp 0.35.4, the patched release for [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). Remove the override when the upstream dependency includes the fix.

## Remaining product scope

Existing projects stay on development providers. Video remains a test pattern. Real AI video, publishing, independent factual verification and automatic billing reconciliation are not implemented. See the setup guide for enabling OpenAI on a new project.

## Backup and continuous checks

`npm run backup` creates a verified offline database/media backup outside the repository. `--verify` checks an existing backup. Tests cover committed WAL data, corruption, missing assets and unsafe paths. GitHub Actions is configured to run type checking, lint, tests and the build on pushes and pull requests.

The first backup of the recovered studio was created and independently verified: one database and eleven media files, preserving four projects. No credentials or backups are committed.
