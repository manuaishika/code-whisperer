# Changelog

## 0.1.0

- **Voice that works.** VS Code webviews can't use the microphone, so "Talk (in browser)" now opens a small local page (Chrome, Edge or Safari) where speech recognition works. Typing and click-to-run command cards work everywhere. Replies are read aloud with your system voice (macOS `say`, Windows SAPI, Linux `spd-say`/`espeak-ng`).
- **Bring your own model.** OpenAI, Anthropic, Ollama (fully local) or any OpenAI-compatible server. API keys are stored in VS Code's encrypted secret storage; the old plain-text `openaiApiKey` setting is migrated automatically.
- **Step-by-step walkthrough.** "Walk Through Selected Code" turns your selection into a guided tour: a spoken overview, then steps you move through with "next", "back", "repeat", "simpler", "deeper" or by asking a question. The editor highlights each step's lines. Every step is labelled *read in code* or *inferred*, and inferred steps say so out loud, so you know what to double-check.
- **Better routing.** Spoken commands are scored instead of first-match, so "what are the security risks" is a security review, not a generic explanation.
- **Safer rendering.** Selected code and model replies are never inserted as HTML; the panel has a strict Content-Security-Policy; the local voice server is loopback-only, token-protected and checks Host/Origin.
- Dependency-free at runtime (the `openai` package is gone), with a test suite and CI.

## 0.0.1

- First prototype.
