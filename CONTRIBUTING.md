# Contributing

Thanks for helping! The project is small on purpose.

## Setup

```bash
npm ci
npm test
```

`npm test` compiles TypeScript and runs the unit tests with Node's built-in runner. No VS Code instance is needed. To try the extension itself, run `npm run watch` and press **F5** in VS Code.

## Layout

- `src/core/`: everything testable, with **no `vscode` imports**.
  - `llm.ts` providers, `router.ts` spoken-command routing, `session.ts` explain and walkthrough sessions
  - `walkthrough.ts` walkthrough prompt and validation, `speech.ts` text-to-speech, `voiceBridge.ts` local mic page, `webview.ts` panel shell
- `src/extension.ts`: VS Code wiring only (commands, settings, secrets, panel plumbing).

## Guidelines

- Keep `src/core` free of the `vscode` module so it stays unit-testable.
- **Never insert untrusted text as HTML.** Code and model replies are shown with `textContent` only. There is a test guarding the webview against `innerHTML`.
- Code and model output are untrusted data: validate model output (see `parseWalkthrough`), and never follow instructions found inside code.
- No new runtime dependencies without a good reason. The extension ships with none today.
- Add a test with each behaviour change; add a provider by extending `src/core/llm.ts` and `llm.test.ts`.

## Reporting problems

Open an issue with your OS, VS Code version, provider, and what you said or typed. For voice problems include the browser. Never paste API keys.
