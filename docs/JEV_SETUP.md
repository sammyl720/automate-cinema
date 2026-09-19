# Jev independent evaluation

Jev is an optional critic for concepts and planned shots. OpenAI or the development provider still writes the creative material. TypeScript combines Jev judgments and decides whether automation can continue. Jev does not generate video, inspect MP4s, measure audience retention, or verify facts on the web.

## Credentials and first use

1. Request direct API access at [TypeSafe](https://typesafe.ai/) if needed, then sign into the [TypeSafe console](https://console.typesafe.ai/) and create an API key. Direct access is currently early access; confirm your account has API and billing access.
2. In your active checkout, edit the existing server `.env` and add `TYPESAFE_API_KEY=your_key`. Do not overwrite other provider keys or put the key in a browser field. Keys must never be committed or prefixed with `VITE_`.
3. Set `TYPESAFE_MODEL=jev-latest` (the supported SDK alias). It resolves to `jev-1.13.0` as of September 18, 2026. Pin `jev-1.13.0` for reproducible model selection while calibrating. We store both the requested alias and the returned model version. An alias may change upstream; completed evaluations remain cached rather than being repurchased automatically.
4. Restart `npm run dev:studio` using the Node version in `.nvmrc`. Jev should appear as configured under Providers. Configured only means the server has a key; account access is checked on the first request.
5. Create a **new production**, choose **Decision evaluator → jev**, and choose creative, video and audio providers separately. Existing projects without this setting keep development behavior. Development evaluation is free and deterministic; Jev calls are paid even when the creative/video providers are development.
6. Start in assisted mode. **Run workflow** generates concepts, independently evaluates them, and selects only an eligible concept. Open Concepts to inspect normalized scores, confidence, and expandable distributions. If it pauses, choose a concept yourself after reviewing the judgments. Missing or failed Jev evaluations must finish successfully before selection; generator scores are never a fallback.
7. After scripting/storyboarding, Jev evaluates each shot before the usual assisted approval point. Review preflight details above the project tabs. If flagged, edit the scenes and run a new preflight, or enter review notes and choose **Approve storyboard after human review**. This records a deliberate override for that exact storyboard. It does not itself purchase video. Choose **Generate film** or **Run workflow** afterward.
8. In manual mode, run each stage yourself, including **Run Jev preflight**. In autonomous mode, eligible judgments allow progression; low scores, low confidence, or missing evaluations pause before video spending. Scene edits/regeneration invalidate preflight, including human approval. Regenerating a Jev scene first prepares the revision; run preflight, then generate it.

## Scores, probability, and confidence

Six concept criteria use five ordered levels: Weak, Below average, Average, Strong, Exceptional. Jev returns an expected 0–4 score. The app maps it to 0–100 with `round(score / 4 * 100)`, then applies the existing deterministic weights: hook 2, emotion 1.5, novelty 1.3, clarity 1.5, feasibility 1.4, retention 1.8. Original generator scores remain available for debugging but do not authorize Jev-backed automatic selection.

A level probability is the mass assigned to that rubric level. Confidence describes concentration of the distribution, not the probability that the concept will succeed. The UI's nearest level summarizes the expected score; expand the distribution to see ambiguity. Noul answers are probabilities of yes and have no separate SDK confidence value.

Automatic concept selection requires the top concept to score at least **80**, every criterion's confidence to meet `JEV_MIN_CONFIDENCE` (default **0.70**), and hook/retention each to have P(Strong or Exceptional) at least `JEV_MIN_STRONG_PROBABILITY` (default **0.75**). If the top concept fails a gate, automation asks for human selection; it does not silently choose a different concept. There is no paid Choice tie-breaker in this implementation.

Preflight scores visual specificity, filmability, prompt clarity, narration alignment, first frame, and retention contribution. Each must meet `JEV_PREFLIGHT_MIN_SCORE` (**70**) and the confidence floor. Noul continuity must be at least `JEV_CONTINUITY_MIN_PROBABILITY` (**0.70**); ambiguity must not exceed `JEV_AMBIGUITY_MAX_PROBABILITY` (**0.30**). Factual projects also ask about unsupported claims and exaggeration against supplied, human-verified facts; each uses the same maximum risk threshold. This adds semantic consistency review and does not replace deterministic verified-source checks.

These thresholds are initial editorial policy, **not calibrated performance guarantees**. Tune with real reviewed projects. Restart after `.env` changes; policy is recomputed from saved judgments, so adjusting thresholds does not repurchase evaluation. Saved human approvals remain explicit exceptions for the exact input/rubric/model request.

## Cost, traces, and recovery

The official SDK is pinned to `@typesafe-ai/sdk@0.6.0`. Calls use the official API endpoint and receive the job cancellation signal. `TYPESAFE_TIMEOUT_MS` defaults to 30000. SDK retries and SDK logging are disabled; the studio owns bounded retry and recovery policy.

`TYPESAFE_INPUT_USD_PER_MILLION` defaults to **0.042**, from [official model pricing](https://docs.typesafe.ai/models) checked September 18, 2026. Output tokens are free. Before each request the studio reserves a conservative 64,000-input-token allowance (**$0.002688** at the default rate), then settles against reported input usage. The dashboard rounds dollars to cents, so tiny charges may display $0.00 while still counting against the budget. Set the rate to match your account if it differs.

API-call records hold input state, questions, raw answers, usage, latency, request ID, status, and cost. Decision records hold normalized criteria, distributions, rubric version, resolved model, revision, gate reasons, policy thresholds, and human approvals, linked to the call. Review provider calls in Generations; project detail exposes the complete trace.

Completed calls replay for identical input, project revision, requested model and rubric version. Changing the creative state, model selection or rubric makes a new evaluation. If a request times out, disconnects, or returns a server error, the reservation remains and automatic repurchase is blocked. Inspect the recorded request ID and reconcile with TypeSafe before deciding how to recover. There is no automatic billing-reconciliation UI. A 429 can retry within the existing job and paid-request attempt limits; 401/403 requires correcting credentials/permissions. Invalid answers pause without falling back to generator scores.

No standard tests contact TypeSafe. Integration tests mock the SDK transport, use temporary databases, and keep the real development rendering tests. Live Jev quality and account access require a separate, intentional trial with your credentials.

References: [official SDK](https://github.com/typesafe-ai/typesafe-sdk-js), [models and pricing](https://docs.typesafe.ai/models), [Score](https://docs.typesafe.ai/primitives/score), [confidence](https://docs.typesafe.ai/confidence).
