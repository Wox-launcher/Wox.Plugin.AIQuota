import { request as httpsRequest } from "https"
import { access } from "fs/promises"
import { URL } from "url"

import { Context, PublicAPI } from "@wox-launcher/wox-plugin"

import { getPlatformRuntime } from "./platform"
import { RuntimeSettings } from "./platform/types"
import { runSqliteQuery } from "./sqlite"

const DEFAULT_CACHE_TTL_SECONDS = 15
const DEFAULT_REQUEST_TIMEOUT_MS = 8000
const OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB"
const API_ORIGIN = "https://api2.cursor.sh"
const platformRuntime = getPlatformRuntime()

const AUTH_KEYS = ["cursorAuth/accessToken", "cursorAuth/refreshToken", "cursorAuth/cachedEmail", "cursorAuth/stripeMembershipType"]

export type CursorAvailability = "pending" | "unavailable" | "ready" | "error"

export interface CursorPlanUsage {
  usedCents: number
  remainingCents: number | null
  limitCents: number | null
  includedSpendCents: number | null
  bonusSpendCents: number | null
  totalPercentUsed: number | null
  autoPercentUsed: number | null
  apiPercentUsed: number | null
}

export interface CursorSpendLimitUsage {
  usedCents: number | null
  remainingCents: number | null
  limitCents: number | null
  limitType: string | null
}

export interface CursorRequestUsage {
  used: number
  max: number
  percentUsed: number
}

export interface CursorSandUsage {
  usagePercent: number
  periodStart: number | null
  resetAt: number | null
}

export interface CursorUsageSnapshot {
  fetchedAt: number
  availability: CursorAvailability
  source: "dashboard" | "legacy" | "local-fallback"
  planName: string | null
  planPrice: string | null
  membershipType: string | null
  email: string | null
  billingCycleStart: number | null
  billingCycleEnd: number | null
  planUsage: CursorPlanUsage | null
  spendLimit: CursorSpendLimitUsage | null
  requestUsage: CursorRequestUsage | null
  sandUsage: CursorSandUsage | null
  displayMessage: string | null
  warnings: string[]
}

interface PluginSettings {
  cacheTtlSeconds: number
}

interface CacheEntry {
  snapshot: CursorUsageSnapshot
}

interface UsageQueryOptions {
  forceRefresh?: boolean
}

interface CursorAuth {
  accessToken: string | null
  refreshToken: string | null
  email: string | null
  membershipType: string | null
}

interface JsonRequestOptions {
  method: "GET" | "POST"
  url: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs: number
}

interface JsonResponse {
  status: number
  json: unknown
}

export interface CursorUsageProvider {
  start(ctx: Context, api: PublicAPI): Promise<void>
  getSnapshot(ctx: Context, api: PublicAPI, options?: UsageQueryOptions): Promise<CursorUsageSnapshot>
  refresh(ctx: Context, api: PublicAPI): Promise<CursorUsageSnapshot>
  invalidate(): void
}

export class CachedCursorUsageProvider implements CursorUsageProvider {
  private cache: CacheEntry | null = null
  private inflight: Promise<CursorUsageSnapshot> | null = null
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

  async getSnapshot(ctx: Context, api: PublicAPI, options?: UsageQueryOptions): Promise<CursorUsageSnapshot> {
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

    return createEmptyCursorSnapshot()
  }

  async refresh(ctx: Context, api: PublicAPI): Promise<CursorUsageSnapshot> {
    await this.start(ctx, api)
    return this.performRefresh(ctx, api)
  }

  private async loadSnapshot(ctx: Context, api: PublicAPI): Promise<CursorUsageSnapshot> {
    const runtimeSettings = getRuntimeSettings()

    try {
      await access(runtimeSettings.cursorStateDbPath)
    } catch {
      return createUnavailableSnapshot(["cursor-not-found"])
    }

    let auth: CursorAuth
    try {
      auth = await readCursorAuth(runtimeSettings)
    } catch (error) {
      const message = toErrorMessage(error)
      await log(api, ctx, "Warning", "Failed to read local Cursor auth: " + message)
      return createUnavailableSnapshot(["auth: " + message])
    }

    if (auth.accessToken === null && auth.refreshToken === null) {
      return createUnavailableSnapshot(["not-signed-in"])
    }

    try {
      const token = await resolveAccessToken(auth, runtimeSettings)
      const remote = await fetchCursorRemote(token, runtimeSettings)
      return {
        fetchedAt: Date.now(),
        availability: "ready",
        source: remote.requestUsage !== null && remote.planUsage === null ? "legacy" : "dashboard",
        planName: remote.planName !== null ? remote.planName : formatMembershipType(auth.membershipType),
        planPrice: remote.planPrice,
        membershipType: auth.membershipType,
        email: auth.email,
        billingCycleStart: remote.billingCycleStart,
        billingCycleEnd: remote.billingCycleEnd,
        planUsage: remote.planUsage,
        spendLimit: remote.spendLimit,
        requestUsage: remote.requestUsage,
        sandUsage: remote.sandUsage,
        displayMessage: remote.displayMessage,
        warnings: remote.warnings
      }
    } catch (error) {
      const message = toErrorMessage(error)
      await log(api, ctx, "Warning", "Failed to read Cursor usage: " + message)
      return {
        fetchedAt: Date.now(),
        availability: "error",
        source: "local-fallback",
        planName: formatMembershipType(auth.membershipType),
        planPrice: null,
        membershipType: auth.membershipType,
        email: auth.email,
        billingCycleStart: null,
        billingCycleEnd: null,
        planUsage: null,
        spendLimit: null,
        requestUsage: null,
        sandUsage: null,
        displayMessage: null,
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
      await log(api, ctx, "Warning", "Background Cursor usage refresh failed: " + toErrorMessage(error))
    })
  }

  private async performRefresh(ctx: Context, api: PublicAPI): Promise<CursorUsageSnapshot> {
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

export function createEmptyCursorSnapshot(): CursorUsageSnapshot {
  return {
    fetchedAt: Date.now(),
    availability: "pending",
    source: "local-fallback",
    planName: null,
    planPrice: null,
    membershipType: null,
    email: null,
    billingCycleStart: null,
    billingCycleEnd: null,
    planUsage: null,
    spendLimit: null,
    requestUsage: null,
    sandUsage: null,
    displayMessage: null,
    warnings: []
  }
}

function createUnavailableSnapshot(warnings: string[]): CursorUsageSnapshot {
  return {
    ...createEmptyCursorSnapshot(),
    availability: "unavailable",
    warnings: warnings
  }
}

export function shouldShowCursorResult(snapshot: CursorUsageSnapshot, filter: "all" | "codex" | "cursor" | "grok"): boolean {
  if (filter === "cursor") {
    return true
  }

  return snapshot.availability === "ready" || snapshot.availability === "error"
}

async function readCursorAuth(settings: RuntimeSettings): Promise<CursorAuth> {
  const quotedKeys = AUTH_KEYS.map(key => "'" + key.replace(/'/g, "''") + "'").join(",")
  const query = "SELECT key, value FROM ItemTable WHERE key IN (" + quotedKeys + ");"
  const result = await runSqliteQuery(settings.sqliteExecutable, [settings.cursorStateDbPath, query], settings.requestTimeoutMs)
  const values: Record<string, string> = {}

  const lines = nonEmptyLines(result.stdout)
  for (let index = 0; index < lines.length; index += 1) {
    const separator = lines[index].indexOf("|")
    if (separator < 0) {
      continue
    }

    const key = lines[index].slice(0, separator)
    const value = lines[index].slice(separator + 1).trim()
    if (value.length > 0) {
      values[key] = value
    }
  }

  return {
    accessToken: values["cursorAuth/accessToken"] || null,
    refreshToken: values["cursorAuth/refreshToken"] || null,
    email: values["cursorAuth/cachedEmail"] || null,
    membershipType: values["cursorAuth/stripeMembershipType"] || null
  }
}

async function resolveAccessToken(auth: CursorAuth, settings: RuntimeSettings): Promise<string> {
  if (auth.accessToken !== null && !isJwtExpired(auth.accessToken, 60000)) {
    return auth.accessToken
  }

  if (auth.refreshToken === null) {
    if (auth.accessToken !== null) {
      return auth.accessToken
    }

    throw new Error("Cursor is not signed in on this machine")
  }

  return refreshAccessToken(auth.refreshToken, settings.requestTimeoutMs)
}

export function isJwtExpired(token: string, skewMs: number): boolean {
  const payload = decodeJwtPayload(token)
  const expiresAt = readNumber(payload.exp)
  if (expiresAt === null) {
    return false
  }

  return expiresAt * 1000 <= Date.now() + skewMs
}

async function refreshAccessToken(refreshToken: string, timeoutMs: number): Promise<string> {
  const response = await requestJson({
    method: "POST",
    url: API_ORIGIN + "/oauth/token",
    headers: {
      "Content-Type": "application/json"
    },
    body: {
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken
    },
    timeoutMs: timeoutMs
  })

  if (response.status < 200 || response.status >= 300 || !isRecord(response.json)) {
    throw new Error("Unable to refresh Cursor session")
  }

  if (response.json.shouldLogout === true) {
    throw new Error("Cursor session expired; sign in again in Cursor")
  }

  const accessToken = typeof response.json.access_token === "string" ? response.json.access_token.trim() : ""
  if (accessToken.length === 0) {
    throw new Error("Unable to refresh Cursor session")
  }

  return accessToken
}

interface RemoteUsage {
  planName: string | null
  planPrice: string | null
  billingCycleStart: number | null
  billingCycleEnd: number | null
  planUsage: CursorPlanUsage | null
  spendLimit: CursorSpendLimitUsage | null
  requestUsage: CursorRequestUsage | null
  sandUsage: CursorSandUsage | null
  displayMessage: string | null
  warnings: string[]
}

async function fetchCursorRemote(token: string, settings: RuntimeSettings): Promise<RemoteUsage> {
  const warnings: string[] = []
  const results = await Promise.all([
    postDashboard("GetCurrentPeriodUsage", token, settings.requestTimeoutMs),
    postDashboard("GetPlanInfo", token, settings.requestTimeoutMs).catch(() => null),
    fetchSandUsage(token, settings.requestTimeoutMs).catch(() => null)
  ])
  const period = results[0]
  const plan = results[1]
  const sandUsage = results[2]

  const planInfo = readPlanInfo(plan)
  const periodUsage = readPeriodUsage(period)
  if (periodUsage.planUsage !== null || periodUsage.spendLimit !== null) {
    return {
      planName: planInfo.planName,
      planPrice: planInfo.planPrice,
      billingCycleStart: periodUsage.billingCycleStart,
      billingCycleEnd: periodUsage.billingCycleEnd !== null ? periodUsage.billingCycleEnd : planInfo.billingCycleEnd,
      planUsage: fillLimitFromPlan(periodUsage.planUsage, planInfo.includedAmountCents),
      spendLimit: periodUsage.spendLimit,
      requestUsage: null,
      sandUsage: sandUsage,
      displayMessage: periodUsage.displayMessage,
      warnings: warnings
    }
  }

  try {
    const legacy = await getAuthUsage(token, settings.requestTimeoutMs)
    const requestUsage = readLegacyRequestUsage(legacy)
    if (requestUsage !== null) {
      return {
        planName: planInfo.planName,
        planPrice: planInfo.planPrice,
        billingCycleStart: readLegacyCycleStart(legacy),
        billingCycleEnd: planInfo.billingCycleEnd,
        planUsage: null,
        spendLimit: null,
        requestUsage: requestUsage,
        sandUsage: sandUsage,
        displayMessage: null,
        warnings: warnings
      }
    }
  } catch (error) {
    warnings.push("legacy: " + toErrorMessage(error))
  }

  if (planInfo.planName !== null || planInfo.includedAmountCents !== null) {
    return {
      planName: planInfo.planName,
      planPrice: planInfo.planPrice,
      billingCycleStart: periodUsage.billingCycleStart,
      billingCycleEnd: periodUsage.billingCycleEnd !== null ? periodUsage.billingCycleEnd : planInfo.billingCycleEnd,
      planUsage: fillLimitFromPlan(periodUsage.planUsage, planInfo.includedAmountCents),
      spendLimit: periodUsage.spendLimit,
      requestUsage: null,
      sandUsage: sandUsage,
      displayMessage: periodUsage.displayMessage,
      warnings: warnings
    }
  }

  throw new Error("Cursor usage API returned no plan data")
}

async function fetchSandUsage(token: string, timeoutMs: number): Promise<CursorSandUsage | null> {
  try {
    const rpc = readSandUsage(await postDashboard("GetSandUsageStatus", token, timeoutMs))
    if (rpc !== null) {
      return rpc
    }
  } catch {
    // Fall through to the dashboard REST path used by Cursor's spending page.
  }

  const response = await requestJson({
    method: "POST",
    url: "https://cursor.com/api/dashboard/get-sand-usage-status",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://cursor.com"
    },
    body: {},
    timeoutMs: Math.min(timeoutMs, 5000)
  })

  return readSandUsage(readApiJson(response, "get-sand-usage-status"))
}

async function postDashboard(method: string, token: string, timeoutMs: number): Promise<unknown> {
  const response = await requestJson({
    method: "POST",
    url: API_ORIGIN + "/aiserver.v1.DashboardService/" + method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1"
    },
    body: {},
    timeoutMs: timeoutMs
  })

  return readApiJson(response, method)
}

async function getAuthUsage(token: string, timeoutMs: number): Promise<unknown> {
  const response = await requestJson({
    method: "GET",
    url: API_ORIGIN + "/auth/usage",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json"
    },
    timeoutMs: timeoutMs
  })

  return readApiJson(response, "auth/usage")
}

function readApiJson(response: JsonResponse, label: string): unknown {
  if (response.status === 401 || response.status === 403) {
    throw new Error("Cursor session expired; sign in again in Cursor")
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error("Cursor " + label + " failed with HTTP " + String(response.status))
  }

  if (isRecord(response.json) && typeof response.json.code === "string" && typeof response.json.message === "string") {
    throw new Error("Cursor " + label + " failed: " + response.json.message)
  }

  return response.json
}

export function readPeriodUsage(value: unknown): {
  billingCycleStart: number | null
  billingCycleEnd: number | null
  planUsage: CursorPlanUsage | null
  spendLimit: CursorSpendLimitUsage | null
  displayMessage: string | null
} {
  if (!isRecord(value)) {
    return {
      billingCycleStart: null,
      billingCycleEnd: null,
      planUsage: null,
      spendLimit: null,
      displayMessage: null
    }
  }

  return {
    billingCycleStart: readEpochSeconds(value.billingCycleStart),
    billingCycleEnd: readEpochSeconds(value.billingCycleEnd),
    planUsage: readPlanUsage(value.planUsage),
    spendLimit: readSpendLimit(value.spendLimitUsage),
    displayMessage: typeof value.displayMessage === "string" ? value.displayMessage : null
  }
}

export function readPlanUsage(value: unknown): CursorPlanUsage | null {
  if (!isRecord(value)) {
    return null
  }

  const limitCents = readNumber(value.limit)
  const remainingCents = readNumber(value.remaining)
  const includedSpendCents = readNumber(value.includedSpend)
  const bonusSpendCents = readNumber(value.bonusSpend)
  const explicitUsed = readNumber(value.used)
  const totalSpend = readNumber(value.totalSpend)
  const totalPercentUsed = readNumber(value.totalPercentUsed)
  const autoPercentUsed = readNumber(value.autoPercentUsed)
  const apiPercentUsed = readNumber(value.apiPercentUsed)

  let usedCents = 0
  if (explicitUsed !== null) {
    usedCents = explicitUsed
  } else if (includedSpendCents !== null) {
    usedCents = includedSpendCents
  } else if (limitCents !== null && remainingCents !== null) {
    usedCents = Math.max(0, limitCents - remainingCents)
  } else if (totalSpend !== null) {
    usedCents = totalSpend
  } else if (limitCents !== null && limitCents > 0 && totalPercentUsed !== null) {
    usedCents = Math.round((limitCents * totalPercentUsed) / 100)
  } else if (
    limitCents === null &&
    remainingCents === null &&
    includedSpendCents === null &&
    bonusSpendCents === null &&
    totalPercentUsed === null &&
    autoPercentUsed === null &&
    apiPercentUsed === null
  ) {
    return null
  }

  let derivedRemaining = remainingCents
  if (derivedRemaining === null && limitCents !== null) {
    derivedRemaining = Math.max(0, limitCents - usedCents)
  }

  return {
    usedCents: usedCents,
    remainingCents: derivedRemaining,
    limitCents: limitCents,
    includedSpendCents: includedSpendCents,
    bonusSpendCents: bonusSpendCents,
    totalPercentUsed: totalPercentUsed,
    autoPercentUsed: autoPercentUsed,
    apiPercentUsed: apiPercentUsed
  }
}

export function readSpendLimit(value: unknown): CursorSpendLimitUsage | null {
  if (!isRecord(value)) {
    return null
  }

  const individualLimit = readNumber(value.individualLimit)
  const individualRemaining = readNumber(value.individualRemaining)
  const individualUsed = readNumber(value.individualUsed)
  const pooledLimit = readNumber(value.pooledLimit)
  const pooledRemaining = readNumber(value.pooledRemaining)
  const pooledUsed = readNumber(value.pooledUsed)
  const totalSpend = readNumber(value.totalSpend)

  const limitCents = individualLimit !== null ? individualLimit : pooledLimit
  const remainingCents = individualRemaining !== null ? individualRemaining : pooledRemaining
  const usedCents = individualUsed !== null ? individualUsed : pooledUsed !== null ? pooledUsed : totalSpend

  if (limitCents === null && remainingCents === null && usedCents === null) {
    return null
  }

  return {
    usedCents: usedCents,
    remainingCents: remainingCents,
    limitCents: limitCents,
    limitType: typeof value.limitType === "string" ? value.limitType : null
  }
}

export function readPlanInfo(value: unknown): { planName: string | null; planPrice: string | null; includedAmountCents: number | null; billingCycleEnd: number | null } {
  if (!isRecord(value) || !isRecord(value.planInfo)) {
    return {
      planName: null,
      planPrice: null,
      includedAmountCents: null,
      billingCycleEnd: null
    }
  }

  const planInfo = value.planInfo
  return {
    planName: typeof planInfo.planName === "string" && planInfo.planName.length > 0 ? planInfo.planName : null,
    planPrice: typeof planInfo.price === "string" && planInfo.price.length > 0 ? planInfo.price : null,
    includedAmountCents: readNumber(planInfo.includedAmountCents),
    billingCycleEnd: readEpochSeconds(planInfo.billingCycleEnd)
  }
}

export function readSandUsage(value: unknown): CursorSandUsage | null {
  if (!isRecord(value)) {
    return null
  }

  const payload = isRecord(value.status) ? value.status : isRecord(value.sandUsage) ? value.sandUsage : value
  if (!isRecord(payload)) {
    return null
  }

  if (payload.hasNonZeroIncludedLimit === false || payload.has_non_zero_included_limit === false) {
    return null
  }

  const usagePercent = firstNumber(payload, ["usagePercent", "usage_percent", "usedPercent", "used_percent"])
  if (usagePercent === null) {
    return null
  }

  return {
    usagePercent: clamp(usagePercent, 0, 100),
    periodStart: firstTimestamp(payload, ["currentPeriodStart", "current_period_start"]),
    resetAt: firstTimestamp(payload, ["nextResetTimestampUtc", "next_reset_timestamp_utc", "resetAt", "reset_at"])
  }
}

export function shouldShowGrokBotResult(snapshot: CursorUsageSnapshot | null, filter: "all" | "codex" | "cursor" | "grok"): boolean {
  if (snapshot === null || snapshot.sandUsage === null) {
    return false
  }

  return filter === "all" || filter === "grok"
}

export function getGrokBotRemainingPercent(sandUsage: CursorSandUsage | null): number | null {
  if (sandUsage === null) {
    return null
  }

  return clamp(Math.round(100 - sandUsage.usagePercent), 0, 100)
}

export function readLegacyRequestUsage(value: unknown): CursorRequestUsage | null {
  if (!isRecord(value) || !isRecord(value["gpt-4"])) {
    return null
  }

  const bucket = value["gpt-4"]
  const used = readNumber(bucket.numRequests)
  const max = readNumber(bucket.maxRequestUsage)
  if (used === null || max === null || max <= 0) {
    return null
  }

  return {
    used: used,
    max: max,
    percentUsed: Math.min(100, (used / max) * 100)
  }
}

function readLegacyCycleStart(value: unknown): number | null {
  if (!isRecord(value) || typeof value.startOfMonth !== "string") {
    return null
  }

  const parsed = Date.parse(value.startOfMonth)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return Math.floor(parsed / 1000)
}

function fillLimitFromPlan(planUsage: CursorPlanUsage | null, includedAmountCents: number | null): CursorPlanUsage | null {
  if (planUsage === null) {
    if (includedAmountCents === null) {
      return null
    }

    return {
      usedCents: 0,
      remainingCents: includedAmountCents,
      limitCents: includedAmountCents,
      includedSpendCents: 0,
      bonusSpendCents: 0,
      totalPercentUsed: 0,
      autoPercentUsed: null,
      apiPercentUsed: null
    }
  }

  if (planUsage.limitCents !== null || includedAmountCents === null) {
    return planUsage
  }

  const remainingCents = planUsage.remainingCents !== null ? planUsage.remainingCents : Math.max(0, includedAmountCents - planUsage.usedCents)
  return {
    ...planUsage,
    limitCents: includedAmountCents,
    remainingCents: remainingCents
  }
}

export function formatMembershipType(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return null
  }

  const normalized = value.toLowerCase()
  if (normalized === "pro_plus" || normalized === "pro+") {
    return "Pro+"
  }

  if (normalized === "pro") {
    return "Pro"
  }

  if (normalized === "ultra") {
    return "Ultra"
  }

  if (normalized === "free") {
    return "Free"
  }

  if (normalized === "team" || normalized === "business" || normalized === "enterprise") {
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
  }

  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function formatUsdFromCents(cents: number): string {
  const dollars = cents / 100
  const sign = dollars < 0 ? "-" : ""
  return sign + "$" + Math.abs(dollars).toFixed(2)
}

export function getPlanRemainingPercent(planUsage: CursorPlanUsage | null): number | null {
  if (planUsage === null) {
    return null
  }

  if (planUsage.limitCents !== null && planUsage.limitCents > 0 && planUsage.remainingCents !== null) {
    return clamp(Math.round((planUsage.remainingCents / planUsage.limitCents) * 100), 0, 100)
  }

  if (planUsage.apiPercentUsed !== null) {
    return clamp(Math.round(100 - planUsage.apiPercentUsed), 0, 100)
  }

  if (planUsage.totalPercentUsed !== null) {
    return clamp(Math.round(100 - planUsage.totalPercentUsed), 0, 100)
  }

  return null
}

export function getCursorModelRemainingPercent(planUsage: CursorPlanUsage | null): number | null {
  if (planUsage === null || planUsage.autoPercentUsed === null) {
    return null
  }

  return clamp(Math.round(100 - planUsage.autoPercentUsed), 0, 100)
}

export function getOtherModelRemainingPercent(planUsage: CursorPlanUsage | null): number | null {
  if (planUsage === null || planUsage.apiPercentUsed === null) {
    return null
  }

  return clamp(Math.round(100 - planUsage.apiPercentUsed), 0, 100)
}

export function getAutoRemainingPercent(planUsage: CursorPlanUsage | null): number | null {
  return getCursorModelRemainingPercent(planUsage)
}

export function getOnDemandRemainingPercent(spendLimit: CursorSpendLimitUsage | null): number | null {
  if (spendLimit === null) {
    return null
  }

  if (spendLimit.limitCents !== null && spendLimit.limitCents > 0 && spendLimit.remainingCents !== null) {
    return clamp(Math.round((spendLimit.remainingCents / spendLimit.limitCents) * 100), 0, 100)
  }

  if (spendLimit.limitCents !== null && spendLimit.limitCents > 0 && spendLimit.usedCents !== null) {
    return clamp(Math.round(100 - (spendLimit.usedCents / spendLimit.limitCents) * 100), 0, 100)
  }

  return null
}

export function getRequestRemainingPercent(requestUsage: CursorRequestUsage | null): number | null {
  if (requestUsage === null || requestUsage.max <= 0) {
    return null
  }

  return clamp(Math.round(100 - requestUsage.percentUsed), 0, 100)
}

async function requestJson(options: JsonRequestOptions): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url)
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8")
    const headers: Record<string, string | number> = {
      Accept: "application/json",
      "User-Agent": "wox-plugin-ai-quota/0.3.0"
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
            reject(new Error("Cursor API returned a non-JSON response"))
          }
        })
      }
    )

    req.on("error", error => {
      reject(ensureRequestError(error))
    })

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error("Timed out while waiting for Cursor API"))
    })

    if (body !== null) {
      req.write(body)
    }

    req.end()
  })
}

function ensureRequestError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".")
  if (parts.length < 2) {
    return {}
  }

  try {
    const segment = parts[1]
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized + "===".slice((normalized.length + 3) % 4)
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number | null {
  for (let index = 0; index < keys.length; index += 1) {
    const parsed = readNumber(value[keys[index]])
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

function firstTimestamp(value: Record<string, unknown>, keys: string[]): number | null {
  for (let index = 0; index < keys.length; index += 1) {
    const parsed = readTimestamp(value[keys[index]])
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

function readTimestamp(value: unknown): number | null {
  if (typeof value === "string" && value.trim().length > 0 && value.indexOf("-") >= 0) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000)
    }
  }

  return readEpochSeconds(value)
}

function readEpochSeconds(value: unknown): number | null {
  const numeric = readNumber(value)
  if (numeric === null) {
    return null
  }

  if (numeric > 100000000000) {
    return Math.floor(numeric / 1000)
  }

  return Math.floor(numeric)
}

export function readNumber(value: unknown): number | null {
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

function nonEmptyLines(output: string): string[] {
  const lines = output.split(/\r?\n/)
  const result: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed.length > 0) {
      result.push(trimmed)
    }
  }

  return result
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
