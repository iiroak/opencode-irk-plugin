import type { AssistantMessage, Event, Part } from "@opencode-ai/sdk/v2"

export const ESTIMATED_CHARS_PER_TOKEN = 4
export const LIVE_REFRESH_MS = 250
export const MIN_TPS_INTERVAL_MS = 100
export const MAX_DISPLAY_TPS = 100_000

export type TokenMetrics = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  inputEstimated: boolean
  outputEstimated: boolean
  tps?: number
  tpsEstimated: boolean
  elapsedMs?: number
  latencyMs?: number
  cacheHit?: number
  live: boolean
}

type ActiveStep = {
  assistantMessageID: string
  outputCharacters: number
  generatedCharacters: number
  inputEstimate?: number
  stepStartedAt: number
  firstOutputAt?: number
  lastOutputAt?: number
}

type SessionMetrics = {
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheWrite: number
  totalsInitialized: boolean
  statusBusy: boolean
  executionStartedAt?: number
  active?: ActiveStep
  last?: TokenMetrics
  lastSource?: "event" | "hydrate"
  lastHydratedSignature?: string
  pendingInputEstimate?: number
}

type Listener = (sessionID: string) => void

function positive(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function estimateTokens(characters: number): number {
  return Math.max(0, Math.ceil(characters / ESTIMATED_CHARS_PER_TOKEN))
}

function generationTps(output: number, startedAt: number | undefined, endedAt: number | undefined): number | undefined {
  if (output <= 0 || startedAt === undefined || endedAt === undefined) return undefined
  const elapsed = Math.max(0, endedAt - startedAt)
  if (elapsed < MIN_TPS_INTERVAL_MS) return undefined
  return output / (elapsed / 1000)
}

function elapsedMs(startedAt: number | undefined, endedAt: number | undefined): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined
  return Math.max(0, endedAt - startedAt)
}

function responseTps(
  output: number,
  reasoning: number,
  stepStartedAt: number | undefined,
  firstOutputAt: number | undefined,
  lastOutputAt: number | undefined,
  endedAt: number | undefined,
): number | undefined {
  if (reasoning > 0) {
    // Reasoning tokens accrue across the whole step, and much of that work
    // happens before the first visible delta. Dividing output+reasoning by the
    // short first-output-to-last-output window would inflate the rate, so we
    // amortize the total model tokens over the full step window instead.
    return generationTps(output + reasoning, stepStartedAt, endedAt)
  }
  return (
    generationTps(output, firstOutputAt, lastOutputAt) ??
    generationTps(output, stepStartedAt, endedAt)
  )
}

function timestamp(eventTimestamp?: number): number {
  return typeof eventTimestamp === "number" && Number.isFinite(eventTimestamp) ? eventTimestamp : Date.now()
}

function contextTokenTotal(message: AssistantMessage): number {
  return (
    positive(message.tokens.input) +
    positive(message.tokens.output) +
    positive(message.tokens.reasoning) +
    positive(message.tokens.cache.read) +
    positive(message.tokens.cache.write)
  )
}

function cacheHitPercent(session: SessionMetrics): number | undefined {
  const totalInput = session.totalInput + session.totalCacheRead + session.totalCacheWrite
  return totalInput > 0 ? Math.round((session.totalCacheRead / totalInput) * 100) : undefined
}

function aggregate(
  session: SessionMetrics,
  tps: number | undefined,
  duration: number | undefined,
  latency: number | undefined,
): TokenMetrics {
  const hit = cacheHitPercent(session)
  return {
    input: session.totalInput,
    output: session.totalOutput,
    cacheRead: session.totalCacheRead,
    cacheWrite: session.totalCacheWrite,
    inputEstimated: false,
    outputEstimated: false,
    tps,
    tpsEstimated: false,
    elapsedMs: duration,
    ...(latency === undefined ? {} : { latencyMs: latency }),
    ...(hit === undefined ? {} : { cacheHit: hit }),
    live: false,
  }
}

export class MetricsStore {
  private readonly sessions = new Map<string, SessionMetrics>()
  private readonly listeners = new Set<Listener>()
  private now = Date.now

  /** Set a deterministic clock in unit tests without changing production behavior. */
  setClock(now: () => number): void {
    this.now = now
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Report whether the session is running so the clock keeps ticking even without step events. */
  setSessionBusy(sessionID: string, busy: boolean, at: number): void {
    const session = this.session(sessionID)
    session.statusBusy = busy
    if (busy) {
      if (!session.active && session.executionStartedAt === undefined) {
        session.executionStartedAt = at
        this.notify(sessionID)
      }
    } else if (session.executionStartedAt !== undefined && !session.active) {
      session.executionStartedAt = undefined
      this.notify(sessionID)
    }
  }

  private notify(sessionID: string): void {
    for (const listener of this.listeners) listener(sessionID)
  }

  private session(sessionID: string): SessionMetrics {
    let value = this.sessions.get(sessionID)
    if (!value) {
      value = {
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        totalsInitialized: false,
        statusBusy: false,
      }
      this.sessions.set(sessionID, value)
    }
    return value
  }

  handle(event: Event): void {
    switch (event.type) {
      case "session.next.prompted":
      case "session.next.prompt.admitted": {
        const session = this.session(event.properties.sessionID)
        const estimate = estimateTokens(event.properties.prompt.text.length)
        session.pendingInputEstimate = estimate
        if (session.active) {
          session.active.inputEstimate = estimate
        } else {
          session.executionStartedAt = timestamp(event.properties.timestamp)
        }
        this.notify(event.properties.sessionID)
        break
      }
      case "session.next.step.started": {
        const session = this.session(event.properties.sessionID)
        const inputEstimate = session.pendingInputEstimate
        const stepStartedAt = timestamp(event.properties.timestamp)
        session.pendingInputEstimate = undefined
        session.executionStartedAt ??= stepStartedAt
        session.active = {
          assistantMessageID: event.properties.assistantMessageID,
          outputCharacters: 0,
          generatedCharacters: 0,
          inputEstimate,
          stepStartedAt,
        }
        this.notify(event.properties.sessionID)
        break
      }
      case "session.next.text.delta": {
        const session = this.session(event.properties.sessionID)
        const active = session.active
        if (!active || active.assistantMessageID !== event.properties.assistantMessageID) return
        const at = timestamp(event.properties.timestamp)
        active.firstOutputAt ??= at
        active.lastOutputAt = at
        active.outputCharacters += event.properties.delta.length
        active.generatedCharacters += event.properties.delta.length
        this.notify(event.properties.sessionID)
        break
      }
      case "session.next.reasoning.delta": {
        const session = this.session(event.properties.sessionID)
        const active = session.active
        if (!active || active.assistantMessageID !== event.properties.assistantMessageID) return
        const at = timestamp(event.properties.timestamp)
        active.firstOutputAt ??= at
        active.lastOutputAt = at
        active.generatedCharacters += event.properties.delta.length
        this.notify(event.properties.sessionID)
        break
      }
      case "session.next.tool.input.delta": {
        const session = this.session(event.properties.sessionID)
        const active = session.active
        if (!active || active.assistantMessageID !== event.properties.assistantMessageID) return
        const at = timestamp(event.properties.timestamp)
        active.firstOutputAt ??= at
        active.lastOutputAt = at
        active.outputCharacters += event.properties.delta.length
        active.generatedCharacters += event.properties.delta.length
        this.notify(event.properties.sessionID)
        break
      }
      case "session.next.step.ended": {
        const session = this.session(event.properties.sessionID)
        const active = session.active
        const endedAt = timestamp(event.properties.timestamp)
        const input = positive(event.properties.tokens.input)
        const output = positive(event.properties.tokens.output)
        const reasoning = positive(event.properties.tokens.reasoning)
        const cacheRead = positive(event.properties.tokens.cache.read)
        const cacheWrite = positive(event.properties.tokens.cache.write)
        session.totalInput += input
        session.totalOutput += output
        session.totalCacheRead += cacheRead
        session.totalCacheWrite += cacheWrite
        session.totalsInitialized = true
        session.last = aggregate(
          session,
          responseTps(
            output,
            reasoning,
            active?.stepStartedAt,
            active?.firstOutputAt,
            active?.lastOutputAt,
            endedAt,
          ),
          elapsedMs(session.executionStartedAt ?? active?.stepStartedAt, endedAt),
          active?.firstOutputAt === undefined
            ? session.last?.latencyMs
            : elapsedMs(active?.stepStartedAt, active.firstOutputAt),
        )
        session.lastSource = "event"
        session.active = undefined
        this.notify(event.properties.sessionID)
        break
      }
      case "session.next.step.failed": {
        const session = this.session(event.properties.sessionID)
        session.active = undefined
        this.notify(event.properties.sessionID)
        break
      }
      case "session.deleted":
        this.sessions.delete(event.properties.sessionID)
        this.notify(event.properties.sessionID)
        break
    }
  }

  hydrate(
    sessionID: string,
    messages: readonly AssistantMessage[],
    parts: readonly Part[] | (() => readonly Part[]),
  ): void {
    const session = this.session(sessionID)
    if (messages.length === 0) return
    const signature = `${messages.length}:${messages[messages.length - 1].id}`
    if (session.lastHydratedSignature === signature) return

    const hydratedInput = messages.reduce((total, message) => total + positive(message.tokens.input), 0)
    const hydratedOutput = messages.reduce((total, message) => total + positive(message.tokens.output), 0)
    const hydratedCacheRead = messages.reduce((total, message) => total + positive(message.tokens.cache.read), 0)
    const hydratedCacheWrite = messages.reduce((total, message) => total + positive(message.tokens.cache.write), 0)
    let changed = false

    if (!session.totalsInitialized) {
      session.totalInput = hydratedInput
      session.totalOutput = hydratedOutput
      session.totalCacheRead = hydratedCacheRead
      session.totalCacheWrite = hydratedCacheWrite
      session.totalsInitialized = true
      changed = hydratedInput > 0 || hydratedOutput > 0 || hydratedCacheRead > 0 || hydratedCacheWrite > 0
    } else {
      const input = Math.max(session.totalInput, hydratedInput)
      const output = Math.max(session.totalOutput, hydratedOutput)
      const cacheRead = Math.max(session.totalCacheRead, hydratedCacheRead)
      const cacheWrite = Math.max(session.totalCacheWrite, hydratedCacheWrite)
      changed =
        input !== session.totalInput ||
        output !== session.totalOutput ||
        cacheRead !== session.totalCacheRead ||
        cacheWrite !== session.totalCacheWrite
      session.totalInput = input
      session.totalOutput = output
      session.totalCacheRead = cacheRead
      session.totalCacheWrite = cacheWrite
    }
    session.lastHydratedSignature = signature

    if (session.active) {
      if (changed) this.notify(sessionID)
      return
    }

    // Preserve event timing. Message timestamps can include time before the provider started.
    if (session.lastSource === "event") {
      if (changed && session.last) {
        session.last = aggregate(session, session.last.tps, session.last.elapsedMs, session.last.latencyMs)
        this.notify(sessionID)
      }
      return
    }

    const last = [...messages].reverse().find((message) => contextTokenTotal(message) > 0)
    if (!last) {
      if (changed) this.notify(sessionID)
      return
    }

    const partsList = typeof parts === "function" ? parts() : parts
    const outputParts = partsList.filter((part) => part.messageID === last.id)
    const times = outputParts.flatMap((part) => {
      if ((part.type !== "text" && part.type !== "reasoning") || !part.time) return []
      return [{ start: part.time.start, end: part.time.end }]
    })
    const end =
      last.time.completed ??
      (times.length ? Math.max(...times.map((value) => value.end ?? value.start)) : last.time.created)
    const firstOutputAt = times.length ? Math.min(...times.map((value) => value.start)) : undefined
    const lastOutputAt = times.length
      ? Math.max(...times.map((value) => value.end ?? value.start))
      : undefined
    const output = positive(last.tokens.output)
    const reasoning = positive(last.tokens.reasoning)
    const duration = elapsedMs(last.time.created, end)
    const latency = elapsedMs(last.time.created, firstOutputAt)
    const hit = cacheHitPercent(session)
    const next: TokenMetrics = {
      input: session.totalInput,
      output: session.totalOutput,
      cacheRead: session.totalCacheRead,
      cacheWrite: session.totalCacheWrite,
      inputEstimated: false,
      outputEstimated: false,
      tps: responseTps(output, reasoning, last.time.created, firstOutputAt, lastOutputAt, end),
      tpsEstimated: false,
      elapsedMs: duration,
      ...(latency === undefined ? {} : { latencyMs: latency }),
      ...(hit === undefined ? {} : { cacheHit: hit }),
      live: false,
    }
    const previous = session.last
    if (
      previous?.input === next.input &&
      previous.output === next.output &&
      previous.cacheRead === next.cacheRead &&
      previous.cacheWrite === next.cacheWrite &&
      previous.tps === next.tps &&
      previous.tpsEstimated === next.tpsEstimated &&
      previous.elapsedMs === next.elapsedMs &&
      previous.latencyMs === next.latencyMs &&
      previous.cacheHit === next.cacheHit &&
      previous.live === next.live
    ) {
      if (changed) this.notify(sessionID)
      return
    }
    session.last = next
    session.lastSource = "hydrate"
    this.notify(sessionID)
  }

  read(sessionID: string): TokenMetrics | undefined {
    const session = this.sessions.get(sessionID)
    const active = session?.active
    const at = this.now()
    if (!active) {
      if (session?.statusBusy && session.executionStartedAt !== undefined) {
        const hit = cacheHitPercent(session)
        return {
          input: session.totalInput,
          output: session.totalOutput,
          cacheRead: session.totalCacheRead,
          cacheWrite: session.totalCacheWrite,
          inputEstimated: false,
          outputEstimated: false,
          tps: session.last?.tps,
          tpsEstimated: session.last?.tpsEstimated ?? false,
          elapsedMs: elapsedMs(session.executionStartedAt, at),
          ...(session.last?.latencyMs === undefined
            ? {}
            : { latencyMs: session.last.latencyMs }),
          ...(hit === undefined ? {} : { cacheHit: hit }),
          live: true,
        }
      }
      return session?.last
    }

    const currentOutput = estimateTokens(active.outputCharacters)
    const currentGenerated = estimateTokens(active.generatedCharacters)
    const input = session.totalInput + (active.inputEstimate ?? 0)
    const output = session.totalOutput + currentOutput
    const hit = cacheHitPercent(session)
    // Once output is streaming, TPS is derived from estimated characters (chars/4)
    // and is therefore an estimate. Before the first delta we surface the previous
    // step's provider-measured TPS, preserving whether that value was itself an estimate.
    const streaming = active.firstOutputAt !== undefined
    const liveTps = streaming
      ? generationTps(currentGenerated, active.firstOutputAt, at)
      : session.last?.tps
    return {
      input,
      output,
      cacheRead: session.totalCacheRead,
      cacheWrite: session.totalCacheWrite,
      inputEstimated: active.inputEstimate !== undefined,
      outputEstimated: true,
      tps: liveTps,
      tpsEstimated: streaming ? true : session.last?.tpsEstimated ?? false,
      elapsedMs: elapsedMs(session.executionStartedAt ?? active.stepStartedAt, at),
      ...(active.firstOutputAt === undefined
        ? session.last?.latencyMs === undefined
          ? {}
          : { latencyMs: session.last.latencyMs }
        : { latencyMs: elapsedMs(active.stepStartedAt, active.firstOutputAt) }),
      ...(hit === undefined ? {} : { cacheHit: hit }),
      live: true,
    }
  }

}

export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0"
  if (value < 1000) return Math.round(value).toString()
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
}

export function formatTps(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "-"
  const safe = Math.min(value, MAX_DISPLAY_TPS)
  if (safe < 10) return safe.toFixed(1)
  return Math.round(safe).toString()
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "-"
  return `${Math.round(value)}%`
}
