# RESEARCH_NOTES.md

## RN-001 — Current Gemini API model lineup (for brain.ts model pool)
- **Date:** 2026-10-09
- **Source:** https://ai.google.dev/gemini-api/docs/models (official, "Last updated 2026-10-06 UTC"). Web search was unavailable (cancelled); fetched the docs page directly.
- **Findings:**
  - Stable chat Flash models: `gemini-3.8-flash` (newest, "engineered for long-horizon software engineering, autonomous agents"), `gemini-3.7-flash` (prev-gen "complex coding, agentic workflows"), `gemini-3.6-flash` (prev-gen general), `gemini-3.5-flash` (legacy), `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`.
  - `gemini-flash-latest` alias exists (hot-swaps, 2-week breaking-change notice).
  - Flash-BRANDED but NON-chat models that the old `includes('flash')` filter wrongly admitted: `gemini-3.1-flash-image` (Nano Banana 2, image gen), `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image`, `gemini-omni-1.1-flash` (video gen), `gemini-3.8-flash-tts`, `gemini-*-flash-live-*`, `gemini-3.5-transcribe`.
  - 2.5-family models are now access-limited for new users (still served for existing users).
- **Decisions applied (OPT-012):**
  1. Priority order changed to 3.8 → 3.7 → 3.6 → flash-latest (3.5 only as trailing fallback), matching docs' own generation ordering and Miko's agent use-case.
  2. Pool filter now excludes: tts, audio, image, live, transcribe, omni, banana, embedding.
  3. Regression test added (tests.ts §14): a mocked model list containing image/omni/tts/live/banana flash models must never produce an attempted generateContent call to those models.
- **Not adopted:** Gemini 2.5 models (access-limited, legacy); `computer-use` preview models (shut down per docs); Interactions API (bigger migration, no current need).

## RN-002 — Electron backgroundThrottling and rAF when hidden (for OPT-007)
- **Reasoning from known Electron behavior (no external page needed):** `backgroundThrottling: false` is required in this app so timers/rAF keep running while the click-through overlay sits over other apps; a side effect is that `BrowserWindow.hide()` does NOT stop rAF. The standard `document.hidden` visibility signal still reflects window visibility, so a render-work guard keyed on it is safe: rAF keeps firing (cheap) and all update/render work is skipped; animation resumes automatically on show because the rAF chain was never broken.
- **Verification available tonight:** compile + build only; visual behavior is on the morning checklist (PA note in SESSION_LOG.md).
