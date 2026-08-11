import assert from "node:assert/strict"
import test from "node:test"
import { CodexClient, CodexUsageError, __testHelpers } from "../src/codex.ts"

const { buildWindow, buildCredits, parseUsage } = __testHelpers

function makeAuth(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    openai: {
      type: "oauth",
      methodID: "browser",
      refresh: "rt-original",
      access: "access-original",
      expires: Date.now() + 60 * 60 * 1000,
      accountId: "account-1",
      ...overrides,
    },
  })
}

test("parses primary and secondary windows with sanitized output", () => {
  const usage = parseUsage(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 68, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 31, limit_window_seconds: 604_800, reset_at: 1_900_000_000 },
      },
      credits: { has_credits: true, unlimited: false, balance: "$5.00" },
      rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 },
      promo: "Welcome back",
      rate_limit_reached_type: null,
    },
    1_700_000_000_000,
  )
  assert.equal(usage.planType, "pro")
  assert.equal(usage.primary?.usedPercent, 68)
  assert.equal(usage.primary?.windowMinutes, 300)
  assert.equal(usage.primary?.resetsAt, 1_800_000_000)
  assert.equal(usage.secondary?.windowMinutes, 10080)
  assert.deepEqual(usage.credits, { hasCredits: true, unlimited: false, balance: "$5.00" })
  assert.deepEqual(usage.resetCredits, { availableCount: 1, applicableAvailableCount: 0 })
  assert.equal(usage.promoMessage, "Welcome back")
})

test("drops reset credits when the payload is missing or malformed", () => {
  const usage = parseUsage(
    {
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 5, reset_at: 1 } },
    },
    1_700_000_000_000,
  )
  assert.equal(usage.resetCredits, null)
})

test("keeps available count when applicable_available_count is missing", () => {
  const usage = parseUsage(
    {
      plan_type: "plus",
      rate_limit_reset_credits: { available_count: 2 },
    },
    1_700_000_000_000,
  )
  assert.deepEqual(usage.resetCredits, { availableCount: 2, applicableAvailableCount: null })
})

test("clamps usage percentages and drops malformed values", () => {
  const window = buildWindow("codex", null, {
    used_percent: 250,
    limit_window_seconds: 60,
    reset_at: Number.NaN,
  })
  assert.equal(window?.usedPercent, 100)
  assert.equal(window?.windowMinutes, 1)
  assert.equal(window?.resetsAt, null)
})

test("builds credits only when has_credits is present", () => {
  assert.equal(buildCredits(undefined), null)
  assert.deepEqual(buildCredits({ has_credits: false, unlimited: false, balance: "$0" }), {
    hasCredits: false,
    unlimited: false,
    balance: null,
  })
  assert.deepEqual(buildCredits({ has_credits: true, unlimited: false, balance: "" }), {
    hasCredits: true,
    unlimited: false,
    balance: null,
  })
})

test("rejects requests when OpenCode has no openai account", async () => {
  const client = new CodexClient({
    opencodeAuthContent: "{}",
    now: () => 1_700_000_000_000,
  })
  await assert.rejects(
    () => client.readUsage(),
    (error: unknown) =>
      error instanceof CodexUsageError &&
      error.code === "no_account" &&
      /login openai/i.test(error.message),
  )
})

test("rejects requests when the account is not OAuth", async () => {
  const client = new CodexClient({
    opencodeAuthContent: JSON.stringify({ openai: { type: "api", key: "sk-test" } }),
    now: () => 1_700_000_000_000,
  })
  await assert.rejects(
    () => client.readUsage(),
    (error: unknown) =>
      error instanceof CodexUsageError &&
      error.code === "no_account" &&
      /OAuth/i.test(error.message),
  )
})

test("queries the usage endpoint with sanitized headers and parses the response", async () => {
  const auth = makeAuth()
  let captured: { url: string; headers: Record<string, string> } | undefined
  const client = new CodexClient({
    opencodeAuthContent: auth,
    now: () => 1_700_000_000_000,
    async fetch(input, init) {
      captured = {
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 42,
                limit_window_seconds: 18_000,
                reset_at: 1_800_000_000,
              },
            },
            credits: { has_credits: false, unlimited: false },
          }
        },
      }
    },
  })

  const usage = await client.readUsage()
  assert.equal(captured?.url, "https://chatgpt.com/backend-api/wham/usage")
  assert.equal(captured?.headers.authorization, "Bearer access-original")
  assert.equal(captured?.headers["chatgpt-account-id"], "account-1")
  assert.equal(captured?.headers.accept, "application/json")
  assert.match(captured?.headers["user-agent"] ?? "", /codex_cli_rs/)
  assert.equal(usage.planType, "plus")
  assert.equal(usage.primary?.usedPercent, 42)
  assert.equal(usage.primary?.windowMinutes, 300)
  assert.equal(usage.credits?.hasCredits, false)
})

test("refreshes the token once when the access is about to expire", async () => {
  const now = 1_700_000_000_000
  const auth = makeAuth({ access: "stale-access", refresh: "rt-old", expires: now + 30_000 })
  const { writeFile, mkdtemp, readFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "codex-usage-"))
  const file = join(dir, "auth.json")
  await writeFile(file, auth, "utf8")

  const usageCalls: string[] = []
  const client = new CodexClient({
    authFile: file,
    now: () => 1_700_000_000_000,
    async fetch(input) {
      const url = String(input)
      usageCalls.push(url)
      if (url.endsWith("/oauth/token")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "fresh-access",
              refresh_token: "rt-fresh",
              expires_in: 3600,
            }
          },
        }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { plan_type: "plus" }
        },
      }
    },
  })

  const usage = await client.readUsage()
  assert.equal(usage.planType, "plus")
  assert.equal(usageCalls.length, 2)
  assert.ok(usageCalls.some((url) => url.endsWith("/oauth/token")))
  assert.ok(usageCalls.includes("https://chatgpt.com/backend-api/wham/usage"))
  const persisted = JSON.parse(await readFile(file, "utf8"))
  assert.equal(persisted.openai.access, "fresh-access")
  assert.equal(persisted.openai.refresh, "rt-fresh")
})
