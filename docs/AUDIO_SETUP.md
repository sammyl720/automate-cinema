# ElevenLabs narration and instrumental music

You can select ElevenLabs for narration, music, or both. OpenAI narration remains available. Music defaults to **none** and existing projects keep their selected providers. These options currently apply when creating a new production; create a new production to change an existing film's audio settings.

## Credentials

1. Sign into [ElevenLabs](https://elevenlabs.io/) and open your account's Developers / API Keys area. Create a key with access to Text to Speech and/or Music for the features you intend to use. Ensure the account has credits and access to those APIs.
2. In the **active checkout**, edit the existing `.env` (do not overwrite it). Add `ELEVENLABS_API_KEY=your_key_here`. Keep it server-side; never put it in a browser field, commit it, or prefix it with `VITE_`.
3. Restart `npm run dev:studio` using the Node version in `.nvmrc`. The Providers screen should show ElevenLabs as configured. This only confirms a key is present; API permissions and billing are checked on the first request.
4. In the ElevenLabs voice library, select a voice available to your account and copy its **voice ID**, not its name or URL. You can preview voices there before generating a film. The form starts with the voice ID used in ElevenLabs' API example; replace it with your preferred voice if unavailable.

## Create a film

1. Choose **New production**. Select video and creative providers as usual. You can use development visuals to test paid audio inexpensively.
2. Select narration provider **elevenlabs**, paste the voice ID, and start with stability **0.5** and style exaggeration **0**. Lower stability gives more variation; higher stability gives more consistent delivery. Increase style cautiously. Narration uses `eleven_multilingual_v2`, with neighboring scene text supplied for continuity.
3. Select music provider **elevenlabs** to enable Eleven Music (`music_v2_5`), our Suno-like music generation option. Suno itself is not integrated. Describe instrumentation, mood, pacing, and the emotional arc, for example: “Sparse felt piano, warm strings, restrained hopeful build, no percussion, space for a calm narrator.” Music is forced instrumental.
4. Start music level at **-12 dB**. More negative values make it quieter (range -40 to 0). This attenuates the normalized music bed; automatic ducking reduces it further when narration is present. Assembly adds fades and a peak limiter.
5. Use assisted mode, run the workflow, and review the script/storyboard before generating scenes. Keep narration short enough for each shot. Resume **Run workflow** after the review; audio stages run after video, followed by rendering and packaging. Manual mode offers separate narration, soundtrack, and render actions.
6. Listen to the finished render and the separate audio assets. Confirm pronunciation, pacing, soundtrack balance, and the ending before release. Captions follow scene speech timing, not word-level alignment. Speech that needs more than 1.25× speed to fit stops with an error so you can shorten the script.

## Costs and recovery

The server reserves estimated cost against the project budget before each paid request. Default estimates, checked against [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) on September 18, 2026, are $0.10 per 1,000 narration characters and $0.15 per minute of music. For example, 250 characters plus 15 seconds of music estimates $0.0625, excluding other providers and taxes. Subscription allowances and actual invoices may differ. Override `ELEVENLABS_TTS_USD_PER_1000` and `ELEVENLABS_MUSIC_USD_PER_MINUTE` in `.env` to match your account, then restart.

Completed requests reuse the locally saved audio on job replay. A network interruption or server error retains the reservation and blocks automatic paid retries because the provider may already have charged. Inspect the request ID and provider billing before purchasing again. Missing paid media must be restored from backup. The API timeout is 150 seconds; longer generations can require manual reconciliation. Keep `JOB_TIMEOUT_MS` at least 180000.

A 401/403 usually indicates key or permission issues; a rejected voice may be unavailable to that account. A 429 receives bounded retries. Never post your key when asking for help. Review the provider's current music/voice terms and your plan's distribution rights before publishing; exported packages disclose synthetic audio.

API references: [speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert), [music](https://elevenlabs.io/docs/api-reference/music/compose). Local tests mock these paid APIs and exercise real FFmpeg assembly; they do not establish live voice or composition quality.
