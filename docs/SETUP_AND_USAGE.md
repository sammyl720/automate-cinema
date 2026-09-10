# Frame / Work: setup, credentials and daily use

This guide describes the application that is implemented in this repository. Start with the local development workflow; no paid provider account is needed for demo projects. For real creative text and narration, see [OpenAI setup](OPENAI_SETUP.md).

## 1. What you can connect today

There are two different kinds of credentials:

- **Studio access token:** a password you create to protect access to your local studio. This is implemented.
- **External provider API keys:** credentials issued by AI or publishing services. OpenAI creative/speech is implemented and opt-in per project. Other external adapters are not implemented.

| Service or capability | Current status | Credential needed now? |
| --- | --- | --- |
| Studio dashboard and API | Working locally; optional token authentication | `STUDIO_TOKEN`, if you want a locked studio |
| Development video and audio | Working; test patterns and a test tone | None |
| Deterministic concepts, scripts and storyboards | Working; template-based, not a live model | None |
| OpenAI concepts, scripts, storyboards and speech | Implemented; opt-in per project | Server-side `OPENAI_API_KEY`; see [OpenAI setup](OPENAI_SETUP.md) |
| FFmpeg rendering, subtitles and packaging | Working locally | None |
| Runway Gen-4.5 | Implemented; opt-in real video | `RUNWAY_API_KEY`; see [MVP guide](MVP_QUICKSTART.md) |
| Higgsfield, ElevenLabs | Listed as unsupported | No; keys are not consumed |
| Social publishing and analytics | Not connected | No; OAuth/account connection is not implemented |
| PostgreSQL, Redis and S3 | Not used in this milestone | None |

**Default development projects produce test footage and a tone. OpenAI projects can produce real creative text and spoken narration; choose Runway separately for real video.** Technical export approval is not editorial or factual approval.

## 2. Install and start the studio

### Prerequisites

You need Node.js 22.13 or newer, npm, FFmpeg and FFprobe. The existing installation was tested with Node 23.8. On your Mac, check them with:

```sh
node --version
npm --version
ffmpeg -version
ffprobe -version
```

If FFmpeg is missing and you use Homebrew:

```sh
brew install ffmpeg
```

FFprobe is included with FFmpeg. If Node is missing, install a supported Node version using your existing Node version manager or installer, then reopen your terminal.

### Open the project

For a fresh checkout, use a local folder outside iCloud-synced Desktop/Documents:

```sh
mkdir -p ~/Developer
cd ~/Developer
git clone https://github.com/sammyl720/automate-cinema.git
cd automate-cinema
nvm use
npm ci
```

For daily use of an existing installation, open its project folder, run `nvm use`, and then `npm run dev:studio`. The recovered local copy is named `~/Developer/automate-cinema-recovered`; its dependencies are already installed.

`npm ci` is for initial installation or a deliberate dependency reinstall. Stop the studio first: the command replaces `node_modules`, and running services can lose their dependency files. See [npm’s command documentation](https://docs.npmjs.com/cli/v11/commands/npm-ci/).

If files in an iCloud-synced checkout appear empty, avoid saving blank editor buffers over them. During this project's recovery, macOS reported source files as not downloaded and sometimes returned empty reads despite nonzero file sizes. Use a verified local copy; see [recovery notes](../RECOVERY.md).

Create `.env` only if you do not already have one:

```sh
if [ ! -f .env ]; then cp .env.example .env; fi
chmod 600 .env
```

This preserves any credentials and settings you previously saved. `.env` is ignored by Git; `.env.example` is the shareable template and should contain no secrets.

Start all three services:

```sh
npm run dev:studio
```

Open [http://localhost:3001](http://localhost:3001). Keep that terminal running. This command starts the API on port 4311, a worker and the dashboard on port 3001, and seeds examples only when the database is empty. `npm start` does the same thing.

If the studio is already running, use the existing instance rather than starting another. Ctrl+C in its terminal stops it. Starting it again preserves projects and outputs.

## 3. Set up your studio credential

### Option A: local access without a password

For the simplest development setup, keep these values in `.env`:

```dotenv
STUDIO_HOST=127.0.0.1
STUDIO_PORT=4311
STUDIO_ORIGIN=http://localhost:3001
STUDIO_TOKEN=
```

The API binds to loopback and does not require a token. This is the default local setup. It is not an internet deployment configuration.

### Option B: lock the studio with a token

1. Stop the studio with Ctrl+C if it is running.
2. Generate a random token in your own terminal. On macOS, this command copies a 64-character token to your clipboard without printing it:

   ```sh
   openssl rand -hex 32 | tr -d '\n' | pbcopy
   ```

   Alternatively, use your password manager to generate a random password of at least 32 characters. Use letters and digits to avoid `.env` quoting issues.
3. Open `.env` in your editor. Paste the token after `STUDIO_TOKEN=` and save:

   ```dotenv
   STUDIO_TOKEN=PASTE_YOUR_RANDOM_TOKEN_HERE
   ```

   The text above is a placeholder, not a usable credential. Store the actual token in your password manager as well. Do not paste it into chat, source files or screenshots.
4. Restrict local file permissions if you have not already done so:

   ```sh
   chmod 600 .env
   ```

5. Start the studio again:

   ```sh
   npm run dev:studio
   ```

6. Open [http://localhost:3001](http://localhost:3001). The dashboard will show **Studio authentication required** and an access-token field. Paste your token and choose **Unlock studio**.

The application stores a session cookie with HttpOnly and SameSite=Strict attributes and an eight-hour maximum age. For an HTTPS origin it also sets Secure. This is one shared studio credential, not separate user accounts or per-project permissions. The application shell may load before authentication; project data and media require authentication when a token is configured.

### Change or revoke access

Replace `STUDIO_TOKEN` in `.env`, then restart the studio. Cookies containing the previous token will no longer authenticate. Enter the new token when prompted. There is no dedicated sign-out button yet; clear the browser's site cookies to remove your local session.

To remove the local password, set `STUDIO_TOKEN=` to blank and restart. Do this only intentionally; all requests to that API will then be allowed without a token.

### Why setting a token does not make this a public service

Keep the default loopback address for this guide. Changing `STUDIO_HOST` alone does not configure a public dashboard, TLS, tenant permissions or cloud storage. The server enforces a minimum 32-character token on non-loopback binds, but that check is not a complete hosting solution. Remote deployment requires the architecture work described in [ARCHITECTURE.md](../ARCHITECTURE.md).

## 4. External AI credentials

OpenAI now supports real concepts, scripts, storyboards and spoken narration. Follow [Enable OpenAI](OPENAI_SETUP.md) to set the server key and choose providers for a new project. Existing development projects do not start making paid requests when a key is added.

`VIDEO_PROVIDER_API_KEY` and `VOICE_PROVIDER_API_KEY` remain unused placeholders. Runway real video uses `RUNWAY_API_KEY`; social publishing remains disconnected. See the [MVP guide](MVP_QUICKSTART.md). The first OpenAI request checks account access; a Configured badge only means the server has a key.

## 5. Create your first production

Choose **New production**. For a quick first run, use:

| Field | Example | What it controls |
| --- | --- | --- |
| Working title | The Last Signal | Name in the studio and export metadata |
| Creative brief | A lighthouse keeper discovers a faint reply across a silent ocean. Tell a three-shot story of isolation, discovery and hope. | Source direction for the development creative templates |
| Story type | Fiction | Bypasses the factual-source gate explicitly |
| Creative control | Assisted | Develops the story, then pauses before generation |
| Frame | 9:16 | Vertical output; 16:9 and 1:1 are also available |
| Generation quality | Draft | Smaller test source clips for faster generation |
| Duration | 6 or 15 seconds | Total duration; currently divided into three scenes |
| Maximum budget | 20 USD | Project generation ceiling; development runs cost $0 |

Choose **Create production**. You can open its detail view immediately.

Draft versus final changes the source test-clip resolution. The assembled export still uses the full target dimensions: 1080×1920, 1920×1080 or 1080×1080. Upscaling a draft does not add visual detail.

## 6. Choose how much control to keep

| Mode | Behavior | Your actions |
| --- | --- | --- |
| Manual | Waits between major production steps and before concept selection | Develop concepts, select one, write the script, build the storyboard and launch subsequent stages yourself |
| Assisted | Chooses a scored concept, creates the script and storyboard, then pauses before generation | Review the direction and authorize generation; resume workflow progression when ready |
| Autonomous | Progresses from idea through packaging, within its gates and limits | Supply a brief, run the workflow and inspect results |

Publishing stays disconnected in every mode. **Pause progression** stops automatic advancement; already queued or running work may finish. To stop an individual job, use **Cancel** in the queue.

## 7. Walk through the complete workflow

### Develop and select a concept

In assisted mode, choose **Run workflow**. It generates three concepts, chooses the highest-scoring eligible one, writes a structured script and creates the storyboard. It pauses at **Assets planned**.

For direct control, create a manual project. Choose **Develop concepts**, open **Concepts**, compare the hooks, premises and scoring rationale, then choose **Select this concept**. Choose **Write script**, followed by **Build storyboard**.

The displayed scores are deterministic development-rubric scores. They are not measured retention, actual audience tests or live-model evaluations. Concept selection locks after scripting begins.

### Read the script and storyboard

- **Script:** canonical narration and the purpose, duration, visual direction, lighting and sound design for each scene.
- **Storyboard:** ordered scene cards, start/end times, camera direction and a simple timeline.
- **Edit scene:** editable prompt and narration. Saving creates a scene revision and updates script history; it invalidates that scene's output and prior delivery packages.

If you want to edit before generating, finish the active stage first. The scene editor keeps the project’s selected video provider; reference-image upload is not connected.

### Generate scenes

Choose **Generate scenes**. The request immediately queues work; the worker creates the clips independently of the browser. You can navigate to another tab without cancelling production.

Watch **Generations** for queued, running, succeeded or failed jobs. The global **Generation queue** shows jobs across projects. Completed clips appear on scene cards and in **Assets**.

Expect colored test patterns. They are intentional and are not an indication that the render failed.

### Create audio and render

When every scene has an accepted generated asset:

1. Choose **Generate test audio**. This creates a quiet tone plus SRT and WebVTT from the canonical scene narration. It does not synthesize speech.
2. Choose **Render film**. FFmpeg concatenates scenes, normalizes frame geometry and audio, encodes an MP4, and extracts a thumbnail.
3. Choose **Evaluate render**. FFprobe checks duration, dimensions and the presence of video/audio streams.
4. Choose **Create platform packages** after technical checks pass.

Alternatively, after starting scene generation in assisted mode, wait for active jobs to finish and choose **Run workflow** to continue automatically through audio, rendering, evaluation and packaging.

A passed technical check does not check anatomy, temporal artifacts, narrative quality, factual correctness, rights, music licensing or speech alignment.

### Review and download

Open **Review** to play the assembled film and choose **Download MP4**. Open **Delivery** for TikTok, Instagram Reels and YouTube Shorts package records. Each offers:

- MP4 video;
- SRT subtitles;
- JPEG thumbnail;
- JSON metadata with title, caption, hashtags, disclosure and file references.

Downloads are separate files, not a bundled ZIP. WebVTT and other intermediate files are also available in the asset library. Packaging does not upload anything to a social account or guarantee compliance with a platform's current upload requirements.

### Revise a scene

Open **Storyboard** and choose **Edit scene** to change its prompt or narration. Save, then generate its missing footage again. If you want another generation without changing the prompt, use the scene's circular-arrow **Regenerate** button.

A check-mark button approves a scene. **Reject scene** is inside the scene editor when an asset exists. Rejected scenes must be regenerated before rendering continues.

Revisions preserve old assets and lineage. Generate the new revision's test audio, render, evaluate and package again. Earlier packages are invalidated so they are not presented as current deliverables.

## 8. Factual projects and the Saturn example

A factual project pauses before creative development until there is at least one human-verified source/claim record.

1. Open **Research**.
2. Read a suitable source yourself.
3. Enter its HTTP(S) URL and the specific claim it supports.
4. Set confidence from 0 to 1.
5. Check **I have verified this claim against the source** only after checking it.
6. Choose **Save source**, then develop concepts or resume the workflow.

The app stores your evidence and attestation; it does not retrieve the page or verify it. This gate does not bind every generated sentence to a source. Review all factual narration yourself. The development script templates are not scientific research outputs.

## 9. Budgets, retries and progress

New projects have a maximum spend set in the creation form, at most two regenerations per scene and at most twenty total generation attempts. The latter two defaults are enforced by the backend but are not editable in the current creation dialog.

A failed generation can consume an attempt even when it costs $0. These limits are separate from a job's maximum three dispatch attempts. Transient failures use exponential backoff; invalid workflow operations and exhausted budgets do not retry indefinitely.

- **Queued:** waiting for a worker or the next retry time.
- **Running:** claimed by a worker. Jobs from the same project execute serially.
- **Succeeded:** the stage completed; inspect its assets or output.
- **Failed:** read the reason before retrying. Exhausted jobs cannot be retried indefinitely.
- **Cancelled:** explicitly stopped; retry it, if attempts remain, before resuming that part of the workflow.

Use the project **Activity** tab for workflow events. **Generations** also exposes request IDs, model names, prompts, attempt history and asset lineage. The interface refreshes approximately every two seconds.

## 10. Configuration reference

All values below belong in the root `.env` for the all-in-one command. Restart after changing them.

| Variable | Default | Use |
| --- | --- | --- |
| `STUDIO_HOST` | `127.0.0.1` | API bind address; retain for local use |
| `STUDIO_PORT` | `4311` | API port; changing it also requires updating both proxy targets in `vite.config.ts` |
| `STUDIO_ORIGIN` | `http://localhost:3001` | Exact browser origin allowed to send requests |
| `STUDIO_DATA_DIR` | `./data` | Database and managed media location; relative to the working directory |
| `STUDIO_TOKEN` | Empty | Optional studio access credential |
| `FFMPEG_PATH` | `ffmpeg` | Executable name or absolute path |
| `FFPROBE_PATH` | `ffprobe` | Executable name or absolute path |
| `WORKER_CONCURRENCY` | `2` | Jobs across different projects; allowed range 1–8 |
| `JOB_TIMEOUT_MS` | `180000` | Time limit per job in milliseconds; allowed range 1000–1800000 |

Use `localhost:3001` consistently. Opening the dashboard as `127.0.0.1:3001` while keeping the default origin can reject browser actions because those are different origins. If you change the dashboard port, update both `server.port` branches in `vite.config.ts` and `STUDIO_ORIGIN`.

### Separate processes and environment loading

`npm run dev:studio` and `npm start` load `.env` automatically. The standalone `api`, `worker`, `seed` and `demo` commands do not automatically load it. They use exported environment variables or their defaults.

If you need separate processes with the same `.env`, use these commands in separate terminals, all from the project root:

```sh
# Terminal 1: API
node --env-file=.env --import tsx server/index.ts
```

```sh
# Terminal 2: worker
node --env-file=.env --import tsx server/worker.ts
```

```sh
# Terminal 3: dashboard
npm run dev
```

To run the CLI demo using your custom data directory and FFmpeg configuration:

```sh
node --env-file=.env --import tsx scripts/demo.ts
```

The CLI demo runs directly against local storage and is not an HTTP login client. It does not need to authenticate to the API with your studio token. Existing shell environment variables can override `.env` values; if a setting seems ignored, check how that process was started without printing secrets.

## 11. Backups and restarts

Projects and outputs normally live here:

```text
data/
  studio.sqlite
  studio.sqlite-wal      # may exist while SQLite is in use
  studio.sqlite-shm      # may exist while SQLite is in use
  media/
    <project UUID>/
      <generated and rendered files>
```

Stop all API, worker and demo processes using the data directory before backing up. Database snapshots and media files do not share a transaction; keeping the studio stopped is required for a consistent full backup.

```sh
npm run backup
```

The command loads `.env`, respects `STUDIO_DATA_DIR`, and creates a uniquely named backup under `~/Developer/cinema-backups`. Choose another location with `npm run backup -- --output /path/to/backups`. Keep backups outside the data directory and outside Git. No existing backup is overwritten.

Each backup contains `studio.sqlite`, `media/`, and `manifest.json`. The command uses SQLite's [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html) to include committed database contents, including WAL data. It verifies database integrity, required asset files, byte counts and SHA-256 checksums before publishing the completed backup folder. Incomplete output is removed on a handled failure. `.env` is excluded; store credentials separately in your password manager or secure backup.

Verify a saved backup at any time:

```sh
npm run backup -- --verify /path/to/backups/studio-TIMESTAMP-ID
```

To restore without replacing current data, stop the studio, verify the backup, then copy it to a new directory and use that copy:

```sh
# Replace the example path with the backup directory printed by the command.
backup_path="/path/to/backups/studio-TIMESTAMP-ID"
restored_dir="$(mktemp -d "$HOME/Developer/cinema-restored-XXXXXX")"
cp -R "$backup_path/." "$restored_dir/"
STUDIO_DATA_DIR="$restored_dir" npm run dev:studio
```

The running studio will modify the restored copy; preserve the original backup. Update `STUDIO_DATA_DIR` in `.env` if you want subsequent starts to keep using the restored directory. Run this command instead of another running studio, since ports 3001 and 4311 must be free.

After a normal restart, completed steps remain completed. After an abrupt crash, a running job can remain visible until its lease expires; with default settings this can take roughly 3.5 minutes from its claim. The worker then reclaims it if attempts remain. Do not delete the database to clear a stuck job.

To inspect a restored backup without replacing current data, point `STUDIO_DATA_DIR` at the copied directory and restart. Update the same setting for every API and worker process that should share that studio.

## 12. Troubleshooting

| Symptom | Likely cause and next action |
| --- | --- |
| Cannot reach port 3001 | Start `npm run dev:studio`; read startup output. The terminal must stay running. |
| Port already in use / `EADDRINUSE` | A studio may already be running. Use it or stop the known old process. Avoid starting duplicates. |
| Dashboard loads but projects fail to load | `npm run dev` starts only the frontend. Start the API/worker too or use the all-in-one command. |
| Studio authentication required | Enter the token from the active server's `.env`. Restart after changing it. |
| Invalid studio token after editing `.env` | The API may still be using its old token, or an exported shell value may override the file. Restart the correct process. |
| Origin not allowed | Use `http://localhost:3001` or align `STUDIO_ORIGIN` with the exact browser origin. |
| Providers remain unsupported after adding keys | OpenAI should show Configured after a server restart with its key; other adapters are not implemented. |
| Factual project cannot develop concepts | Add a source, a supported claim and your explicit verification in Research. |
| Assisted workflow stops at Assets planned | Expected approval gate. Choose Generate scenes when ready. |
| Jobs stay queued | Ensure a worker is running against the same data directory; retries also wait for backoff. |
| Running job survives a crash in the UI | Allow its lease to expire and ensure the restarted worker is running. |
| `spawn ffmpeg ENOENT` or `ffprobe ENOENT` | Install the missing executable or set its absolute path in `.env`, then restart. |
| Render times out | Try a shorter draft or lower worker concurrency. Increase `JOB_TIMEOUT_MS` if appropriate. |
| Regeneration or retry limit reached | The configured attempt cap was reached. Do not loop retries; preserve the project's history and investigate the failure. |
| No spoken voice / plain colored video | Expected development output. Choose Runway video and OpenAI narration in a new project for real footage and speech. |
| Old delivery package disappeared after editing | Expected: scene revisions invalidate previous delivery packages. Generate current audio, render, evaluate and package again. |
| Publish does not work | Publishing is explicitly unsupported. Download local packages from Delivery. |
| SQLite experimental warning | Expected on the tested Node version; it is not itself a workflow failure. |

For engineering verification:

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The integration suite renders real test files in temporary storage without contacting paid providers. `npm run build` builds the frontend; it does not deploy the Node API, FFmpeg worker or database.

## 13. A useful first session

Create **The Last Signal** as a six-second fiction project in assisted mode. Run it to the storyboard pause, review the three shots, authorize generation, then resume the workflow. Play the result in Review and download a package in Delivery. Finally, edit one scene and rebuild to see revision history and package invalidation in action.

You will have exercised the entire implemented production flow without any external API credentials or generation charges.
