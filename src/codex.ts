import { homedir } from "node:os"
import { join } from "node:path"
import { readFile, writeFile } from "node:fs/promises"

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const OPENCODE_PROVIDER = "openai"
const REFRESH_SKEW_MS = 60_000
const REQUEST_TIMEOUT_MS = 10_000

const REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const REFRESH_ISSUER = "https://auth.openai.com"
const CODEX_USER_AGENT = "codex_cli_rs/0.146.0 (opencode-irk-plugin; linux)"

export type CodexWindowSnapshot = {
  limitId: string
  limitName: string | null
  usedPercent: number
  windowMinutes: number | null
  resetsAt: number | null
}

export type CodexCreditsSnapshot = {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export type CodexResetCreditsSnapshot = {
  availableCount: number
  applicableAvailableCount: number | null
}

export type CodexUsage = {
  planType: string | null
  limitId: string | null
  primary: CodexWindowSnapshot | null
  secondary: CodexWindowSnapshot | null
  credits: CodexCreditsSnapshot | null
  resetCredits: CodexResetCreditsSnapshot | null
  rateLimitReachedType: string | null
  promoMessage: string | null
  capturedAt: number
}

export class CodexUsageError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "CodexUsageError"
    this.code = code
  }
}

type OAuthCredential = {
  type: "oauth"
  methodID?: string
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

type AnyCredential = { type?: string; [key: string]: unknown }

type UsageResponse = {
  plan_type?: string | null
  rate_limit?: {
    primary_window?: RateWindow | null
    secondary_window?: RateWindow | null
  } | null
  credits?: {
    has_credits?: boolean
    unlimited?: boolean
    balance?: string | null
  } | null
  rate_limit_reset_credits?: {
    available_count?: number | null
    applicable_available_count?: number | null
  } | null
  rate_limit_reached_type?: string | null
  promo?: string | { message?: string | null } | null
  limit_id?: string | null
  limit_name?: string | null
}

type RateWindow = {
  used_percent?: number | null
  limit_window_seconds?: number | null
  reset_at?: number | null
}

type FetchLike = (
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; body?: string },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

type TokenResponse = {
  access: string
  refresh: string
  expiresAt: number
  accountId?: string
}

export type CodexClientOptions = {
  fetch?: FetchLike
  now?: () => number
  home?: string
  authFile?: string
  opencodeAuthContent?: string
  refreshAccessToken?: (refreshToken: string) => Promise<TokenResponse>
  endpoint?: string
}

export class CodexClient {
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly home: string
  private readonly authFile: string
  private readonly opencodeAuthContent: string | undefined
  private readonly refreshAccessToken: (refreshToken: string) => Promise<TokenResponse>
  private readonly endpoint: string
  private cached: TokenResponse & { accountId: string; endpoint: string } | null = null

  constructor(options: CodexClientOptions = {}) {
    this.fetchImpl = options.fetch ?? (defaultFetch as FetchLike)
    this.now = options.now ?? Date.now
    this.home = options.home ?? homedir()
    this.authFile = options.authFile ?? join(this.home, ".local", "share", "opencode", "auth.json")
    this.opencodeAuthContent = options.opencodeAuthContent
    this.refreshAccessToken =
      options.refreshAccessToken ??
      ((refreshToken) =>
        defaultRefreshAccessToken(refreshToken, (input, init) => this.fetchImpl(input, init)))
    this.endpoint = options.endpoint ?? CODEX_USAGE_URL
  }

  async readUsage(): Promise<CodexUsage> {
    const token = await this.resolveToken()
    const response = await this.fetchImpl(token.endpoint, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token.access}`,
        "chatgpt-account-id": token.accountId,
        accept: "application/json",
        "user-agent": CODEX_USER_AGENT,
        "accept-language": "en-US,en;q=0.9",
      },
    })
    if (!response.ok) {
      if (response.status === 401) {
        throw new CodexUsageError(
          "unauthorized",
          "OpenAI rejected the Codex usage request. Reconnect your OpenAI account with `opencode auth login openai` and try again.",
        )
      }
      throw new CodexUsageError(
        "http_error",
        `Codex usage request failed: HTTP ${response.status}`,
      )
    }
    const payload = (await response.json()) as UsageResponse
    return parseUsage(payload, this.now())
  }

  private async resolveToken(): Promise<TokenResponse & { accountId: string; endpoint: string }> {
    if (this.cached && this.cached.expiresAt - this.now() > REFRESH_SKEW_MS) {
      return { ...this.cached }
    }

    const credential = await readCodexAuth(this.authFile, this.opencodeAuthContent)
    const accountId = credential.accountId
    if (!accountId) {
      throw new CodexUsageError(
        "no_account",
        "OpenCode could not read the ChatGPT account id. Reconnect the OpenAI account with `opencode auth login openai`.",
      )
    }

    if (credential.expires - this.now() > REFRESH_SKEW_MS) {
      this.cached = {
        access: credential.access,
        refresh: credential.refresh,
        expiresAt: credential.expires,
        accountId,
        endpoint: credential.enterpriseUrl
          ? new URL("/backend-api/wham/usage", credential.enterpriseUrl).toString()
          : this.endpoint,
      }
      return { ...this.cached }
    }

    const refreshed = await this.refreshAccessToken(credential.refresh)
    const next = {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expiresAt: refreshed.expiresAt,
      accountId: refreshed.accountId ?? accountId,
    }
    await persistRefreshed(this.authFile, this.opencodeAuthContent, credential, next)
    this.cached = {
      ...next,
      endpoint: credential.enterpriseUrl
        ? new URL("/backend-api/wham/usage", credential.enterpriseUrl).toString()
        : this.endpoint,
    }
    return { ...this.cached }
  }
}

export function parseUsage(payload: UsageResponse, capturedAt: number): CodexUsage {
  const rateLimit = payload.rate_limit ?? null
  const primary = buildWindow("codex", payload.limit_name ?? null, rateLimit?.primary_window ?? null)
  const secondary = buildWindow("codex", payload.limit_name ?? null, rateLimit?.secondary_window ?? null)
  const credits = buildCredits(payload.credits)
  const resetCredits = buildResetCredits(payload.rate_limit_reset_credits)
  return {
    planType: pickString(payload.plan_type),
    limitId: pickString(payload.limit_id),
    primary,
    secondary,
    credits,
    resetCredits,
    rateLimitReachedType: pickString(payload.rate_limit_reached_type),
    promoMessage: pickPromo(payload.promo),
    capturedAt,
  }
}

function buildWindow(
  limitId: string,
  limitName: string | null,
  source: RateWindow | null | undefined,
): CodexWindowSnapshot | null {
  if (!source) return null
  const used = Number(source.used_percent ?? 0)
  if (!Number.isFinite(used)) return null
  const seconds = Number(source.limit_window_seconds ?? Number.NaN)
  const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null
  const resetsAt = Number.isFinite(Number(source.reset_at)) ? Number(source.reset_at) : null
  return {
    limitId,
    limitName,
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMinutes: minutes,
    resetsAt,
  }
}

function buildCredits(source: UsageResponse["credits"]): CodexCreditsSnapshot | null {
  if (!source || typeof source.has_credits !== "boolean") return null
  const balance =
    source.has_credits && source.balance !== null && source.balance !== undefined && source.balance !== ""
      ? String(source.balance)
      : null
  return {
    hasCredits: source.has_credits,
    unlimited: Boolean(source.unlimited),
    balance,
  }
}

function buildResetCredits(
  source: UsageResponse["rate_limit_reset_credits"],
): CodexResetCreditsSnapshot | null {
  if (!source) return null
  const available = Number(source.available_count ?? Number.NaN)
  if (!Number.isFinite(available)) return null
  const applicable = Number(source.applicable_available_count ?? Number.NaN)
  return {
    availableCount: Math.max(0, Math.trunc(available)),
    applicableAvailableCount: Number.isFinite(applicable) ? Math.max(0, Math.trunc(applicable)) : null,
  }
}

function pickString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

function pickPromo(value: UsageResponse["promo"]): string | null {
  if (!value) return null
  if (typeof value === "string") return pickString(value)
  return pickString(value.message ?? null)
}

async function readCodexAuth(
  file: string,
  content: string | undefined,
): Promise<OAuthCredential> {
  const raw = content ?? (await readFile(file, "utf8").catch(() => "{}"))
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const entry = parsed[OPENCODE_PROVIDER] as AnyCredential | undefined
  if (!entry) {
    throw new CodexUsageError(
      "no_account",
      "OpenCode has no ChatGPT account connected. Run `opencode auth login openai` first.",
    )
  }
  if (entry.type !== "oauth") {
    throw new CodexUsageError(
      "no_account",
      "Codex usage is only available for ChatGPT OAuth accounts, not API keys.",
    )
  }
  if (typeof entry.refresh !== "string" || typeof entry.access !== "string" || typeof entry.expires !== "number") {
    throw new CodexUsageError(
      "no_account",
      "OpenCode's OpenAI credential is malformed. Reconnect the OpenAI account with `opencode auth login openai`.",
    )
  }
  if (typeof entry.accountId !== "string" || !entry.accountId) {
    throw new CodexUsageError(
      "no_account",
      "OpenCode could not read the ChatGPT account id. Reconnect the OpenAI account with `opencode auth login openai`.",
    )
  }
  return entry as OAuthCredential
}

async function persistRefreshed(
  file: string,
  content: string | undefined,
  current: OAuthCredential,
  next: { access: string; refresh: string; expiresAt: number; accountId: string },
): Promise<void> {
  if (content !== undefined) return
  const raw = await readFile(file, "utf8").catch(() => "{}")
  const data = JSON.parse(raw) as Record<string, unknown>
  const updated: OAuthCredential = {
    ...current,
    access: next.access,
    refresh: next.refresh,
    expires: next.expiresAt,
    accountId: next.accountId,
  }
  data[OPENCODE_PROVIDER] = updated
  await writeFile(file, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 })
}

export async function defaultRefreshAccessToken(
  refreshToken: string,
  fetchImpl: FetchLike = defaultFetch as FetchLike,
): Promise<TokenResponse> {
  const response = await fetchImpl(`${REFRESH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: REFRESH_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new CodexUsageError("refresh_failed", `Token refresh failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    id_token?: string
  }
  if (!body.access_token || !body.refresh_token) {
    throw new CodexUsageError("refresh_invalid", "Token refresh returned an incomplete response")
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(body.id_token) ?? extractAccountId(body.access_token),
  }
}

function extractAccountId(token: string | undefined): string | undefined {
  if (!token) return undefined
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
      chatgpt_account_id?: string
      "https://api.openai.com/auth"?: { chatgpt_account_id?: string }
      organizations?: Array<{ id?: string }>
    }
    return (
      claims.chatgpt_account_id ||
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
      claims.organizations?.[0]?.id
    )
  } catch {
    return undefined
  }
}

const defaultFetch: FetchLike = async (input, init) => {
  const response = await fetch(input, {
    ...(init ?? {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return {
    ok: response.ok,
    status: response.status,
    json: response.json.bind(response),
  }
}

export { defaultFetch }

export const __testHelpers = {
  buildWindow,
  buildCredits,
  buildResetCredits,
  pickPromo,
  parseUsage,
  pickString,
}
