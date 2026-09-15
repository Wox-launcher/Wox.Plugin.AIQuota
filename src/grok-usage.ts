import { request as httpsRequest } from "https"
import { access, readFile, rename, unlink, writeFile } from "fs/promises"
import { join } from "path"
import { URL } from "url"

import { Context, PublicAPI } from "@wox-launcher/wox-plugin"

import { getPlatformRuntime } from "./platform"
import { RuntimeSettings } from "./platform/types"

const DEFAULT_CACHE_TTL_SECONDS = 15
const DEFAULT_REQUEST_TIMEOUT_MS = 8000
const TOKEN_EXPIRY_SKEW_MS = 120000
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings"
const OIDC_ISSUER = "https://auth.x.ai"
const OIDC_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
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
  refreshToken: string | null
  email: string | null
  authMode: string | null
  expiresAt: number | null
  clientId: string | null
  issuer: string | null
  entryKey: string | null
}

interface JsonRequestOptions {
  method: "GET" | "POST"
  url: string
  headers?: Record<string, string>
  body?: string
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

    return this.refresh(ctx, api)
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
      const remote = await fetchGrokUsage(auth, authPath, runtimeSettings.requestTimeoutMs)
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

export function shouldShowGrokResult(snapshot: GrokUsageSnapshot, filter: "all" | "codex" | "cursor" | "grok" | "claude"): boolean {
  if (snapshot.availability === "pending") {
    return false
  }

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
    const auth = readGrokAuthEntry(entry, candidates[index])
    if (auth !== null) {
      return auth
    }
  }

  return readGrokAuthEntry(value, null)
}

function readGrokAuthEntry(value: unknown, entryKey: string | null): GrokAuth | null {
  if (!isRecord(value)) {
    return null
  }

  const accessToken = firstString(value, ["key", "access_token"])
  if (accessToken === null) {
    return null
  }

  const clientId = firstString(value, ["oidc_client_id", "client_id"])
  return {
    accessToken: accessToken,
    refreshToken: firstString(value, ["refresh_token", "refreshToken"]),
    email: firstString(value, ["email"]),
    authMode: firstString(value, ["auth_mode", "authMode"]),
    expiresAt: readExpiresAt(value.expires_at !== undefined ? value.expires_at : value.expiresAt),
    clientId: clientId !== null ? clientId : clientIdFromEntryKey(entryKey),
    issuer: firstString(value, ["oidc_issuer", "issuer"]),
    entryKey: entryKey
  }
}

export function mergeGrokAuth(raw: Record<string, unknown>, auth: GrokAuth): Record<string, unknown> {
  const expiresAt = auth.expiresAt !== null ? new Date(auth.expiresAt * 1000).toISOString() : undefined
  const nextEntry: Record<string, unknown> = {}

  if (auth.entryKey !== null && isRecord(raw[auth.entryKey])) {
    Object.assign(nextEntry, raw[auth.entryKey])
  } else if (auth.entryKey === null) {
    Object.assign(nextEntry, raw)
  }

  nextEntry.key = auth.accessToken
  if (auth.refreshToken !== null) {
    nextEntry.refresh_token = auth.refreshToken
  }
  if (expiresAt !== undefined) {
    nextEntry.expires_at = expiresAt
  }

  if (auth.entryKey === null) {
    return nextEntry
  }

  return {
    ...raw,
    [auth.entryKey]: nextEntry
  }
}

export function isGrokAccessExpired(auth: Pick<GrokAuth, "accessToken" | "expiresAt">, skewMs: number, nowMs = Date.now()): boolean {
  if (auth.expiresAt !== null) {
    return auth.expiresAt * 1000 <= nowMs + skewMs
  }

  return isJwtExpired(auth.accessToken, skewMs, nowMs)
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

async function fetchGrokUsage(
  auth: GrokAuth,
  filePath: string,
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
  let current = auth
  let refreshed = false

  if (isGrokAccessExpired(current, TOKEN_EXPIRY_SKEW_MS) && current.refreshToken !== null) {
    current = await refreshGrokOauth(current, filePath, timeoutMs)
    refreshed = true
  }

  try {
    return await fetchGrokRemote(current.accessToken, timeoutMs)
  } catch (error) {
    if (refreshed || current.refreshToken === null || !isGrokSessionExpiredError(error)) {
      throw error
    }

    const next = await refreshGrokOauth(current, filePath, timeoutMs)
    return fetchGrokRemote(next.accessToken, timeoutMs)
  }
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

async function refreshGrokOauth(auth: GrokAuth, filePath: string, timeoutMs: number): Promise<GrokAuth> {
  if (auth.refreshToken === null) {
    throw new Error("Grok session expired; run grok login")
  }

  const clientId = auth.clientId !== null ? auth.clientId : OIDC_CLIENT_ID
  const issuer = auth.issuer !== null ? auth.issuer.replace(/\/+$/, "") : OIDC_ISSUER
  const response = await requestJson({
    method: "POST",
    url: issuer + "/oauth2/token",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: encodeForm({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: auth.refreshToken
    }),
    timeoutMs: timeoutMs
  })

  if (response.status === 400 || response.status === 401) {
    const latest = await rereadGrokAuth(filePath)
    if (latest !== null && latest.accessToken !== auth.accessToken) {
      return latest
    }

    throw new Error("Grok session expired; run grok login")
  }

  if (response.status < 200 || response.status >= 300 || !isRecord(response.json)) {
    throw new Error("Unable to refresh Grok session")
  }

  const accessToken = firstString(response.json, ["access_token", "accessToken"])
  if (accessToken === null) {
    throw new Error("Unable to refresh Grok session")
  }

  const refreshToken = firstString(response.json, ["refresh_token", "refreshToken"])
  const expiresIn = readNumber(response.json.expires_in)
  const next: GrokAuth = {
    ...auth,
    accessToken: accessToken,
    refreshToken: refreshToken !== null ? refreshToken : auth.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (expiresIn !== null ? expiresIn : 3600)
  }

  await persistGrokAuth(filePath, next, auth)
  return next
}

async function persistGrokAuth(filePath: string, auth: GrokAuth, expected: GrokAuth): Promise<void> {
  try {
    const latestRaw = JSON.parse(await readFile(filePath, "utf8")) as unknown
    const latest = readGrokAuthFile(latestRaw)
    if (latest !== null && latest.accessToken !== expected.accessToken && latest.accessToken !== auth.accessToken) {
      return
    }

    if (!isRecord(latestRaw)) {
      return
    }

    await writeJsonAtomic(filePath, mergeGrokAuth(latestRaw, auth))
  } catch (error) {
    if (toErrorMessage(error).indexOf("Grok session expired") >= 0) {
      throw error
    }
  }
}

async function rereadGrokAuth(filePath: string): Promise<GrokAuth | null> {
  try {
    return readGrokAuthFile(JSON.parse(await readFile(filePath, "utf8")) as unknown)
  } catch {
    return null
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = filePath + ".tmp-" + String(process.pid)
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600
    })
    await rename(tempPath, filePath)
  } catch (error) {
    try {
      await unlink(tempPath)
    } catch {
      // The temp file may never have been created.
    }
    throw error
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

function isGrokSessionExpiredError(error: unknown): boolean {
  return toErrorMessage(error).indexOf("Grok session expired") >= 0
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
    const body = options.body !== undefined ? Buffer.from(options.body, "utf8") : null
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

    if (body !== null) {
      headers["Content-Length"] = body.length
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

    if (body !== null) {
      req.write(body)
    }

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

function firstString(value: Record<string, unknown>, keys: string[]): string | null {
  for (let index = 0; index < keys.length; index += 1) {
    const item = value[keys[index]]
    if (typeof item === "string" && item.trim().length > 0) {
      return item.trim()
    }
  }

  return null
}

function encodeForm(fields: Record<string, string>): string {
  const keys = Object.keys(fields)
  const parts: string[] = []
  for (let index = 0; index < keys.length; index += 1) {
    parts.push(encodeURIComponent(keys[index]) + "=" + encodeURIComponent(fields[keys[index]]))
  }

  return parts.join("&")
}

function clientIdFromEntryKey(entryKey: string | null): string | null {
  if (entryKey === null) {
    return null
  }

  const marker = "::"
  const index = entryKey.lastIndexOf(marker)
  if (index < 0) {
    return null
  }

  const clientId = entryKey.slice(index + marker.length).trim()
  return clientId.length > 0 ? clientId : null
}

function isJwtExpired(token: string, skewMs: number, nowMs = Date.now()): boolean {
  const parts = token.split(".")
  if (parts.length < 2) {
    return false
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized + "===".slice((normalized.length + 3) % 4)
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown
    if (!isRecord(payload)) {
      return false
    }

    const expiresAt = readNumber(payload.exp)
    if (expiresAt === null) {
      return false
    }

    return expiresAt * 1000 <= nowMs + skewMs
  } catch {
    return false
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
