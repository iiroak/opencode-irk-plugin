/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import {
  formatCount,
  formatPercent,
  formatTps,
  LIVE_REFRESH_MS,
  MetricsStore,
  type TokenMetrics,
} from "./metrics.js"
import { CodexClient, CodexUsageError, type CodexUsage } from "./codex.js"

const pluginID = "opencode-irk-plugin"
const PROGRESS_BAR_WIDTH = 24
const FILLED_GLYPH = "█"
const EMPTY_GLYPH = "░"
const PRIMARY_GREEN = "#3fb950"
const ACCENT_GREEN = "#56d364"
const DIM_GREEN = "#1f6f2b"

function useLiveMetrics(
  api: TuiPluginApi,
  store: MetricsStore,
  sessionID: string,
): () => TokenMetrics | undefined {
  const [version, setVersion] = createSignal(0)
  const [clock, setClock] = createSignal(Date.now())
  const unsubscribe = store.subscribe((id) => {
    if (id === sessionID) setVersion((value) => value + 1)
  })
  const timer = setInterval(() => {
    const at = Date.now()
    const busy = api.state.session.status(sessionID)?.type === "busy"
    store.setSessionBusy(sessionID, busy, at)
    if (busy || store.read(sessionID)?.live) setClock(at)
  }, LIVE_REFRESH_MS)
  onCleanup(() => {
    unsubscribe()
    clearInterval(timer)
  })
  return createMemo(() => {
    version()
    clock()
    return store.read(sessionID)
  })
}

function Metrics(props: {
  api: TuiPluginApi
  sessionID: string
  store: MetricsStore
}): JSX.Element {
  const metrics = useLiveMetrics(props.api, props.store, props.sessionID)
  const runtimeText = createMemo(() => {
    const current = metrics()
    if (!current) return undefined
    const tps = current.tps === undefined ? "-" : `${current.tpsEstimated ? "~" : ""}${formatTps(current.tps)}`
    return `⚡${tps} tps ◷ ${formatElapsed(current.elapsedMs)}`
  })
  return (
    <Show when={runtimeText()}>
      {(runtime) => {
        const muted = props.api.theme.current.textMuted
        return (
          <box flexDirection="row" alignItems="center">
            <text fg={muted}>{runtime()}</text>
          </box>
        )
      }}
    </Show>
  )
}

function formatElapsed(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "-"
  if (value < 1_000) return `${Math.round(value)}ms`
  const seconds = Math.floor(value / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`
}

function formatMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "-"
  return `${Math.round(value)}ms`
}

function SidebarMetrics(props: { api: TuiPluginApi; sessionID: string; store: MetricsStore }): JSX.Element | null {
  const metrics = useLiveMetrics(props.api, props.store, props.sessionID)
  const sidebarText = createMemo(() => {
    const current = metrics()
    if (!current) return undefined
    const marker = (estimated: boolean) => (estimated ? "~" : "")
    return {
      tokens: `Tokens ↑${marker(current.inputEstimated)}${formatCount(current.input)} ↓${marker(current.outputEstimated)}${formatCount(current.output)}`,
      cache: `Cache ${formatCount(current.cacheRead)} (${formatPercent(current.cacheHit)})`,
      latency: `Latency ${formatMs(current.latencyMs)}`,
    }
  })
  return (
    <Show when={sidebarText()}>
      {(sidebar) => {
        const muted = props.api.theme.current.textMuted
        const text = props.api.theme.current.text
        return (
          <box flexDirection="column" gap={0}>
            <text fg={text}>
              <b>Session Metrics</b>
            </text>
            <text fg={muted}>{sidebar().tokens}</text>
            <text fg={muted}>{sidebar().cache}</text>
            <text fg={muted}>{sidebar().latency}</text>
          </box>
        )
      }}
    </Show>
  )
}

function splitBar(used: number, width: number = PROGRESS_BAR_WIDTH): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(100, Math.round(used)))
  const remaining = 100 - clamped
  const filled = Math.min(
    width,
    Math.max(remaining > 0 ? 1 : 0, Math.round((remaining / 100) * width)),
  )
  return { filled: FILLED_GLYPH.repeat(filled), empty: EMPTY_GLYPH.repeat(width - filled) }
}

function remainingPercent(used: number): number {
  return Math.max(0, Math.min(100, 100 - Math.round(used)))
}

function windowLabel(minutes: number | null): string {
  if (minutes === null) return "rolling"
  if (minutes < 60) return `${minutes}m`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}`
}

function formatReset(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "—"
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.round((seconds % 3600) / 60)
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`
  }
  const days = Math.floor(seconds / 86_400)
  const hours = Math.round((seconds % 86_400) / 3600)
  return hours ? `${days}d ${hours}h` : `${days}d`
}

function Bar(props: { filled: string; empty: string; accent: string; muted: string }): JSX.Element {
  return (
    <text>
      <span style={{ fg: props.accent, bold: true }}>{props.filled}</span>
      <span style={{ fg: props.muted }}>{props.empty}</span>
    </text>
  )
}

type WindowRowProps = {
  api: TuiPluginApi
  label: string
  resetsIn: string
  used: number
}

function WindowRow(props: WindowRowProps): JSX.Element {
  const muted = props.api.theme.current.textMuted
  const accent = PRIMARY_GREEN
  const { filled, empty } = splitBar(props.used)
  const left = remainingPercent(props.used)
  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={muted}>{props.label.padEnd(7, " ")}</text>
        <text fg={muted}>[</text>
        <Bar filled={filled} empty={empty} accent={accent} muted={DIM_GREEN} />
        <text fg={muted}>]</text>
        <text>
          <span style={{ fg: accent, bold: true }}>{left}%</span>
          <span style={{ fg: props.api.theme.current.text }}> left</span>
        </text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={muted}>{" ".repeat(8)}resets in </text>
        <text>
          <span style={{ fg: accent }}>{props.resetsIn}</span>
        </text>
      </box>
    </box>
  )
}

function creditsLabel(usage: CodexUsage): string {
  if (!usage.credits) return ""
  if (usage.credits.unlimited) return "unlimited"
  if (usage.credits.hasCredits) {
    return usage.credits.balance ? `available (${usage.credits.balance})` : "available"
  }
  return "none"
}

function resetsCount(usage: CodexUsage): number | null {
  const reset = usage.resetCredits
  if (!reset) return null
  return reset.availableCount
}

function UsageSummary(props: { api: TuiPluginApi; usage: CodexUsage }): JSX.Element {
  const muted = props.api.theme.current.textMuted
  const text = props.api.theme.current.text
  const header = props.usage.planType
    ? `OpenAI Codex Usage · ${props.usage.planType}`
    : "OpenAI Codex Usage"
  const limits = props.usage.limitId ?? "codex"
  const now = Math.floor(Date.now() / 1000)
  const credits = creditsLabel(props.usage)
  const resets = resetsCount(props.usage)
  return (
    <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      <text>
        <b>{header}</b>
      </text>
      <text fg={muted}>
        Account: <span style={{ fg: text }}>{limits}</span>
      </text>
      {props.usage.primary ? (
        <WindowRow
          api={props.api}
          label={windowLabel(props.usage.primary.windowMinutes)}
          resetsIn={formatReset(
            props.usage.primary.resetsAt ? props.usage.primary.resetsAt - now : null,
          )}
          used={props.usage.primary.usedPercent}
        />
      ) : null}
      {props.usage.secondary ? (
        <WindowRow
          api={props.api}
          label={windowLabel(props.usage.secondary.windowMinutes)}
          resetsIn={formatReset(
            props.usage.secondary.resetsAt ? props.usage.secondary.resetsAt - now : null,
          )}
          used={props.usage.secondary.usedPercent}
        />
      ) : null}
      {credits ? (
        <text fg={muted}>
          Credits: <span style={{ fg: ACCENT_GREEN }}>{credits}</span>
        </text>
      ) : null}
      {resets !== null ? (
        <text fg={muted}>
          Resets available:{" "}
          <span style={{ fg: resets > 0 ? ACCENT_GREEN : muted, bold: resets > 0 }}>
            {resets}
          </span>
        </text>
      ) : null}
      {props.usage.promoMessage ? <text fg={muted}>Notice: {props.usage.promoMessage}</text> : null}
      {props.usage.rateLimitReachedType ? (
        <text fg={props.api.theme.current.warning}>Status: {props.usage.rateLimitReachedType}</text>
      ) : null}
      <text fg={muted}>
        Refreshed{" "}
        <span style={{ fg: text }}>{new Date(props.usage.capturedAt).toLocaleTimeString()}</span>
      </text>
    </box>
  )
}

function openUsageDialog(api: TuiPluginApi, message: string, tone: "info" | "warning" | "error" = "info") {
  const color = tone === "error"
    ? api.theme.current.error
    : tone === "warning"
      ? api.theme.current.warning
      : api.theme.current.text
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <box flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
      <text>
        <b>
          <span style={{ fg: PRIMARY_GREEN }}>●</span> OpenAI Codex Usage
        </b>
      </text>
      <text fg={color}>{message}</text>
      <text fg={api.theme.current.textMuted}>esc closes</text>
    </box>
  ))
}

function showCodexUsage(api: TuiPluginApi) {
  openUsageDialog(api, "Loading Codex usage from OpenCode…")

  const client = new CodexClient()
  void client
    .readUsage()
    .then((usage) => {
      api.ui.dialog.setSize("large")
      api.ui.dialog.replace(() => <UsageSummary api={api} usage={usage} />)
    })
    .catch((error) => {
      const message =
        error instanceof CodexUsageError ? error.message : `Unexpected error: ${String(error)}`
      openUsageDialog(api, message, error instanceof CodexUsageError ? "warning" : "error")
    })
}

const tui: TuiPlugin = async (api) => {
  const store = new MetricsStore()

  const unsubscribe = [
    api.event.on("session.next.prompted", (event) => store.handle(event)),
    api.event.on("session.next.prompt.admitted", (event) => store.handle(event)),
    api.event.on("session.next.step.started", (event) => store.handle(event)),
    api.event.on("session.next.text.delta", (event) => store.handle(event)),
    api.event.on("session.next.reasoning.delta", (event) => store.handle(event)),
    api.event.on("session.next.tool.input.delta", (event) => store.handle(event)),
    api.event.on("session.next.step.ended", (event) => store.handle(event)),
    api.event.on("session.next.step.failed", (event) => store.handle(event)),
    api.event.on("session.deleted", (event) => store.handle(event)),
  ]
  api.lifecycle.onDispose(() => unsubscribe.forEach((remove) => remove()))

  api.keymap.registerLayer({
    commands: [
      {
        name: "codex.usage",
        title: "Codex Usage",
        category: "Codex",
        namespace: "palette",
        slashName: "codex-usage",
        run() {
          showCodexUsage(api)
        },
      },
    ],
  })

  api.slots.register({
    order: 50,
    slots: {
      session_prompt_right(_context, props) {
        const messages = api.state.session.messages(props.session_id)
        store.hydrate(
          props.session_id,
          messages.filter((message) => message.role === "assistant"),
          () => messages.flatMap((message) => api.state.part(message.id)),
        )
        return <Metrics api={api} sessionID={props.session_id} store={store} />
      },
      sidebar_content(_context, props) {
        const messages = api.state.session.messages(props.session_id)
        store.hydrate(
          props.session_id,
          messages.filter((message) => message.role === "assistant"),
          () => messages.flatMap((message) => api.state.part(message.id)),
        )
        return <SidebarMetrics api={api} sessionID={props.session_id} store={store} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: pluginID,
  tui,
}

export default plugin
