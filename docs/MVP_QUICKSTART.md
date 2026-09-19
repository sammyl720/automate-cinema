# MVP: brief to an AI-generated film

This local MVP creates three scenes from a brief, generates their video with Runway Gen-4.5, adds OpenAI narration, assembles an MP4, and provides downloads. You review the script before authorizing video generation. Publishing remains manual.

## 1. Set up the two accounts

Use your project folder outside iCloud, such as `~/Developer/automate-cinema-recovered`, and run `nvm use`. Install dependencies with `npm ci` only for a fresh checkout, with the studio stopped. FFmpeg and FFprobe must be on PATH.

- **OpenAI:** Create a project API key in [API key settings](https://platform.openai.com/api-keys), enable API billing, and ensure access to `gpt-4.1-mini` and `tts-1`. A ChatGPT subscription does not configure these API credentials. See [OpenAI setup](OPENAI_SETUP.md).
- **Runway:** Create a developer account at [Runway Dev](https://dev.runwayml.com), create an organization/API key, and fund its API credits. Runway website subscription credits and developer API credits are separate. The adapter uses `gen4.5` through the text-to-video API.

Stop the studio and edit its local `.env` (copy `.env.example` only if `.env` does not already exist):

```dotenv
OPENAI_API_KEY=your_openai_project_key
RUNWAY_API_KEY=your_runway_api_key
```

Do not paste keys into chat, the dashboard, `.env.example`, or Git. Restrict `.env` to your account with `chmod 600 .env`, then start `npm run dev:studio`. The API and worker must use the same data directory and credentials. A provider's **Configured** badge confirms only that a key exists; the first API request checks access.

## 2. Make a first film

1. Open [the studio](http://localhost:3001/) and choose **New production**.
2. Click **Use AI MVP setup**. This selects Runway video, OpenAI creative generation, OpenAI narration, portrait framing and Assisted control.
3. Enter a title and brief. Start with **15 seconds**, **Fiction**, and a **$5 maximum budget**. Try: “A lighthouse keeper sees a faint answer across an empty ocean. Three shots move from isolation to discovery to hope.”
4. Create the production and choose **Run workflow**. This authorizes paid OpenAI concepts, script and storyboard requests. It pauses before video generation. If no concept meets the editorial threshold, select a concept manually and resume.
5. Review the three scenes. Edit their prompts or narration if necessary. Choose **Generate film** to authorize the Runway clips, selected narration and assembly. The remaining workflow continues automatically.
6. Watch progress in Generations. Remote video tasks are checked between worker runs; closing the browser does not stop the worker. Runway video can take several minutes.
7. Open **Review**, play the assembled film, and choose **Download MP4**. Delivery contains subtitles, a thumbnail and platform metadata. Review quality, factual claims and rights yourself before posting.

All provider choices are per project. Existing development projects stay free and keep their test visuals. Selecting OpenAI narration without Runway video still produces a film with test patterns.

## Scope and price

- Three scenes; total duration 6–30 seconds; each Runway scene 2–10 seconds. Fractional scene durations round up for the generation request and are trimmed in assembly.
- Portrait or landscape. Runway source clips are 720p; the export is resized to the platform dimensions. Upscaling does not add detail. Square output is available only in development mode.
- Runway scene prompts are limited to 1,000 characters. Generated prompts are compacted to that limit; manually edited longer prompts are rejected before submission.
- Standard Gen-4.5 video is **12 credits per requested second**, with credits priced at **$0.01**: about **$1.80 for three 5-second clips**, before OpenAI and tax. Each revision can incur new costs. Rates checked 2026-09-09; verify current pricing before use.
- Estimated video costs are reserved before submission. When available, returned Runway credits determine settlement; otherwise successful tasks use the published rate and are labeled accordingly. These figures exclude tax and are not imported invoices. Unexpected higher provider estimates pause the job and increase its reservation.
- The MVP does not include reference-image identity locking, automated artistic critique, independent fact checking, music generation, publishing or multi-user hosting. Separate text-to-video shots may not preserve a character's appearance perfectly.

## Recovery and cancellation

The studio saves the provider task ID immediately after Runway accepts a request. A restart resumes status checks instead of submitting another paid generation. Completed task results are downloaded into local media storage; retries of a failed download use the same task and do not charge again locally.

If a submission times out before its task ID is saved, its outcome may be billable. The studio retains the budget reservation and blocks automatic resubmission. Check Runway's developer portal before authorizing another revision; automatic reconciliation of an unknown submission is not implemented.

**Pause progression** stops later workflow stages; it does not cancel already queued scene jobs or remote work. Once a Runway submission has started, local cancellation is refused so the worker can retain the result and settle billing. Remote cancellation is not implemented. To stop all local processing, stop the studio process; Runway may still finish and charge. Restart to retrieve saved task IDs.

Tasks still pending after 45 minutes pause the local job. Retry checks the same task again. Authentication or explicit submission rejection releases the reservation; failed/cancelled tasks with reported billing settle that amount. Missing failure billing retains the reservation for review. Inspect the task ID and calculated costs under Generations.

Back up local projects and video with the verified [backup command](SETUP_AND_USAGE.md#11-backups-and-restarts) while the studio is stopped. Git does not include `data/` or credentials.

## Validation

The Runway tests use mocked HTTP responses and real FFmpeg fixtures, covering the full render/package workflow, polling, budget limits, unknown outcomes, refunds and download retry. No live paid request was made during implementation. Your keys, account access and the artistic quality of real generations still need a first paid trial.

## Provider references

- [Runway API setup](https://docs.dev.runwayml.com/guides/using-the-api/)
- [Runway model pricing](https://docs.dev.runwayml.com/guides/pricing/)
- [Runway Gen-4.5 request schema](https://github.com/runwayml/sdk-node/blob/main/src/resources/text-to-video.ts)
- [Runway task response schema](https://github.com/runwayml/sdk-node/blob/main/src/resources/tasks.ts)
- [Runway output storage](https://docs.dev.runwayml.com/assets/outputs/)

### Narration and music options

Select ElevenLabs narration and optional Eleven Music when creating a production. See [audio setup](AUDIO_SETUP.md) for credentials and usage.
