import { request as httpsRequest } from "https"
import { access, readFile } from "fs/promises"
import { join } from "path"
import { URL } from "url"

import { Context, PublicAPI } from "@wox-launcher/wox-plugin"

import { getPlatformRuntime } from "./platform"
import { RuntimeSettings } from "./platform/types"

const DEFAULT_CACHE_TTL_SECONDS = 15
const DEFAULT_REQUEST_TIMEOUT_MS = 8000
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings"
const platformRuntime = getPlatformRuntime()

export type GrokAvailability = "pending" | "unavailable" | "ready" | "error"
export type GrokPeriodType = "weekly" | "monthly" | "unknown"

export interface GrokProductUsage {
  product: string
  usagePercent: number | null
}

export interface GrokUsageSnapshot {
  fetchedAt: number
  availability: GrokAvailability
  source: "cli-proxy" | "local-fallback"
  planName: string | null
  email: string | null
  periodType: GrokPeriodType
  creditUsagePercent: number | null
  billingCycleStart: number | null
  billingCycleEnd: number | null
  prepaidBalanceCents: number | null
  onDemandUsedCents: number | null
  onDemandCapCents: number | null
  productUsage: GrokProductUsage[]
  warnings: string[]
}

interface PluginSettings {
  cacheTtlSeconds: number
}

interface CacheEntry {
  snapshot: GrokUsageSnapshot
}

interface UsageQueryOptions {
  forceRefresh?: boolean
}

interface GrokAuth {
  accessToken: string
  email: string | null
  authMode: string | null
  expiresAt: number | null
}

interface JsonRequestOptions {
  method: "GET" | "POST"
  url: string
  headers?: Record<string, string>
  timeoutMs: number
}

interface JsonResponse {
  status: number
  json: unknown
}

export interface GrokUsageProvider {
  start(ctx: Context, api: PublicAPI): Promise<void>
  getSnapshot(ctx: Context, api: PublicAPI, options?: UsageQueryOptions): Promise<GrokUsageSnapshot>
  refresh(ctx: Context, api: PublicAPI): Promise<GrokUsageSnapshot>
  invalidate(): void
}

export class CachedGrokUsageProvider implements GrokUsageProvider {
  private cache: CacheEntry | null = null
  private inflight: Promise<GrokUsageSnapshot> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private started = false

  async start(ctx: Context, api: PublicAPI): Promise<void> {
    if (this.started) {
      return
    }

    this.started = true
    this.triggerBackgroundRefresh(ctx, api)
  }

  invalidate(): void {
    this.cache = null
  }

  async getSnapshot(ctx: Context, api: PublicAPI, options?: UsageQueryOptions): Promise<GrokUsageSnapshot> {
    await this.start(ctx, api)

    if (options?.forceRefresh) {
      return this.refresh(ctx, api)
    }

    if (this.cache !== null) {
      return this.cache.snapshot
    }

    if (this.inflight === null) {
      this.triggerBackgroundRefresh(ctx, api)
    }

    return createEmptyGrokSnapshot()
  }

  async refresh(ctx: Context, api: PublicAPI): Promise<GrokUsageSnapshot> {
    await this.start(ctx, api)
    return this.performRefresh(ctx, api)
  }

  private async loadSnapshot(ctx: Context, api: PublicAPI): Promise<GrokUsageSnapshot> {
    const runtimeSettings = getRuntimeSettings()
    const authPath = join(runtimeSettings.grokHome, "auth.json")

    try {
      await access(authPath)
    } catch {
      return createUnavailableGrokSnapshot(["grok-not-found"])
    }

    let auth: GrokAuth | null
    try {
      auth = readGrokAuthFile(JSON.parse(await readFile(authPath, "utf8")) as unknown)
    } catch (error) {
      const message = toErrorMessage(error)
      await log(api, ctx, "Warning", "Failed to read local Grok auth: " + message)
      return createUnavailableGrokSnapshot(["auth: " + message])
    }

    if (auth === null) {
      return createUnavailableGrokSnapshot(["not-signed-in"])
    }

    try {
      const remote = await fetchGrokRemote(auth.accessToken, runtimeSettings.requestTimeoutMs)
      return {
        fetchedAt: Date.now(),
        availability: "ready",
        source: "cli-proxy",
        planName: remote.planName !== null ? remote.planName : formatGrokPlanName(auth.authMode),
        email: auth.email,
        periodType: remote.periodType,
        creditUsagePercent: remote.creditUsagePercent,
        billingCycleStart: remote.billingCycleStart,
        billingCycleEnd: remote.billingCycleEnd,
        prepaidBalanceCents: remote.prepaidBalanceCents,
        onDemandUsedCents: remote.onDemandUsedCents,
        onDemandCapCents: remote.onDemandCapCents,
        productUsage: remote.productUsage,
        warnings: remote.warnings
      }
    } catch (error) {
      const message = toErrorMessage(error)
      await log(api, ctx, "Warning", "Failed to read Grok usage: " + message)
      return {
        ...createEmptyGrokSnapshot(),
        availability: "error",
        planName: formatGrokPlanName(auth.authMode),
        email: auth.email,
        warnings: [message]
      }
    }
  }

  private async readSettings(ctx: Context, api: PublicAPI): Promise<PluginSettings> {
    return {
      cacheTtlSeconds: await readNumberSetting(api, ctx, "cacheTtlSeconds", DEFAULT_CACHE_TTL_SECONDS)
    }
  }

  private triggerBackgroundRefresh(ctx: Context, api: PublicAPI): void {
    if (this.inflight !== null) {
      return
    }

    void this.performRefresh(ctx, api).catch(async error => {
      await log(api, ctx, "Warning", "Background Grok usage refresh failed: " + toErrorMessage(error))
    })
  }

  private async performRefresh(ctx: Context, api: PublicAPI): Promise<GrokUsageSnapshot> {
    if (this.inflight !== null) {
      return this.inflight
    }

    this.clearRefreshTimer()

    const task = this.readSettings(ctx, api).then(async () => {
      const snapshot = await this.loadSnapshot(ctx, api)
      this.cache = {
        snapshot: snapshot
      }
      return snapshot
    })

    this.inflight = task

    try {
      return await task
    } finally {
      this.inflight = null
      await this.scheduleNextRefresh(ctx, api)
    }
  }

  private async scheduleNextRefresh(ctx: Context, api: PublicAPI): Promise<void> {
    if (!this.started) {
      return
    }

    const settings = await this.readSettings(ctx, api)
    this.clearRefreshTimer()
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.triggerBackgroundRefresh(ctx, api)
    }, settings.cacheTtlSeconds * 1000)
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
  }
}

function getRuntimeSettings(): RuntimeSettings {
  return platformRuntime.getRuntimeSettings(DEFAULT_REQUEST_TIMEOUT_MS)
}

export function createEmptyGrokSnapshot(): GrokUsageSnapshot {
  return {
    fetchedAt: Date.now(),
    availability: "pending",
    source: "local-fallback",
    planName: null,
    email: null,
    periodType: "unknown",
    creditUsagePercent: null,
    billingCycleStart: null,
    billingCycleEnd: null,
    prepaidBalanceCents: null,
    onDemandUsedCents: null,
    onDemandCapCents: null,
    productUsage: [],
    warnings: []
  }
}

function createUnavailableGrokSnapshot(warnings: string[]): GrokUsageSnapshot {
  return {
    ...createEmptyGrokSnapshot(),
    availability: "unavailable",
    warnings: warnings
  }
}

export function shouldShowGrokResult(snapshot: GrokUsageSnapshot, filter: "all" | "codex" | "cursor" | "grok"): boolean {
  if (filter === "grok") {
    return true
  }

  return snapshot.availability === "ready" || snapshot.availability === "error"
}

export function readGrokAuthFile(value: unknown): GrokAuth | null {
  if (!isRecord(value)) {
    return null
  }

  const keys = Object.keys(value)
  const preferred = keys.filter(key => key.indexOf("https://auth.x.ai") === 0)
  const legacy = keys.filter(key => key.indexOf("https://accounts.x.ai") === 0)
  const candidates = preferred.length > 0 ? preferred : legacy.length > 0 ? legacy : keys

  for (let index = 0; index < candidates.length; index += 1) {
    const entry = value[candidates[index]]
    const auth = readGrokAuthEntry(entry)
    if (auth !== null) {
      return auth
    }
  }

  return readGrokAuthEntry(value)
}

function readGrokAuthEntry(value: unknown): GrokAuth | null {
  if (!isRecord(value)) {
    return null
  }

  const accessToken = typeof value.key === "string" ? value.key.trim() : typeof value.access_token === "string" ? value.access_token.trim() : ""
  if (accessToken.length === 0) {
    return null
  }

  return {
    accessToken: accessToken,
    email: typeof value.email === "string" ? value.email : null,
    authMode: typeof value.auth_mode === "string" ? value.auth_mode : null,
    expiresAt: readExpiresAt(value.expires_at)
  }
}

export function readGrokBilling(value: unknown): {
  periodType: GrokPeriodType
  creditUsagePercent: number | null
  billingCycleStart: number | null
  billingCycleEnd: number | null
  prepaidBalanceCents: number | null
  onDemandUsedCents: number | null
  onDemandCapCents: number | null
  productUsage: GrokProductUsage[]
} {
  const config = isRecord(value) && isRecord(value.config) ? value.config : isRecord(value) ? value : null
  if (config === null) {
    return {
      periodType: "unknown",
      creditUsagePercent: null,
      billingCycleStart: null,
      billingCycleEnd: null,
      prepaidBalanceCents: null,
      onDemandUsedCents: null,
      onDemandCapCents: null,
      productUsage: []
    }
  }

  const currentPeriod = isRecord(config.currentPeriod) ? config.currentPeriod : null
  const periodEnd = currentPeriod !== null ? readEpochSeconds(currentPeriod.end) : readEpochSeconds(config.billingPeriodEnd)
  const periodStart = currentPeriod !== null ? readEpochSeconds(currentPeriod.start) : readEpochSeconds(config.billingPeriodStart)

  return {
    periodType: readPeriodType(currentPeriod !== null ? currentPeriod.type : null, periodStart, periodEnd),
    creditUsagePercent: readNumber(config.creditUsagePercent),
    billingCycleStart: periodStart,
    billingCycleEnd: periodEnd,
    prepaidBalanceCents: readCents(config.prepaidBalance),
    onDemandUsedCents: readCents(config.onDemandUsed),
    onDemandCapCents: readCents(config.onDemandCap),
    productUsage: readProductUsage(config.productUsage)
  }
}

export function readGrokSettings(value: unknown): string | null {
  if (!isRecord(value)) {
    return null
  }

  if (typeof value.subscription_tier_display === "string" && value.subscription_tier_display.trim().length > 0) {
    return value.subscription_tier_display.trim()
  }

  if (typeof value.subscriptionTierDisplay === "string" && value.subscriptionTierDisplay.trim().length > 0) {
    return value.subscriptionTierDisplay.trim()
  }

  return null
}

export function getGrokRemainingPercent(usedPercent: number | null): number | null {
  if (usedPercent === null) {
    return null
  }

  return clamp(Math.round(100 - usedPercent), 0, 100)
}

export function formatGrokPlanName(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return "SuperGrok"
  }

  const normalized = value.toLowerCase()
  if (normalized.indexOf("heavy") >= 0) {
    return "SuperGrok Heavy"
  }

  if (normalized.indexOf("supergrok") >= 0 || normalized.indexOf("grok") >= 0) {
    return "SuperGrok"
  }

  return value
}

async function fetchGrokRemote(
  token: string,
  timeoutMs: number
): Promise<{
  planName: string | null
  periodType: GrokPeriodType
  creditUsagePercent: number | null
  billingCycleStart: number | null
  billingCycleEnd: number | null
  prepaidBalanceCents: number | null
  onDemandUsedCents: number | null
  onDemandCapCents: number | null
  productUsage: GrokProductUsage[]
  warnings: string[]
}> {
  const results = await Promise.all([getJson(BILLING_URL, token, timeoutMs), getJson(SETTINGS_URL, token, timeoutMs).catch(() => null)])
  const billing = readGrokBilling(readApiJson(results[0], "billing"))
  const planName = results[1] !== null ? readGrokSettings(readOptionalApiJson(results[1])) : null

  if (billing.creditUsagePercent === null && billing.billingCycleEnd === null && billing.productUsage.length === 0) {
    throw new Error("Grok billing API returned no usage data")
  }

  return {
    planName: planName,
    periodType: billing.periodType,
    creditUsagePercent: billing.creditUsagePercent,
    billingCycleStart: billing.billingCycleStart,
    billingCycleEnd: billing.billingCycleEnd,
    prepaidBalanceCents: billing.prepaidBalanceCents,
    onDemandUsedCents: billing.onDemandUsedCents,
    onDemandCapCents: billing.onDemandCapCents,
    productUsage: billing.productUsage,
    warnings: []
  }
}

async function getJson(url: string, token: string, timeoutMs: number): Promise<JsonResponse> {
  return requestJson({
    method: "GET",
    url: url,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "x-xai-token-auth": "xai-grok-cli"
    },
    timeoutMs: timeoutMs
  })
}

function readApiJson(response: JsonResponse, label: string): unknown {
  if (response.status === 401 || response.status === 403) {
    throw new Error("Grok session expired; run grok login")
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error("Grok " + label + " failed with HTTP " + String(response.status))
  }

  return response.json
}

function readOptionalApiJson(response: JsonResponse): unknown {
  if (response.status < 200 || response.status >= 300) {
    return null
  }

  return response.json
}

function readPeriodType(value: unknown, start: number | null, end: number | null): GrokPeriodType {
  if (typeof value === "string") {
    const normalized = value.toUpperCase()
    if (normalized.indexOf("WEEK") >= 0) {
      return "weekly"
    }

    if (normalized.indexOf("MONTH") >= 0) {
      return "monthly"
    }
  }

  if (start !== null && end !== null) {
    const days = (end - start) / 86400
    if (days >= 25) {
      return "monthly"
    }

    if (days >= 5) {
      return "weekly"
    }
  }

  return "unknown"
}

function readProductUsage(value: unknown): GrokProductUsage[] {
  if (!Array.isArray(value)) {
    return []
  }

  const result: GrokProductUsage[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (!isRecord(item) || typeof item.product !== "string") {
      continue
    }

    result.push({
      product: item.product,
      usagePercent: readNumber(item.usagePercent)
    })
  }

  return result
}

function readCents(value: unknown): number | null {
  if (isRecord(value)) {
    return readNumber(value.val)
  }

  return readNumber(value)
}

function readExpiresAt(value: unknown): number | null {
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000)
    }
  }

  return readEpochSeconds(value)
}

function readEpochSeconds(value: unknown): number | null {
  if (typeof value === "string" && value.trim().length > 0 && value.indexOf("-") >= 0) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000)
    }
  }

  const numeric = readNumber(value)
  if (numeric === null) {
    return null
  }

  if (numeric > 100000000000) {
    return Math.floor(numeric / 1000)
  }

  return Math.floor(numeric)
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

async function requestJson(options: JsonRequestOptions): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url)
    const headers: Record<string, string | number> = {
      Accept: "application/json",
      "User-Agent": "wox-plugin-ai-quota/0.4.0"
    }

    if (options.headers !== undefined) {
      const headerKeys = Object.keys(options.headers)
      for (let index = 0; index < headerKeys.length; index += 1) {
        headers[headerKeys[index]] = options.headers[headerKeys[index]]
      }
    }

    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method,
        headers: headers
      },
      res => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk)
        })
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8").trim()
          if (raw.length === 0) {
            resolve({
              status: res.statusCode || 0,
              json: null
            })
            return
          }

          try {
            resolve({
              status: res.statusCode || 0,
              json: JSON.parse(raw) as unknown
            })
          } catch {
            reject(new Error("Grok API returned a non-JSON response"))
          }
        })
      }
    )

    req.on("error", error => {
      reject(error instanceof Error ? error : new Error(String(error)))
    })

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error("Timed out while waiting for Grok API"))
    })

    req.end()
  })
}

async function readStringSetting(api: PublicAPI, ctx: Context, key: string, fallback: string): Promise<string> {
  if (typeof api.GetSetting !== "function") {
    return fallback
  }

  try {
    const value = await api.GetSetting(ctx, key)
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  } catch {
    return fallback
  }

  return fallback
}

async function readNumberSetting(api: PublicAPI, ctx: Context, key: string, fallback: number): Promise<number> {
  const raw = await readStringSetting(api, ctx, key, String(fallback))
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}

async function log(api: PublicAPI, ctx: Context, level: "Info" | "Warning" | "Error" | "Debug", message: string): Promise<void> {
  if (typeof api.Log !== "function") {
    return
  }

  try {
    await api.Log(ctx, level, message)
  } catch {
    return
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
