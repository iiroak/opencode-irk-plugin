import assert from "node:assert/strict"
import test from "node:test"
import type { Event } from "@opencode-ai/sdk/v2"
import { formatTps, MetricsStore } from "../src/metrics.ts"

const event = (type: Event["type"], properties: Record<string, unknown>): Event =>
  ({ id: `${type}-id`, type, properties } as Event)

test("estimates output and TPS while a response is streaming", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.prompt.admitted", {
      timestamp: 1_001,
      sessionID: "session",
      messageID: "user",
      prompt: { text: "x".repeat(40) },
      delivery: "steer",
    }),
  )
  store.handle(
    event("session.next.text.delta", {
      timestamp: 2_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      textID: "text",
      delta: "x".repeat(40),
    }),
  )
  store.handle(
    event("session.next.text.delta", {
      timestamp: 2_500,
      sessionID: "session",
      assistantMessageID: "assistant",
      textID: "text",
      delta: "x".repeat(40),
    }),
  )
  store.setClock(() => 3_000)

  const metrics = store.read("session")
  assert.deepEqual(metrics, {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    inputEstimated: true,
    outputEstimated: true,
    tps: 20,
    tpsEstimated: true,
    elapsedMs: 2_000,
    latencyMs: 1_000,
    live: true,
  })
})

test("updates the live duration as the clock advances", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.setClock(() => 1_500)
  assert.equal(store.read("session")?.elapsedMs, 500)
  store.setClock(() => 2_500)
  assert.equal(store.read("session")?.elapsedMs, 1_500)
})

test("updates TPS from the real streaming window", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.setClock(() => 2_000)
  store.handle(
    event("session.next.text.delta", {
      timestamp: 2_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      textID: "text",
      delta: "x".repeat(40),
    }),
  )
  assert.equal(store.read("session")?.tps, undefined)
  assert.equal(store.read("session")?.latencyMs, 1_000)

  store.setClock(() => 3_000)
  store.handle(
    event("session.next.text.delta", {
      timestamp: 3_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      textID: "text",
      delta: "x".repeat(40),
    }),
  )
  assert.equal(store.read("session")?.tps, 20)
  assert.equal(store.read("session")?.latencyMs, 1_000)
})

test("updates TPS while reasoning is streaming", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.setClock(() => 2_000)
  store.handle(
    event("session.next.reasoning.delta", {
      timestamp: 2_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      reasoningID: "reasoning",
      delta: "x".repeat(40),
    }),
  )
  assert.equal(store.read("session")?.tps, undefined)

  store.setClock(() => 3_000)
  store.handle(
    event("session.next.reasoning.delta", {
      timestamp: 3_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      reasoningID: "reasoning",
      delta: "x".repeat(40),
    }),
  )
  assert.equal(store.read("session")?.tps, 20)

  store.handle(
    event("session.next.step.ended", {
      timestamp: 4_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 20, cache: { read: 0, write: 0 } },
    }),
  )
  // Reasoning tokens are amortized over the full step (1000→4000 = 3s),
  // not the shorter visible-delta window, so 20 reasoning tokens = 20/3 tps.
  assert.equal(store.read("session")?.tps, 20 / 3)
})

test("amortizes reasoning over the full step and flags live TPS as estimated", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  // First visible delta only arrives at 5s: most reasoning happened before it.
  store.setClock(() => 6_000)
  store.handle(
    event("session.next.text.delta", {
      timestamp: 5_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      textID: "text",
      delta: "x".repeat(40),
    }),
  )
  // While streaming, TPS is derived from estimated characters, so it is flagged.
  const live = store.read("session")
  assert.equal(live?.tpsEstimated, true)
  assert.ok((live?.tps ?? 0) > 0)

  store.handle(
    event("session.next.step.ended", {
      timestamp: 11_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 100, reasoning: 900, cache: { read: 0, write: 0 } },
    }),
  )
  // Final TPS uses provider-exact tokens over the whole 10s step: 1000/10 = 100.
  // The old visible-window math (5s→5s) would have inflated or dropped this.
  const final = store.read("session")
  assert.equal(final?.tps, 100)
  assert.equal(final?.tpsEstimated, false)
})

test("reconciles estimates with exact provider usage at step end", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.setClock(() => 3_000)
  store.handle(
    event("session.next.text.delta", {
      timestamp: 2_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      textID: "text",
      delta: "x".repeat(40),
    }),
  )
  store.handle(
    event("session.next.step.ended", {
      timestamp: 3_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      finish: "stop",
      cost: 0,
      tokens: {
        input: 123,
        output: 50,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  )

  assert.deepEqual(store.read("session"), {
    input: 123,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    inputEstimated: false,
    outputEstimated: false,
    tps: 25,
    tpsEstimated: false,
    elapsedMs: 2_000,
    latencyMs: 1_000,
    cacheHit: 0,
    live: false,
  })
})

test("accumulates input and output across steps without resetting", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "first",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.step.ended", {
      timestamp: 3_000,
      sessionID: "session",
      assistantMessageID: "first",
      finish: "stop",
      cost: 0,
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 40, write: 10 } },
    }),
  )
  assert.equal(store.read("session")?.input, 100)
  assert.equal(store.read("session")?.output, 20)

  store.handle(
    event("session.next.step.started", {
      timestamp: 4_000,
      sessionID: "session",
      assistantMessageID: "second",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.step.ended", {
      timestamp: 6_000,
      sessionID: "session",
      assistantMessageID: "second",
      finish: "stop",
      cost: 0,
      tokens: { input: 50, output: 30, reasoning: 0, cache: { read: 10, write: 0 } },
    }),
  )

  assert.deepEqual(store.read("session"), {
    input: 150,
    output: 50,
    cacheRead: 50,
    cacheWrite: 10,
    inputEstimated: false,
    outputEstimated: false,
    tps: 15,
    tpsEstimated: false,
    elapsedMs: 5_000,
    cacheHit: 24,
    live: false,
  })
})

test("uses step duration instead of the first delta for bursty providers", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.text.delta", {
      timestamp: 9_999,
      sessionID: "session",
      assistantMessageID: "assistant",
      textID: "text",
      delta: "x".repeat(400),
    }),
  )
  store.handle(
    event("session.next.step.ended", {
      timestamp: 10_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )

  assert.equal(store.read("session")?.tps, 100 / 9)
  assert.ok((store.read("session")?.tps ?? 0) < 100)
})

test("does not report TPS for an interval too short to measure", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.step.ended", {
      timestamp: 1_050,
      sessionID: "session",
      assistantMessageID: "assistant",
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )

  assert.equal(store.read("session")?.tps, undefined)
  assert.equal(formatTps(999_999), "100000")
})

test("keeps metrics isolated by session and clears failed steps", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "one",
      assistantMessageID: "assistant-one",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "two",
      assistantMessageID: "assistant-two",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.text.delta", {
      timestamp: 2_000,
      sessionID: "one",
      assistantMessageID: "assistant-one",
      textID: "text",
      delta: "x".repeat(8),
    }),
  )
  store.handle(
    event("session.next.step.failed", {
      timestamp: 2_000,
      sessionID: "two",
      assistantMessageID: "assistant-two",
      error: { name: "UnknownError", data: { message: "failed" } },
    }),
  )

  assert.equal(store.read("one")?.output, 2)
  assert.equal(store.read("two"), undefined)
})

test("hydrates exact usage and generation time for an existing session", () => {
  const store = new MetricsStore()
  store.hydrate(
    "session",
    [
      {
        id: "previous",
        sessionID: "session",
        role: "assistant",
        time: { created: 500, completed: 2_000 },
        parentID: "user-previous",
        modelID: "model",
        providerID: "provider",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 50, output: 20, reasoning: 0, cache: { read: 10, write: 5 } },
      },
      {
        id: "assistant",
        sessionID: "session",
        role: "assistant",
        time: { created: 1_000, completed: 4_000 },
        parentID: "user",
        modelID: "model",
        providerID: "provider",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 90, output: 30, reasoning: 0, cache: { read: 20, write: 0 } },
      },
    ],
    [
      {
        id: "text",
        sessionID: "session",
        messageID: "assistant",
        type: "text",
        text: "response",
        time: { start: 2_000, end: 3_000 },
      },
    ],
  )

  assert.deepEqual(store.read("session"), {
    input: 140,
    output: 50,
    cacheRead: 30,
    cacheWrite: 5,
    inputEstimated: false,
    outputEstimated: false,
    tps: 30,
    tpsEstimated: false,
    elapsedMs: 3_000,
    latencyMs: 1_000,
    cacheHit: 17,
    live: false,
  })
})

test("keeps event timing when hydration has broader message timestamps", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.step.ended", {
      timestamp: 2_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      finish: "stop",
      cost: 0,
      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
  store.hydrate(
    "session",
    [
      {
        id: "assistant",
        sessionID: "session",
        role: "assistant",
        time: { created: 0, completed: 12_000 },
        parentID: "user",
        modelID: "model",
        providerID: "provider",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
    [],
  )

  assert.equal(store.read("session")?.elapsedMs, 1_000)
  assert.equal(store.read("session")?.tps, 10)
})

test("reports a live elapsed time for a resumed busy session without step events", () => {
  const store = new MetricsStore()
  store.setSessionBusy("session", true, 10_000)
  store.setClock(() => 12_000)
  const metrics = store.read("session")
  assert.equal(metrics?.live, true)
  assert.equal(metrics?.elapsedMs, 2_000)
  assert.equal(metrics?.tps, undefined)
  store.setSessionBusy("session", false, 13_000)
  assert.equal(store.read("session"), undefined)
})

test("keeps counting elapsed across chained steps of one execution", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.prompted", {
      timestamp: 1_000,
      sessionID: "session",
      messageID: "user",
      prompt: { text: "hi" },
      delivery: "steer",
    }),
  )
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "first",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.step.ended", {
      timestamp: 2_000,
      sessionID: "session",
      assistantMessageID: "first",
      finish: "stop",
      cost: 0,
      tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
  store.handle(
    event("session.next.step.started", {
      timestamp: 2_000,
      sessionID: "session",
      assistantMessageID: "second",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.step.ended", {
      timestamp: 4_000,
      sessionID: "session",
      assistantMessageID: "second",
      finish: "stop",
      cost: 0,
      tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
  assert.equal(store.read("session")?.elapsedMs, 3_000)
})

test("calculates live TPS after a single burst delta has a measurable interval", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.setClock(() => 2_000)
  store.handle(
    event("session.next.text.delta", {
      timestamp: 2_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      textID: "text",
      delta: "x".repeat(400),
    }),
  )
  assert.equal(store.read("session")?.tps, undefined)

  store.setClock(() => 3_000)
  assert.equal(store.read("session")?.tps, 100)

  store.handle(
    event("session.next.step.ended", {
      timestamp: 6_000,
      sessionID: "session",
      assistantMessageID: "assistant",
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
  assert.equal(store.read("session")?.tps, 20)
})

test("keeps the last TPS visible while a busy execution moves between steps", () => {
  const store = new MetricsStore()
  store.handle(
    event("session.next.step.started", {
      timestamp: 1_000,
      sessionID: "session",
      assistantMessageID: "assistant-one",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  store.handle(
    event("session.next.text.delta", {
      timestamp: 2_000,
      sessionID: "session",
      assistantMessageID: "assistant-one",
      textID: "text",
      delta: "x".repeat(80),
    }),
  )
  store.handle(
    event("session.next.text.delta", {
      timestamp: 3_000,
      sessionID: "session",
      assistantMessageID: "assistant-one",
      textID: "text",
      delta: "x".repeat(80),
    }),
  )
  store.handle(
    event("session.next.step.ended", {
      timestamp: 4_000,
      sessionID: "session",
      assistantMessageID: "assistant-one",
      finish: "tool-calls",
      cost: 0,
      tokens: { input: 0, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
  store.setSessionBusy("session", true, 4_000)
  assert.equal(store.read("session")?.tps, 40)

  store.handle(
    event("session.next.step.started", {
      timestamp: 5_000,
      sessionID: "session",
      assistantMessageID: "assistant-two",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }),
  )
  assert.equal(store.read("session")?.tps, 40)
})
