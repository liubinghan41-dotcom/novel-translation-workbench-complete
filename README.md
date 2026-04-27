# Novel Translation Workbench

Local-first novel translation workbench for TXT and EPUB files. It is designed for long-form fiction workflows where a translation job may take hours, fail midway, need terminology control, and require later review.

## Features

- TXT / EPUB parsing with chapter detection
- Chapter range translation
- Resumable background translation jobs
- Pause, resume, and retry failed segments
- Translation cache keyed by source text, model, prompt, glossary, context, and settings
- Project save / load / import / export
- Prompt presets, including JSON preset import
- Structured glossary parsing and per-segment glossary injection
- Local context bank retrieval for token-saving prompt injection
- Automatic QA checks for empty output, likely omissions, paragraph drift, repeated output, and glossary misses
- Lightweight chapter summaries
- Glossary-driven consistency checks
- TXT and simple EPUB export
- Zero npm runtime dependencies

## Quick Start

```bash
npm start
```

Then open:

```text
http://localhost:4173
```

Run syntax checks:

```bash
npm run check
```

## Data Storage

Runtime data is stored locally under `data/`:

- `data/projects/` stores saved projects
- `data/jobs/` stores resumable job state
- `data/cache/` stores translation cache entries

API keys are not written to server-side project or job files. If you choose to remember an API key, it is stored in the browser's local storage.

## Providers

The workbench supports:

- OpenAI
- OpenAI-compatible APIs such as local gateways, Ollama-compatible proxies, OneAPI, and LiteLLM
- DeepSeek
- Gemini
- Claude
- Demo offline mode for testing workflows

## License

This project is source-available for non-commercial use under the PolyForm Noncommercial License 1.0.0.

Commercial use is not permitted without separate written permission from the copyright holder.

Note: licenses that prohibit commercial use are not considered "Open Source" under the OSI Open Source Definition. This project uses a non-commercial source-available license intentionally.
