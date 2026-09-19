# Consistent visuals with image-first production

Image-first production establishes a shared look, generates three starting images from it, and animates each approved image. It addresses a weakness of separate text-to-video requests: each request otherwise invents the subject and setting again. It reduces drift, but does not guarantee identity, anatomy, physics or continuity throughout motion.

## Credentials and startup

Use the existing OpenAI and Runway developer API keys in your local `.env`. No new service or package installation is needed. OpenAI plans the shots; Runway `gen4_image` generates references and starting images; Runway `gen4.5` animates them. The worker needs FFmpeg and FFprobe for image preparation, frame sampling and assembly. See [MVP setup](MVP_QUICKSTART.md) for account and key setup, and [audio setup](AUDIO_SETUP.md) for ElevenLabs narration/music.

After updating code, stop the studio with Ctrl+C in its terminal, then run:

```sh
nvm use
npm run dev:studio
```

Run from the checkout outside iCloud, such as `~/Developer/automate-cinema-recovered`. Refresh the dashboard. Do not overwrite `.env` or delete `data/`.

## New production

1. Choose **New production → Use AI MVP setup**. With Runway video and OpenAI creative selected, **Visual workflow** defaults to **image_to_video**. Choose your preferred narration and music providers separately.
2. Write a focused brief: one recurring subject, one setting, one simple action per shot. Describe appearance, wardrobe and key props explicitly. For a first trial use 6–15 seconds and a budget that covers images, video, planning and audio.
3. Choose **Run workflow**. After the script and storyboard, the project pauses at the visual review stage, including in Autonomous mode.
4. Choose **Plan consistent visuals**. This paid OpenAI request writes a shared reference description, continuity notes, three static starting-image prompts and three concise motion prompts.
5. Read the plan, then choose **Generate reference · $0.08**. Inspect the subject, clothing, props, location and lighting. Choose **Approve shared look** only when these are right.
6. Choose **Generate missing starting images**. Each of the three shots uses the same approved reference. Compare the images side by side for identity, wardrobe, background and screen direction. Choose **Approve starting image** for each shot.
7. If using Jev, run the current preflight and address its warnings. Jev evaluates the actual planned prompts and continuity notes; it still does **not** view images or footage. Human preflight approval is separate from image approval.
8. Choose **Animate approved images**. The exact selected starting image is sent to Runway with the scene's motion prompt. A short, restrained movement usually gives the model less to get wrong than several interacting actions.
9. Once clips finish, review the start/middle/end samples and play every full clip in the storyboard scene cards. Check identity drift, changed objects, anatomy, movement and the cuts between adjacent shots. Click **Approve clip** for every acceptable shot. Assembly, narration and music are blocked until all three are approved.
10. Choose **Run workflow** to generate the selected audio, assemble, technically evaluate and package the film. Review the complete MP4 with sound before release.

The Draft/Final setting does not choose a different Runway video model. Source video is 720p; resizing the export to 1080p does not add detail.

## Improve an existing production

On an existing Runway/OpenAI production with a completed storyboard, choose **Start image-first revision**. This keeps previous media in Assets and preserves the spending ledger. It clears current clip selections and invalidates old delivery packages, then starts visual planning for the existing story. No media request is purchased by switching alone.

Existing projects otherwise retain their original workflow. API clients default to `text_to_video` unless they explicitly select `productionApproach: "image_to_video"`.

## Fix only what is wrong

- **Wrong shared appearance:** open **Edit or replace image** under the shared reference. Edit its description and save an image revision. This resets all starting images and clips because they depend on that reference. Generate and approve the replacement.
- **Wrong composition in one shot:** edit that shot's starting-image description and save. Only that shot's starting image and clip are reset. Generate missing starting images and approve the replacement.
- **Good image, bad motion:** use **Edit scene** to simplify the motion prompt, or **Replace clip** to try the same instructions again. The approved starting image survives; the old clip approval does not. Run preflight again if required, then animate missing clips.
- **Bad clip you want to flag first:** use **Edit scene → Reject scene**. Regenerate it before continuing.

Saving a revision prepares work; generation buttons authorize paid requests. Previous files remain in Assets. Image descriptions and motion prompts are separate. Prompts are never cut mid-sentence to fit Runway's limit; overly long essential descriptions must be shortened before video submission.

## Costs, limits and recovery

Runway's published Gen-4 Image 1080p rate is **8 credits ($0.08) per image**. One shared reference plus three starting images costs **$0.32 initially**. Gen-4.5 video is **$0.12 per requested second**: three five-second clips cost **$1.80**, so initial Runway images plus video are approximately **$2.12**, excluding planning, Jev, audio, retries and tax. Rates checked September 19, 2026; verify [current Runway pricing](https://docs.dev.runwayml.com/guides/pricing/).

Every image and clip purchase counts toward the project's total attempt limit. Per-scene regeneration limits apply separately to starting images and video; the same limit also bounds shared-reference attempts. Prior spending and attempt counts are retained when upgrading an existing project.

Reservations are recorded before submission. Submitted image and video tasks are polled using their saved IDs. Retrying a download retrieves the paid task rather than purchasing another. Unknown submission outcomes retain reservations and block automatic repurchase; inspect Generations and the provider portal. An old job cannot replace a newer image revision. Pause stops automatic progression, not already queued or remotely submitted work. See [recovery details](MVP_QUICKSTART.md#recovery-and-cancellation).

## What the checks establish

Automated tests use mocked paid providers and real FFmpeg media. They verify reference payloads, approval gates, image lineage, revision invalidation, budget limits, paid-task replay, frame sampling and assembly. They do not establish artistic quality from live Runway generations. The three sampled frames help human review; they are not an automated visual critique or a check of every frame. This version uses a shared reference across shots; it does not chain the previous clip's final frame into the next clip.

API contracts: [Runway image and image-to-video examples](https://docs.dev.runwayml.com/guides/using-the-api/) and [media input requirements](https://docs.dev.runwayml.com/assets/inputs/).
