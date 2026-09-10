# Enable OpenAI creative generation and narration

OpenAI is now an implemented, opt-in provider for concepts, scripts, storyboards and spoken narration. Video is selected separately: Runway supplies real clips, while development produces free test patterns. See the [MVP guide](MVP_QUICKSTART.md). Publishing is still disconnected.

Existing projects keep their original development behavior. Provider selection is made when creating a new project; simply adding a key never converts existing projects into paid workflows.

## Runtime and project folder

Use Node 22.13 or newer; run `nvm use` in the project folder to select the tested Node 23.8.0. Follow the [setup guide](SETUP_AND_USAGE.md) for installation. Keep the working copy outside iCloud-synced Desktop/Documents.

## Credentials

1. In your own OpenAI API account, create a project API key using the [API key settings](https://platform.openai.com/api-keys). Make sure that project has API billing and access to `gpt-4.1-mini` and `tts-1`. The studio cannot grant model access or provision billing.
2. Stop the studio, then open its root `.env` in your editor. If it does not exist, copy `.env.example` without replacing an existing file.
3. Set the key locally:

   ```dotenv
   OPENAI_API_KEY=your_actual_project_api_key
   OPENAI_TIMEOUT_MS=90000
   ```

   The example is a placeholder. Do not put your real key in `.env.example`, a prompt, a browser-exposed variable, Git or chat. `STUDIO_TOKEN` is the separate local dashboard password; it is not an OpenAI key.
4. Keep `.env` readable only by your user (`chmod 600 .env`) and restart with `npm run dev:studio`.
5. Open Providers. **Configured** means a key exists in the server environment; it is not a claim that billing/model permissions have been verified. The first real request verifies access. Missing credentials show **Authentication required**.

The all-in-one command loads `.env`. For separate API and worker processes, use `node --env-file=.env --import tsx server/index.ts` and `node --env-file=.env --import tsx server/worker.ts`. Both must receive the same key and data directory. The browser receives provider status only, never the key.

## First paid preview

Create a new project with these settings:

- **Creative provider:** OpenAI
- **Narration provider:** OpenAI
- **AI voice:** Alloy, Echo, Fable, Onyx, Nova or Shimmer
- **Creative control:** Assisted
- **Story type:** Fiction for the first run
- **Duration:** 15 seconds
- **Maximum budget:** a small amount you are comfortable spending, such as $1

Try: “A lighthouse keeper sees a faint answer across an empty ocean. A three-shot story of isolation, discovery and hope.”

Choose **Run workflow**. This authorizes paid concept, script and storyboard requests for that project. Assisted mode pauses before video generation; it does not make the earlier text requests free. Inspect the concept and script, generate the free test scenes, then choose **Generate AI narration**. The studio generates each scene’s speech, fits it to its allotted duration, and assembles an audio timeline. Render, evaluate and package the film, or resume the workflow to complete those stages automatically.

You can also choose development creative with OpenAI narration, or OpenAI creative with development audio. Selecting only the capabilities you need limits spending. Projects using development for both make no OpenAI calls.

## Narration behavior

- Each scene gets a separately persisted speech source, voice/model metadata and a paid-request record.
- Short speech is padded with silence to fit the scene. Speech requiring at most 25% acceleration is fitted without cutting off the final words.
- Longer speech fails with a request to shorten the narration. Edit that scene, regenerate its preview footage, then generate the new revision’s narration and render again. New revision speech is a new paid request.
- Caption timing follows scene starts and measured speech duration. It is **not word-level alignment**.
- Every OpenAI narration asset and delivery package identifies the voice as AI-generated. The remaining video test patterns are also disclosed.

## Cost accounting and recovery

Generations now includes **AI requests & calculated costs**, showing request IDs, stages, attempts, estimates, returned token/character usage and calculated spend. The project’s budget includes both its spent amount and outstanding reservations. Costs are computed from published standard rates, not imported from a billing invoice.

The implementation currently uses fixed supported models and standard rates checked on 2026-09-08:

| Model | Basis |
| --- | --- |
| GPT-4.1 mini | $0.40 / million input tokens, $0.10 / million cached input tokens, $1.60 / million output tokens |
| TTS-1 | $15 / million input characters |

Rates and models are centralized in `server/openai-client.ts`. Verify current pricing before changing models or using a different pricing tier. Text calls have an output-token cap and a conservative input reservation. A budget limit applies before each API call, not as a promise that an entire future project will complete for that amount.

Completed responses are saved and reused when a job replays, so a worker interruption after receipt does not ordinarily purchase the same output again. Explicit authentication/validation rejections release their reservation. Rate limits use the existing bounded retry policy.

A connection loss, timeout, server error, unreadable response or interrupted request with no saved outcome may represent billable work. Such requests keep their reservation and block automatic resubmission. Inspect the saved request ID and provider billing before retrying or authorizing new work. There is not yet an automatic billing reconciliation service; do not clear reservations blindly.

Malformed structured creative output and provider refusals pause the workflow. An already completed API request can still cost money even if its content cannot be used. The saved response is reused on retry; retrying the same invalid response will not fix its content or generate a new paid answer.

## Limits

The MVP now includes a Runway video adapter. Visual critique, automated research retrieval and publishing remain unavailable. Factual prompts receive the human-verified source records and script source IDs are checked, but that is not an independent factual-verification model. Review all factual claims and source support yourself.

API integration tests use mocked HTTP responses and generated audio fixtures. A passing test suite does not establish that your particular key, account billing or model access works. No live credentials are required for tests or the default CLI demo.

## Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| OpenAI authentication required | Set `OPENAI_API_KEY` on the server, restart, and create the project again. |
| Configured but HTTP 401/403/404 | Verify the key, project permissions and access to the named model. Provider error bodies are not logged to avoid exposing sensitive data. |
| HTTP 429 | Check account limits and billing; bounded retries may follow. |
| Project budget cannot cover request estimate | The next request's reservation exceeds the remaining budget. Use a new project with an appropriate budget; there is no budget editor yet. |
| Creative output failed validation | Inspect the paid request/prompt record. The job pauses instead of inventing missing fields or silently retrying at cost. |
| Scene speech is too long | Shorten that scene’s narration and create a new revision. |
| Uncertain outcome / reservation retained | Check the provider request and billing before authorizing another paid attempt. |
| Real narration but plain colored video | Expected: this milestone replaces creative text and speech, not video generation. |

## Official API references

- [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Text-to-speech and AI voice disclosure](https://developers.openai.com/api/docs/guides/text-to-speech)
- [GPT-4.1 mini model and pricing](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- [TTS-1 model and pricing](https://developers.openai.com/api/docs/models/tts-1)
