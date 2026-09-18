import { request as httpsRequest } from "https"
import { access, readFile, rename, unlink, writeFile } from "fs/promises"
import { userInfo } from "os"
import { join } from "path"
import { URL } from "url"

import { Context, PublicAPI } from "@wox-launcher/wox-plugin"

import { getPlatformRuntime } from "./platform"
import { RuntimeSettings } from "./platform/types"
import { runExecFile } from "./sqlite"

const DEFAULT_CACHE_TTL_SECONDS = 15
const DEFAULT_REQUEST_TIMEOUT_MS = 8000
const KEYCHAIN_TIMEOUT_MS = 15000
const TOKEN_EXPIRY_SKEW_MS = 60000
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const TOKEN_URL_PRIMARY = "https://platform.claude.com/v1/oauth/token"
const TOKEN_URL_LEGACY = "https://console.anthropic.com/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const OAUTH_BETA = "oauth-2025-04-20"
const ANTHROPIC_VERSION = "2023-06-01"
const KEYCHAIN_SERVICE = "Claude Code-credentials"
const USER_AGENT = "claude-cli/2.1.201 (external, cli)"
const platformRuntime = getPlatformRuntime()

export type ClaudeAvailability = "pending" | "unavailable" | "ready" | "error"
export type ClaudeWindowKind = "session" | "weekly" | "scoped"

export interface ClaudeUsageWindow {
  kind: ClaudeWindowKind
  label: string
  usedPercent: number
  resetsAt: number | null
}

export interface ClaudeExtraUsage {
  enabled: boolean
  usedCents: number | null
  limitCents: number | null
  utilization: number | null
}

export interface ClaudeUsageSnapshot {
  fetchedAt: number
  availability: ClaudeAvailability
  source: "oauth" | "local-fallback"
  planName: string | null
  windows: ClaudeUsageWindow[]
  extraUsage: ClaudeExtraUsage | null
  warnings: string[]
}

export interface ClaudeOauth {
  accessToken: string | null
  refreshToken: string | null
  expiresAt: number | null
  subscriptionType: string | null
  rateLimitTier: string | null
  scopes: string[]
}

interface PluginSettings {
  cacheTtlSeconds: number
}

interface CacheEntry {
  snapshot: ClaudeUsageSnapshot
}

interface UsageQueryOptions {
  forceRefresh?: boolean
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

interface ClaudeCredentialStore {
  oauth: ClaudeOauth
  source: "file" | "keychain" | "env"
  filePath: string | null
  raw: Record<string, unknown> | null
}

export interface ClaudeUsageProvider {
  start(ctx: Context, api: PublicAPI): Promise<void>
  getSnapshot(ctx: Context, api: PublicAPI, options?: UsageQueryOptions): Promise<ClaudeUsageSnapshot>
  refresh(ctx: Context, api: PublicAPI): Promise<ClaudeUsageSnapshot>
  invalidate(): void
}

export class CachedClaudeUsageProvider implements ClaudeUsageProvider {
  private cache: CacheEntry | null = null
  private inflight: Promise<ClaudeUsageSnapshot> | null = null
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

  async getSnapshot(ctx: Context, api: PublicAPI, options?: UsageQueryOptions): Promise<ClaudeUsageSnapshot> {
    await this.start(ctx, api)

    if (options?.forceRefresh) {
      return this.refresh(ctx, api)
    }

    if (this.cache !== null) {
      return this.cache.snapshot
    }

    return this.refresh(ctx, api)
  }

  async refresh(ctx: Context, api: PublicAPI): Promise<ClaudeUsageSnapshot> {
    await this.start(ctx, api)
    return this.performRefresh(ctx, api)
  }

  private async loadSnapshot(ctx: Context, api: PublicAPI): Promise<ClaudeUsageSnapshot> {
    const runtimeSettings = getRuntimeSettings()

    let store: ClaudeCredentialStore | null
    try {
      store = await loadClaudeCredentials(runtimeSettings)
    } catch (error) {
      const message = toErrorMessage(error)
      await log(api, ctx, "Warning", "Failed to read local Claude credentials: " + message)
      return createUnavailableClaudeSnapshot(["auth: " + message])
    }

    if (store === null) {
      return createUnavailableClaudeSnapshot(await missingClaudeWarnings(runtimeSettings))
    }

    try {
      const resolved = await resolveClaudeRemote(store, runtimeSettings)
      return {
        fetchedAt: Date.now(),
        availability: "ready",
        source: "oauth",
        planName: formatClaudePlanName(resolved.store.oauth.rateLimitTier, resolved.store.oauth.subscriptionType),
        windows: resolved.windows,
        extraUsage: resolved.extraUsage,
        warnings: resolved.warnings
      }
    } catch (error) {
      const message = toErrorMessage(error)
      await log(api, ctx, "Warning", "Failed to read Claude usage: " + message)
      return {
        ...createEmptyClaudeSnapshot(),
        availability: "error",
        planName: formatClaudePlanName(store.oauth.rateLimitTier, store.oauth.subscriptionType),
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
      await log(api, ctx, "Warning", "Background Claude usage refresh failed: " + toErrorMessage(error))
    })
  }

  private async performRefresh(ctx: Context, api: PublicAPI): Promise<ClaudeUsageSnapshot> {
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

export function createEmptyClaudeSnapshot(): ClaudeUsageSnapshot {
  return {
    fetchedAt: Date.now(),
    availability: "pending",
    source: "local-fallback",
    planName: null,
    windows: [],
    extraUsage: null,
    warnings: []
  }
}

function createUnavailableClaudeSnapshot(warnings: string[]): ClaudeUsageSnapshot {
  return {
    ...createEmptyClaudeSnapshot(),
    availability: "unavailable",
    warnings: warnings
  }
}

export function shouldShowClaudeResult(snapshot: ClaudeUsageSnapshot, filter: "all" | "codex" | "cursor" | "grok" | "claude"): boolean {
  if (snapshot.availability === "pending") {
    return false
  }

  if (filter === "claude") {
    return true
  }

  return snapshot.availability === "ready" || snapshot.availability === "error"
}

export function readClaudeOauth(value: unknown): ClaudeOauth | null {
  if (!isRecord(value)) {
    return null
  }

  const oauth = isRecord(value.claudeAiOauth) ? value.claudeAiOauth : value
  const accessToken = firstString(oauth, ["accessToken", "access_token"])
  const refreshToken = firstString(oauth, ["refreshToken", "refresh_token"])
  if (accessToken === null && refreshToken === null) {
    return null
  }

  return {
    accessToken: accessToken,
    refreshToken: refreshToken,
    expiresAt: readNumber(oauth.expiresAt !== undefined ? oauth.expiresAt : oauth.expires_at),
    subscriptionType: firstString(oauth, ["subscriptionType", "subscription_type"]),
    rateLimitTier: firstString(oauth, ["rateLimitTier", "rate_limit_tier"]),
    scopes: readScopes(oauth.scopes)
  }
}

export function mergeClaudeOauth(raw: Record<string, unknown>, oauth: ClaudeOauth): Record<string, unknown> {
  const current = isRecord(raw.claudeAiOauth) ? raw.claudeAiOauth : {}
  const next: Record<string, unknown> = {
    ...current
  }

  if (oauth.accessToken !== null) {
    next.accessToken = oauth.accessToken
  }

  if (oauth.refreshToken !== null && oauth.refreshToken.length > 0) {
    next.refreshToken = oauth.refreshToken
  }

  if (oauth.expiresAt !== null) {
    next.expiresAt = oauth.expiresAt
  }

  if (oauth.scopes.length > 0) {
    next.scopes = oauth.scopes
  }

  return {
    ...raw,
    claudeAiOauth: next
  }
}

export function formatClaudePlanName(rateLimitTier: string | null, subscriptionType: string | null): string | null {
  const raw = rateLimitTier !== null && rateLimitTier.length > 0 ? rateLimitTier : subscriptionType
  if (raw === null || raw.length === 0) {
    return "Claude"
  }

  let value = raw.trim().toLowerCase()
  if (value.indexOf("default_") === 0) {
    value = value.slice("default_".length)
  }
  if (value.indexOf("claude_") === 0) {
    value = value.slice("claude_".length)
  }

  const parts = value.split(/[_\s]+/)
  const titled: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part.length === 0) {
      continue
    }

    if (/^\d+x$/.test(part)) {
      titled.push(part)
      continue
    }

    titled.push(part.charAt(0).toUpperCase() + part.slice(1))
  }

  return titled.length > 0 ? titled.join(" ") : "Claude"
}

export function readClaudeUsage(value: unknown): {
  windows: ClaudeUsageWindow[]
  extraUsage: ClaudeExtraUsage | null
} {
  if (!isRecord(value)) {
    return {
      windows: [],
      extraUsage: null
    }
  }

  const fromLimits = readLimitsWindows(value.limits)
  const session = windowByKind(fromLimits, "session") !== null ? windowByKind(fromLimits, "session") : readLegacyWindow(value.five_hour, "session", "Session")
  const weekly = windowByKind(fromLimits, "weekly") !== null ? windowByKind(fromLimits, "weekly") : readLegacyWindow(value.seven_day, "weekly", "Week")
  const scoped = scopedWindows(fromLimits)
  if (scoped.length === 0) {
    const opus = readLegacyWindow(value.seven_day_opus, "scoped", "Opus")
    const sonnet = readLegacyWindow(value.seven_day_sonnet, "scoped", "Sonnet")
    if (opus !== null) {
      scoped.push(opus)
    }
    if (sonnet !== null) {
      scoped.push(sonnet)
    }
  }

  const windows: ClaudeUsageWindow[] = []
  if (session !== null) {
    windows.push(session)
  }
  if (weekly !== null) {
    windows.push(weekly)
  }
  for (let index = 0; index < scoped.length; index += 1) {
    windows.push(scoped[index])
  }

  return {
    windows: normalizeWindowPercents(windows),
    extraUsage: readExtraUsage(value)
  }
}

export function getClaudeRemainingPercent(usedPercent: number | null): number | null {
  if (usedPercent === null) {
    return null
  }

  return clamp(Math.round(100 - usedPercent), 0, 100)
}

export function shouldShowClaudeReset(window: Pick<ClaudeUsageWindow, "usedPercent" | "resetsAt">): boolean {
  return window.usedPercent > 0 && window.resetsAt !== null
}

export function getClaudeExtraRemainingPercent(extraUsage: ClaudeExtraUsage | null): number | null {
  if (extraUsage === null) {
    return null
  }

  if (extraUsage.utilization !== null) {
    return getClaudeRemainingPercent(extraUsage.utilization)
  }

  if (extraUsage.limitCents !== null && extraUsage.limitCents > 0 && extraUsage.usedCents !== null) {
    return clamp(Math.round(100 - (extraUsage.usedCents / extraUsage.limitCents) * 100), 0, 100)
  }

  return null
}

export function listClaudeDisplayWindows(windows: ClaudeUsageWindow[]): ClaudeUsageWindow[] {
  const result: ClaudeUsageWindow[] = []
  const session = windowByKind(windows, "session")
  const weekly = windowByKind(windows, "weekly")
  if (session !== null) {
    result.push(session)
  }
  if (weekly !== null) {
    result.push(weekly)
  }

  const scoped = scopedWindows(windows)
  scoped.sort((left, right) => right.usedPercent - left.usedPercent)
  for (let index = 0; index < scoped.length; index += 1) {
    result.push(scoped[index])
  }

  return result
}

export function formatUsdFromCents(cents: number): string {
  const dollars = cents / 100
  const sign = dollars < 0 ? "-" : ""
  return sign + "$" + Math.abs(dollars).toFixed(2)
}

async function loadClaudeCredentials(settings: RuntimeSettings): Promise<ClaudeCredentialStore | null> {
  const envToken = readEnvToken()
  if (envToken !== null) {
    return {
      oauth: {
        accessToken: envToken,
        refreshToken: null,
        expiresAt: null,
        subscriptionType: null,
        rateLimitTier: null,
        scopes: []
      },
      source: "env",
      filePath: null,
      raw: null
    }
  }

  if (process.platform === "darwin") {
    const keychain = await readMacosKeychainCredentials(Math.max(settings.requestTimeoutMs, KEYCHAIN_TIMEOUT_MS))
    if (keychain !== null) {
      return keychain
    }
  }

  return readClaudeCredentialsFile(join(settings.claudeHome, ".credentials.json"))
}

function readEnvToken(): string | null {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (typeof token === "string" && token.trim().length > 0) {
    return token.trim()
  }

  return null
}

async function readClaudeCredentialsFile(filePath: string): Promise<ClaudeCredentialStore | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown
    const oauth = readClaudeOauth(raw)
    if (oauth === null || !isRecord(raw)) {
      return null
    }

    return {
      oauth: oauth,
      source: "file",
      filePath: filePath,
      raw: raw
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return null
    }

    throw error
  }
}

async function readMacosKeychainCredentials(timeoutMs: number): Promise<ClaudeCredentialStore | null> {
  const username = keychainAccount()
  const attempts: string[][] = [
    ["find-generic-password", "-a", username, "-s", KEYCHAIN_SERVICE, "-w"],
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]
  ]

  for (let index = 0; index < attempts.length; index += 1) {
    try {
      const result = await runExecFile("security", attempts[index], timeoutMs)
      const raw = JSON.parse(result.stdout.trim()) as unknown
      const oauth = readClaudeOauth(raw)
      if (oauth !== null && isRecord(raw)) {
        return {
          oauth: oauth,
          source: "keychain",
          filePath: null,
          raw: raw
        }
      }
    } catch {
      continue
    }
  }

  return null
}

async function missingClaudeWarnings(settings: RuntimeSettings): Promise<string[]> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return ["not-signed-in"]
  }

  try {
    await access(settings.claudeHome)
    return ["not-signed-in"]
  } catch {
    if (process.platform === "darwin") {
      return ["not-signed-in"]
    }

    return ["claude-not-found"]
  }
}

async function resolveClaudeRemote(
  store: ClaudeCredentialStore,
  settings: RuntimeSettings
): Promise<{
  store: ClaudeCredentialStore
  windows: ClaudeUsageWindow[]
  extraUsage: ClaudeExtraUsage | null
  warnings: string[]
}> {
  const resolved = await resolveAccessToken(store, settings)

  try {
    const remote = await fetchClaudeUsage(resolved.token, settings.requestTimeoutMs)
    return {
      store: resolved.store,
      windows: remote.windows,
      extraUsage: remote.extraUsage,
      warnings: remote.warnings
    }
  } catch (error) {
    if (!canRetryClaudeAuth(error, resolved.store)) {
      throw error
    }

    const refreshed = await refreshClaudeOauth(resolved.store, settings)
    if (refreshed.oauth.accessToken === null) {
      throw error
    }

    const remote = await fetchClaudeUsage(refreshed.oauth.accessToken, settings.requestTimeoutMs)
    return {
      store: refreshed,
      windows: remote.windows,
      extraUsage: remote.extraUsage,
      warnings: remote.warnings
    }
  }
}

function canRetryClaudeAuth(error: unknown, store: ClaudeCredentialStore): boolean {
  if (store.source === "env" || store.oauth.refreshToken === null) {
    return false
  }

  return toErrorMessage(error).indexOf("session expired") >= 0
}

async function resolveAccessToken(store: ClaudeCredentialStore, settings: RuntimeSettings): Promise<{ token: string; store: ClaudeCredentialStore }> {
  if (store.oauth.accessToken !== null && !isOauthExpired(store.oauth.expiresAt, TOKEN_EXPIRY_SKEW_MS)) {
    return {
      token: store.oauth.accessToken,
      store: store
    }
  }

  if (store.source === "env") {
    if (store.oauth.accessToken === null) {
      throw new Error("Claude is not signed in on this machine")
    }

    return {
      token: store.oauth.accessToken,
      store: store
    }
  }

  if (store.oauth.refreshToken === null) {
    if (store.oauth.accessToken !== null) {
      return {
        token: store.oauth.accessToken,
        store: store
      }
    }

    throw new Error("Claude is not signed in on this machine")
  }

  const refreshed = await refreshClaudeOauth(store, settings)
  if (refreshed.oauth.accessToken === null) {
    throw new Error("Unable to refresh Claude session")
  }

  return {
    token: refreshed.oauth.accessToken,
    store: refreshed
  }
}

async function fetchClaudeUsage(
  token: string,
  timeoutMs: number
): Promise<{
  windows: ClaudeUsageWindow[]
  extraUsage: ClaudeExtraUsage | null
  warnings: string[]
}> {
  const response = await getUsage(token, timeoutMs)
  if (response.status === 401) {
    throw new Error("Claude session expired; run claude login")
  }

  const json = readApiJson(response, "usage")
  const usage = readClaudeUsage(json)
  if (usage.windows.length === 0 && (usage.extraUsage === null || !usage.extraUsage.enabled)) {
    throw new Error("Claude usage API returned no usage data")
  }

  return {
    windows: usage.windows,
    extraUsage: usage.extraUsage,
    warnings: []
  }
}

async function getUsage(token: string, timeoutMs: number): Promise<JsonResponse> {
  return requestJson({
    method: "GET",
    url: USAGE_URL,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "anthropic-beta": OAUTH_BETA,
      "anthropic-version": ANTHROPIC_VERSION,
      "x-app": "cli"
    },
    timeoutMs: timeoutMs
  })
}

async function refreshClaudeOauth(store: ClaudeCredentialStore, settings: RuntimeSettings): Promise<ClaudeCredentialStore> {
  if (store.oauth.refreshToken === null) {
    throw new Error("Claude session expired; run claude login")
  }

  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: store.oauth.refreshToken,
    client_id: OAUTH_CLIENT_ID
  }
  if (store.oauth.scopes.length > 0) {
    body.scope = store.oauth.scopes.join(" ")
  }

  const urls = [TOKEN_URL_PRIMARY, TOKEN_URL_LEGACY]
  let lastError: Error | null = null

  for (let index = 0; index < urls.length; index += 1) {
    try {
      const response = await requestJson({
        method: "POST",
        url: urls[index],
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: body,
        timeoutMs: settings.requestTimeoutMs
      })

      if ((response.status === 404 || response.status === 405) && index < urls.length - 1) {
        lastError = new Error("Claude token refresh failed with HTTP " + String(response.status))
        continue
      }

      if (response.status === 401 || response.status === 400) {
        const latest = await reloadClaudeStore(store, settings)
        if (latest !== null && !sameOauthIdentity(latest.oauth, store.oauth) && latest.oauth.accessToken !== null) {
          return latest
        }

        throw new Error("Claude session expired; run claude login")
      }

      if (response.status < 200 || response.status >= 300 || !isRecord(response.json)) {
        throw new Error("Claude token refresh failed with HTTP " + String(response.status))
      }

      const accessToken = firstString(response.json, ["access_token", "accessToken"])
      if (accessToken === null) {
        throw new Error("Unable to refresh Claude session")
      }

      const refreshToken = firstString(response.json, ["refresh_token", "refreshToken"])
      const expiresIn = readNumber(response.json.expires_in)
      const refreshed: ClaudeOauth = {
        ...store.oauth,
        accessToken: accessToken,
        refreshToken: refreshToken !== null ? refreshToken : store.oauth.refreshToken,
        expiresAt: Date.now() + (expiresIn !== null ? expiresIn : 3600) * 1000,
        scopes: typeof response.json.scope === "string" ? response.json.scope.split(/\s+/).filter(item => item.length > 0) : store.oauth.scopes
      }

      const nextStore: ClaudeCredentialStore = {
        ...store,
        oauth: refreshed,
        raw: store.raw !== null ? mergeClaudeOauth(store.raw, refreshed) : store.raw
      }
      await persistClaudeOauth(nextStore, refreshed, store.oauth)
      return nextStore
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (lastError.message.indexOf("run claude login") >= 0) {
        throw lastError
      }
    }
  }

  throw lastError || new Error("Unable to refresh Claude session")
}

async function persistClaudeOauth(store: ClaudeCredentialStore, oauth: ClaudeOauth, expected?: ClaudeOauth): Promise<void> {
  if (store.source === "env") {
    return
  }

  if (store.source === "file" && store.filePath !== null) {
    let latest: Record<string, unknown> = store.raw !== null ? store.raw : {}
    try {
      const parsed = JSON.parse(await readFile(store.filePath, "utf8")) as unknown
      if (isRecord(parsed)) {
        latest = parsed
      }
    } catch {
      latest = store.raw !== null ? store.raw : {}
    }

    const latestOauth = readClaudeOauth(latest)
    if (expected !== undefined && latestOauth !== null && !sameOauthIdentity(latestOauth, expected) && latestOauth.accessToken !== oauth.accessToken) {
      return
    }

    try {
      await writeJsonAtomic(store.filePath, mergeClaudeOauth(latest, oauth))
    } catch {
      throw new Error("Claude token rotated but could not be saved; run claude login")
    }
    return
  }

  if (store.source === "keychain" && store.raw !== null) {
    try {
      await writeMacosKeychainCredentials(mergeClaudeOauth(store.raw, oauth))
    } catch {
      throw new Error("Claude token rotated but could not be saved; run claude login")
    }
  }
}

async function reloadClaudeStore(store: ClaudeCredentialStore, settings: RuntimeSettings): Promise<ClaudeCredentialStore | null> {
  if (store.source === "file" && store.filePath !== null) {
    return readClaudeCredentialsFile(store.filePath)
  }

  if (store.source === "keychain") {
    return readMacosKeychainCredentials(Math.max(settings.requestTimeoutMs, KEYCHAIN_TIMEOUT_MS))
  }

  return null
}

function sameOauthIdentity(left: ClaudeOauth, right: ClaudeOauth): boolean {
  return left.accessToken === right.accessToken && left.refreshToken === right.refreshToken
}

async function writeMacosKeychainCredentials(raw: Record<string, unknown>): Promise<void> {
  await runExecFile("security", ["add-generic-password", "-a", keychainAccount(), "-s", KEYCHAIN_SERVICE, "-U", "-w", JSON.stringify(raw)], KEYCHAIN_TIMEOUT_MS)
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = filePath + ".tmp-" + String(process.pid)
  try {
    await writeFile(tempPath, JSON.stringify(value), {
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

function readApiJson(response: JsonResponse, label: string): unknown {
  if (response.status === 401) {
    throw new Error("Claude session expired; run claude login")
  }

  if (response.status === 403) {
    if (isOauthOrganizationBlocked(response.json)) {
      throw new Error("Claude OAuth is not allowed for this organization")
    }

    throw new Error("Claude " + label + " failed with HTTP 403")
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error("Claude " + label + " failed with HTTP " + String(response.status))
  }

  return response.json
}

function isOauthOrganizationBlocked(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.error) || !isRecord(value.error.details)) {
    return false
  }

  return value.error.details.error_code === "oauth_not_allowed_for_organization"
}

function readLimitsWindows(value: unknown): ClaudeUsageWindow[] {
  if (!Array.isArray(value)) {
    return []
  }

  const windows: ClaudeUsageWindow[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (!isRecord(entry)) {
      continue
    }

    const percent = readNumber(entry.percent)
    if (percent === null) {
      continue
    }

    const kind = typeof entry.kind === "string" ? entry.kind : ""
    if (kind === "session") {
      windows.push({
        kind: "session",
        label: "Session",
        usedPercent: percent,
        resetsAt: readIsoEpochSeconds(entry.resets_at)
      })
      continue
    }

    if (kind === "weekly_all") {
      windows.push({
        kind: "weekly",
        label: "Week",
        usedPercent: percent,
        resetsAt: readIsoEpochSeconds(entry.resets_at)
      })
      continue
    }

    if (kind === "weekly_scoped") {
      const label = readScopedLabel(entry)
      if (label === null) {
        continue
      }

      windows.push({
        kind: "scoped",
        label: label,
        usedPercent: percent,
        resetsAt: readIsoEpochSeconds(entry.resets_at)
      })
    }
  }

  return windows
}

function readLegacyWindow(value: unknown, kind: ClaudeWindowKind, label: string): ClaudeUsageWindow | null {
  if (!isRecord(value)) {
    return null
  }

  const usedPercent = readNumber(value.utilization)
  if (usedPercent === null) {
    return null
  }

  return {
    kind: kind,
    label: label,
    usedPercent: usedPercent,
    resetsAt: readIsoEpochSeconds(value.resets_at)
  }
}

function readExtraUsage(value: Record<string, unknown>): ClaudeExtraUsage | null {
  if (isRecord(value.extra_usage)) {
    const extra = value.extra_usage
    const enabled = extra.is_enabled === true || extra.enabled === true
    const usedCents = readNumber(extra.used_credits)
    const limitCents = readNumber(extra.monthly_limit)
    const utilization = readNumber(extra.utilization)
    if (enabled || usedCents !== null || limitCents !== null || utilization !== null) {
      return {
        enabled: enabled,
        usedCents: usedCents,
        limitCents: limitCents,
        utilization: utilization
      }
    }
  }

  if (!isRecord(value.spend)) {
    return null
  }

  const spend = value.spend
  const used = readMoneyCents(spend.used)
  const limit = readMoneyCents(spend.limit)
  const balance = readMoneyCents(spend.balance)
  const utilization = readNumber(spend.percent)
  if (used === null && limit === null && balance === null && utilization === null && spend.enabled !== true) {
    return null
  }

  return {
    enabled: spend.enabled === true,
    usedCents: used,
    limitCents: limit !== null ? limit : balance,
    utilization: utilization
  }
}

function readMoneyCents(value: unknown): number | null {
  if (!isRecord(value)) {
    return readNumber(value)
  }

  const amount = readNumber(value.amount_minor)
  if (amount === null) {
    return null
  }

  return amount
}

function readScopedLabel(entry: Record<string, unknown>): string | null {
  if (!isRecord(entry.scope) || !isRecord(entry.scope.model)) {
    return null
  }

  const name = firstString(entry.scope.model, ["display_name", "id"])
  if (name === null) {
    return null
  }

  return shortModelLabel(name)
}

export function shortModelLabel(name: string): string {
  const lower = name.toLowerCase()
  if (lower.indexOf("opus") >= 0) {
    return "Opus"
  }

  if (lower.indexOf("sonnet") >= 0) {
    return "Sonnet"
  }

  if (lower.indexOf("haiku") >= 0) {
    return "Haiku"
  }

  if (lower.indexOf("fable") >= 0) {
    return "Fable"
  }

  const first = name.trim().split(/\s+/)[0]
  return first.length > 8 ? first.slice(0, 8) : first
}

function windowByKind(windows: ClaudeUsageWindow[], kind: ClaudeWindowKind): ClaudeUsageWindow | null {
  for (let index = 0; index < windows.length; index += 1) {
    if (windows[index].kind === kind) {
      return windows[index]
    }
  }

  return null
}

function scopedWindows(windows: ClaudeUsageWindow[]): ClaudeUsageWindow[] {
  const result: ClaudeUsageWindow[] = []
  for (let index = 0; index < windows.length; index += 1) {
    if (windows[index].kind === "scoped") {
      result.push(windows[index])
    }
  }

  return result
}

function normalizeWindowPercents(windows: ClaudeUsageWindow[]): ClaudeUsageWindow[] {
  let max = 0
  for (let index = 0; index < windows.length; index += 1) {
    if (windows[index].usedPercent > max) {
      max = windows[index].usedPercent
    }
  }

  const scale = max > 0 && max <= 1.5
  const result: ClaudeUsageWindow[] = []
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]
    result.push({
      ...window,
      usedPercent: clamp(scale ? Math.round(window.usedPercent * 100) : window.usedPercent, 0, 100)
    })
  }

  return result
}

export function isOauthExpired(expiresAt: number | null, skewMs: number): boolean {
  if (expiresAt === null) {
    return false
  }

  return expiresAt <= Date.now() + skewMs
}

function readScopes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const scopes: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] === "string" && value[index].trim().length > 0) {
      scopes.push(value[index].trim())
    }
  }

  return scopes
}

function keychainAccount(): string {
  const fromEnv = process.env.USER
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim()
  }

  try {
    return userInfo().username
  } catch {
    return ""
  }
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

function readIsoEpochSeconds(value: unknown): number | null {
  if (typeof value === "string" && value.trim().length > 0) {
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
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8")
    const headers: Record<string, string | number> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT
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
            reject(new Error("Claude API returned a non-JSON response"))
          }
        })
      }
    )

    req.on("error", error => {
      reject(error instanceof Error ? error : new Error(String(error)))
    })

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error("Timed out while waiting for Claude API"))
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

function isNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false
  }

  return error.code === "ENOENT"
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
