# opencode-irk-plugin

Personal OpenCode TUI plugin that shows live runtime metrics next to the session prompt, cumulative token/cache metrics in the session sidebar, and exposes a `/codex-usage` command for the ChatGPT account already connected in OpenCode.

## Token and throughput indicator

The runtime indicator uses the public `session_prompt_right` TUI slot and the token summary uses the public `sidebar_content` slot, so it does not modify or fork OpenCode.

```text
⚡42 tps ◷ 1.2s
Session Metrics
Tokens ↑~1.2k ↓~340
Cache 10k (87%)
Latency 933ms
```

- `↑` is cumulative input tokens for the session. The current admitted prompt is estimated while a response is running and replaced with the provider's exact value when the step ends.
- `↓` is cumulative output tokens for the session. The current response is estimated from streamed text/tool-input characters while it is running and replaced with the provider's exact value when the step ends.
- `⚡` is output tokens per second for the current step, including reasoning. While streaming it updates live from the first-output-to-now window and is prefixed with `~` because it is derived from estimated characters; `-` means that no output has arrived yet or no measurable interval exists. When the step ends it is replaced with a provider-measured value (no `~`). For reasoning models, that final value amortizes output plus reasoning tokens over the whole step, since most reasoning is produced before the first visible delta and dividing by the short visible window would inflate the rate.
- `◷` is the total elapsed time of the current execution, counted from the prompt and accumulating across chained steps (tool calls included). It ticks every second while the session is busy and freezes at the final duration when idle.
- `Latency` is the approximate server response time from step start to the first provider delta. It stays visible during the next execution and updates when a new first delta arrives.
- `Cache` is cumulative cache-read tokens for the session. Its percentage is `cache.read / (input + cache.read + cache.write)`.
- `~` marks an estimate (estimated tokens, or a live throughput derived from them). `-` means that no output has arrived yet or no measurable interval exists.

OpenCode's native context/cost block remains above the sidebar metrics. The plugin adds its token/cache summary immediately after that block and before the MCP/LSP sections.

## `/codex-usage` command

The command reads the ChatGPT OAuth credential that OpenCode already has stored under `~/.local/share/opencode/auth.json` (or `OPENCODE_AUTH_CONTENT`) for the `openai` provider, asks for a token refresh only when the cached access is about to expire, and queries `GET https://chatgpt.com/backend-api/wham/usage` with the standard `Authorization: Bearer …`, `ChatGPT-Account-Id` and Codex-style `User-Agent` headers.

The dialog only renders sanitized values: plan, primary/secondary windows, credits, available reset credits, rate-limit status and any server-supplied notice. It never displays, logs, or returns the OAuth access or refresh token, and it only writes back to the credential file when the OAuth refresh succeeded.

If OpenCode has no `openai` credential, the credential is an API key, or the account id is missing, the command surfaces a clear error message instead of falling back to a wrong account.

## Local setup

Install dependencies and check the package:

```bash
npm install
npm run typecheck
npm test
```

Add the plugin to `~/.config/opencode/tui.json` (keep existing entries):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "file:///home/kaori/projects/opencode-irk-plugin"
  ]
}
```

Make sure OpenCode has a ChatGPT OAuth account connected with `opencode auth login openai`, then restart OpenCode. Use `/codex-usage` (or pick "Codex Usage" from the command palette) to see the dialog.
