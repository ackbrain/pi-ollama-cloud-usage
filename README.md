# pi-ollama-cloud-usage

A [Pi](https://pi.dev/) extension that shows your [Ollama Cloud](https://ollama.com) quota usage in the footer status line.

```text
Ollama 5h:98% Wk:98.3%
```

Uses the authenticated `GET https://ollama.com/api/usage` surface with your Ollama Cloud API key — the same data as the [ollama.com/settings](https://ollama.com/settings) dashboard: the rolling 5-hour session window and the 7-day weekly window.

## Installing

```bash
pi install npm:pi-ollama-cloud-usage
```

Or from git:

```bash
pi install git:github.com/puetsua/pi-ollama-cloud-usage
```

## Setup

The extension reuses the Ollama Cloud API key already configured for the `ollama-cloud` provider:

- `~/.pi/agent/auth.json` → `{ "ollama-cloud": { "type": "api_key", "key": "..." } }` (as written by [pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud))
- `OLLAMA_API_KEY` environment variable
- or pi's model registry resolution (`/login ollama-cloud`)

Create a key at [ollama.com/settings/keys](https://ollama.com/settings/keys).

## Dependencies

Requires the [pi-ollama-cloud](https://pi.dev/packages/pi-ollama-cloud) package to be installed (it registers the `ollama-cloud` provider and stores the API key this extension reads):

```bash
pi install npm:pi-ollama-cloud
```

## Commands

Status is **on by default** for active `ollama-cloud` models.

- `/ollama-usage` — one-shot full usage report (session + weekly + per-model breakdown + activity cost)
- `/ollama-usage status` — show on/off
- `/ollama-usage status on|off` — enable or disable the footer status

Refreshes after turns (at most once per minute). Clears when you leave an Ollama Cloud model.

## License

MIT
