# Changelog

## 0.1.0

- **Voice that works.** VS Code webviews can't use the microphone, so "Talk (in browser)" now opens a small local page (Chrome, Edge or Safari) where speech recognition works. Typing and click-to-run command cards work everywhere. Replies are read aloud with your system voice (macOS `say`, Windows SAPI, Linux `spd-say`/`espeak-ng`).
- **Bring your own model.** OpenAI, Anthropic, Ollama (fully local) or any OpenAI-compatible server. API keys are stored in VS Code's encrypted secret storage; the old plain-text `openaiApiKey` setting is migrated automatically.
- **crumbs integration.** "Walk Through a crumbs Issue Trail" narrates a [crumbs](https://github.com/navyabijoy/crumbs) `trail.json` step by step ("next", "back", "simpler", "deeper", or ask a question), jumps the editor to each step's code, reads the project's AI-contribution policy first and speaks each step's proof label. Selections that sit on a crumbs trail are explained with the issue as context.
- **Better routing.** Spoken commands are scored instead of first-match, so "what are the security risks" is a security review, not a generic explanation.
- **Safer rendering.** Selected code and model replies are never inserted as HTML; the panel has a strict Content-Security-Policy; the local voice server is loopback-only, token-protected and checks Host/Origin.
- Dependency-free at runtime (the `openai` package is gone), with a test suite and CI.

## 0.0.1

- First prototype.
