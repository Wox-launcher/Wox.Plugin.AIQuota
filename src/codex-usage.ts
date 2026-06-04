import { execFile, spawn } from "child_process"
import { access, readFile } from "fs/promises"
import { join } from "path"
import { createInterface } from "readline"
import { promisify } from "util"

import { Context, PublicAPI } from "@wox-launcher/wox-plugin"

import { getPlatformRuntime } from "./platform"
import { CommandLaunchSpec, RuntimeSettings } from "./platform/types"

const execFileAsync = promisify(execFile)

const PLUGIN_CLIENT_NAME = "wox-plugin-codex-usage"
const PLUGIN_VERSION = "0.1.0"

const DEFAULT_CACHE_TTL_SECONDS = 15
const DEFAULT_REQUEST_TIMEOUT_MS = 4000
const platformRuntime = getPlatformRuntime()

export interface AccountInfo {
  mode: "chatgpt" | "apiKey" | "unknown"
  planType: string | null
}

export interface RateLimitWindowInfo {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface CreditsInfo {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export interface RateLimitsInfo {
  primary: RateLimitWindowInfo | null
  secondary: RateLimitWindowInfo | null
  credits: CreditsInfo | null
  planType: string | null
}

export interface LocalUsageSourceSummary {
  source: string
  threadCount: number
  totalTokens: number
}

export interface LocalUsageSummary {
  totalThreads: number
  activeThreads: number
  totalTokens: number
  lastUpdatedAt: number | null
  bySource: LocalUsageSourceSummary[]
}

export interface CodexUsageSnapshot {
  fetchedAt: number
  source: "app-server" | "local-fallback"
  userAgent: string | null
  account: AccountInfo | null
  rateLimits: RateLimitsInfo | null
  local: LocalUsageSummary | null
  warnings: string[]
}

interface PluginSettings {
  cacheTtlSeconds: number
}

interface CacheEntry {
  snapshot: CodexUsageSnapshot
}

interface UsageQueryOptions {
  forceRefresh?: boolean
}

interface AppServerSnapshot {
  userAgent: string | null
  account: AccountInfo | null
  rateLimits: RateLimitsInfo | null
}

export interface JsonRpcRequest {
  id: string
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  id?: string
  result?: unknown
  error?: {
    code?: number
    message?: string
  }
}

export interface JsonRpcSessionResponse {
  result?: unknown
  error?: {
    code?: number
    message?: string
  }
}

export interface UsageProvider {
  start(ctx: Context, api: PublicAPI): Promise<void>
  getSnapshot(ctx: Context, api: PublicAPI, options?: UsageQueryOptions): Promise<CodexUsageSnapshot>
  refresh(ctx: Context, api: PublicAPI): Promise<CodexUsageSnapshot>
  invalidate(): void
}

export class CachedCodexUsageProvider implements UsageProvider {
  private cache: CacheEntry | null = null
  private inflight: Promise<CodexUsageSnapshot> | null = null
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

  async getSnapshot(ctx: Context, api: PublicAPI, options?: UsageQueryOptions): Promise<CodexUsageSnapshot> {
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

    return createEmptySnapshot()
  }

  private async loadSnapshot(ctx: Context, api: PublicAPI): Promise<CodexUsageSnapshot> {
    const warnings: string[] = []
    let appServer: AppServerSnapshot | null = null
    const runtimeSettings = getRuntimeSettings()

    try {
      appServer = await readFromAppServer(runtimeSettings)
    } catch (error) {
      const message = toErrorMessage(error)
      warnings.push("app-server: " + message)
      await log(api, ctx, "Warning", "Failed to read Codex app-server rate limits: " + message)
    }

    let local: LocalUsageSummary | null = null
    try {
      local = await readLocalUsage(runtimeSettings)
    } catch (error) {
      const message = toErrorMessage(error)
      warnings.push("sqlite: " + message)
      await log(api, ctx, "Warning", "Failed to read local Codex sqlite usage: " + message)
    }

    let fallbackAccount: AccountInfo | null = null
    if (appServer === null || appServer.account === null) {
      try {
        fallbackAccount = await readFallbackAccount(runtimeSettings)
      } catch (error) {
        const message = toErrorMessage(error)
        warnings.push("auth: " + message)
        await log(api, ctx, "Warning", "Failed to read local Codex auth info: " + message)
      }
    }

    const account = appServer !== null && appServer.account !== null ? appServer.account : fallbackAccount
    const rateLimits = appServer !== null ? appServer.rateLimits : null

    return {
      fetchedAt: Date.now(),
      source: rateLimits !== null ? "app-server" : "local-fallback",
      userAgent: appServer !== null ? appServer.userAgent : null,
      account: account,
      rateLimits: rateLimits,
      local: local,
      warnings: warnings
    }
  }

  private async readSettings(ctx: Context, api: PublicAPI): Promise<PluginSettings> {
    return {
      cacheTtlSeconds: await readNumberSetting(api, ctx, "cacheTtlSeconds", DEFAULT_CACHE_TTL_SECONDS)
    }
  }

  async refresh(ctx: Context, api: PublicAPI): Promise<CodexUsageSnapshot> {
    await this.start(ctx, api)
    return this.performRefresh(ctx, api)
  }

  private triggerBackgroundRefresh(ctx: Context, api: PublicAPI): void {
    if (this.inflight !== null) {
      return
    }

    void this.performRefresh(ctx, api).catch(async error => {
      await log(api, ctx, "Warning", "Background Codex usage refresh failed: " + toErrorMessage(error))
    })
  }

  private async performRefresh(ctx: Context, api: PublicAPI): Promise<CodexUsageSnapshot> {
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

function createEmptySnapshot(): CodexUsageSnapshot {
  return {
    fetchedAt: Date.now(),
    source: "local-fallback",
    userAgent: null,
    account: null,
    rateLimits: null,
    local: null,
    warnings: []
  }
}

async function readFromAppServer(settings: RuntimeSettings): Promise<AppServerSnapshot> {
  const requests: JsonRpcRequest[] = [
    {
      id: "initialize",
      method: "initialize",
      params: {
        clientInfo: {
          name: PLUGIN_CLIENT_NAME,
          version: PLUGIN_VERSION
        }
      }
    },
    {
      id: "account",
      method: "account/read",
      params: {}
    },
    {
      id: "rateLimits",
      method: "account/rateLimits/read"
    }
  ]

  const responses = await runJsonRpcSession(settings.codexExecutable, settings.requestTimeoutMs, requests)

  const initializeResult = readRequiredJsonRpcResult(responses.initialize, "initialize")
  const accountResult = readOptionalJsonRpcResult(responses.account)
  const rateLimitsResponse = responses.rateLimits
  const rateLimitsResult = readOptionalJsonRpcResult(rateLimitsResponse)
  const rateLimitsFromResult = readRateLimitsResult(rateLimitsResult)
  const rateLimitsFromError = rateLimitsFromResult === null ? readRateLimitsFromError(rateLimitsResponse) : null

  if (rateLimitsFromResult === null && rateLimitsFromError === null && rateLimitsResponse !== undefined && rateLimitsResponse.error !== undefined) {
    throw new Error("Codex app-server returned an error for rateLimits: " + (rateLimitsResponse.error.message || "unknown"))
  }

  return {
    userAgent: readUserAgent(initializeResult),
    account: readAccountResult(accountResult),
    rateLimits: rateLimitsFromResult !== null ? rateLimitsFromResult : rateLimitsFromError
  }
}

async function runJsonRpcSession(executable: string, timeoutMs: number, requests: JsonRpcRequest[]): Promise<Record<string, JsonRpcSessionResponse>> {
  const launchSpecs = platformRuntime.getCodexLaunchSpecs(executable)
  let lastError: Error | null = null

  for (let index = 0; index < launchSpecs.length; index += 1) {
    try {
      return await runJsonRpcSessionWithLaunchSpec(launchSpecs[index], timeoutMs, requests)
    } catch (error) {
      lastError = ensureError(error)
      if (!shouldTryNextCommand(lastError, index, launchSpecs.length)) {
        throw lastError
      }
    }
  }

  throw lastError || new Error("Unable to start Codex app-server")
}

export async function runJsonRpcSessionWithLaunchSpec(launchSpec: CommandLaunchSpec, timeoutMs: number, requests: JsonRpcRequest[]): Promise<Record<string, JsonRpcSessionResponse>> {
  return new Promise((resolve, reject) => {
    const child = spawn(launchSpec.command, launchSpec.args, launchSpec.options)

    const responseMap: Record<string, JsonRpcSessionResponse> = {}
    const pendingIds: Record<string, boolean> = {}
    const stderrLines: string[] = []
    let settled = false

    for (let index = 0; index < requests.length; index += 1) {
      pendingIds[requests[index].id] = true
    }

    const timer = setTimeout(() => {
      finishWithError(new Error("Timed out while waiting for Codex app-server"))
      child.kill()
    }, timeoutMs)

    const stdoutReader = createInterface({ input: child.stdout })
    const stderrReader = createInterface({ input: child.stderr })

    function cleanup(): void {
      clearTimeout(timer)
      stdoutReader.close()
      stderrReader.close()
      child.removeAllListeners()
    }

    function finishWithError(error: Error): void {
      if (settled) {
        return
      }

      settled = true
      cleanup()

      if (stderrLines.length > 0) {
        reject(new Error(error.message + " | stderr: " + stderrLines.join(" | ")))
        return
      }

      reject(error)
    }

    function finishWithSuccess(): void {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      resolve(responseMap)
      child.kill()
    }

    child.on("error", (error: Error) => {
      finishWithError(error)
    })

    child.on("exit", () => {
      if (settled) {
        return
      }

      if (Object.keys(responseMap).length === 0) {
        finishWithError(new Error("Codex app-server exited before returning data"))
        return
      }

      const pendingResponseIds = Object.keys(pendingIds)
      if (pendingResponseIds.length > 0) {
        finishWithError(new Error("Codex app-server exited before returning responses: " + pendingResponseIds.join(", ")))
        return
      }

      finishWithSuccess()
    })

    stdoutReader.on("line", (line: string) => {
      if (line.trim().length === 0 || line.charAt(0) !== "{") {
        return
      }

      let response: JsonRpcResponse
      try {
        response = JSON.parse(line) as JsonRpcResponse
      } catch {
        return
      }

      if (typeof response.id !== "string") {
        return
      }

      responseMap[response.id] = response.error !== undefined ? { error: response.error } : { result: response.result }
      delete pendingIds[response.id]

      if (response.id === "initialize") {
        if (response.error !== undefined) {
          for (let index = 0; index < requests.length; index += 1) {
            if (requests[index].id !== "initialize") {
              delete pendingIds[requests[index].id]
            }
          }
        } else {
          child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n")
          for (let index = 0; index < requests.length; index += 1) {
            if (requests[index].id !== "initialize") {
              child.stdin.write(JSON.stringify(requests[index]) + "\n")
            }
          }
        }
      }

      if (Object.keys(pendingIds).length === 0) {
        finishWithSuccess()
      }
    })

    stderrReader.on("line", (line: string) => {
      const trimmed = line.trim()
      if (trimmed.length > 0) {
        stderrLines.push(trimmed)
      }
    })

    let sentInitializeRequest = false
    for (let index = 0; index < requests.length; index += 1) {
      if (requests[index].id === "initialize") {
        sentInitializeRequest = true
        child.stdin.write(JSON.stringify(requests[index]) + "\n")
      }
    }

    if (!sentInitializeRequest) {
      for (let index = 0; index < requests.length; index += 1) {
        child.stdin.write(JSON.stringify(requests[index]) + "\n")
      }
      child.stdin.end()
    }

    if (Object.keys(pendingIds).length === 0) {
      finishWithSuccess()
    }
  })
}

function readUserAgent(value: unknown): string | null {
  if (!isRecord(value) || typeof value.userAgent !== "string") {
    return null
  }

  return value.userAgent
}

function readAccountResult(value: unknown): AccountInfo | null {
  if (!isRecord(value) || !isRecord(value.account)) {
    return null
  }

  const account = value.account
  if (account.type === "apiKey") {
    return {
      mode: "apiKey",
      planType: null
    }
  }

  if (account.type === "chatgpt") {
    return {
      mode: "chatgpt",
      planType: typeof account.planType === "string" ? account.planType : null
    }
  }

  return {
    mode: "unknown",
    planType: null
  }
}

function readRateLimitsResult(value: unknown): RateLimitsInfo | null {
  if (!isRecord(value) || !isRecord(value.rateLimits)) {
    return null
  }

  const rateLimits = value.rateLimits
  return {
    primary: readRateLimitWindow(rateLimits.primary),
    secondary: readRateLimitWindow(rateLimits.secondary),
    credits: readCredits(rateLimits.credits),
    planType: typeof rateLimits.planType === "string" ? rateLimits.planType : null
  }
}

function readRateLimitWindow(value: unknown): RateLimitWindowInfo | null {
  if (!isRecord(value) || typeof value.usedPercent !== "number") {
    return null
  }

  return {
    usedPercent: value.usedPercent,
    windowDurationMins: typeof value.windowDurationMins === "number" ? value.windowDurationMins : null,
    resetsAt: typeof value.resetsAt === "number" ? value.resetsAt : null
  }
}

function readCredits(value: unknown): CreditsInfo | null {
  if (!isRecord(value) || typeof value.hasCredits !== "boolean" || typeof value.unlimited !== "boolean") {
    return null
  }

  return {
    hasCredits: value.hasCredits,
    unlimited: value.unlimited,
    balance: typeof value.balance === "string" ? value.balance : null
  }
}

function readRateLimitsFromError(response: JsonRpcSessionResponse | undefined): RateLimitsInfo | null {
  if (response === undefined || response.error === undefined || typeof response.error.message !== "string") {
    return null
  }

  const body = parseJsonBodyFromErrorMessage(response.error.message)
  return readRateLimitsFromUsageBody(body)
}

function readRateLimitsFromUsageBody(value: unknown): RateLimitsInfo | null {
  if (!isRecord(value) || !isRecord(value.rate_limit)) {
    return null
  }

  const rateLimit = value.rate_limit
  const credits = readRawCredits(value.credits)
  const primary = readRawRateLimitWindow(rateLimit.primary_window)
  const secondary = readRawRateLimitWindow(rateLimit.secondary_window)
  const planType = typeof value.plan_type === "string" ? value.plan_type : null

  if (primary === null && secondary === null && credits === null && planType === null) {
    return null
  }

  return {
    primary: primary,
    secondary: secondary,
    credits: credits,
    planType: planType
  }
}

function readRawRateLimitWindow(value: unknown): RateLimitWindowInfo | null {
  if (!isRecord(value) || typeof value.used_percent !== "number") {
    return null
  }

  const windowSeconds = typeof value.limit_window_seconds === "number" ? value.limit_window_seconds : null
  const resetAfterSeconds = typeof value.reset_after_seconds === "number" ? value.reset_after_seconds : null

  return {
    usedPercent: value.used_percent,
    windowDurationMins: windowSeconds !== null ? Math.floor(windowSeconds / 60) : null,
    resetsAt: typeof value.reset_at === "number" ? value.reset_at : resetAfterSeconds !== null ? Math.floor(Date.now() / 1000) + resetAfterSeconds : null
  }
}

function readRawCredits(value: unknown): CreditsInfo | null {
  if (!isRecord(value) || typeof value.has_credits !== "boolean" || typeof value.unlimited !== "boolean") {
    return null
  }

  return {
    hasCredits: value.has_credits,
    unlimited: value.unlimited,
    balance: typeof value.balance === "string" ? value.balance : null
  }
}

function parseJsonBodyFromErrorMessage(message: string): unknown {
  const markerIndex = message.indexOf("body=")
  if (markerIndex < 0) {
    return null
  }

  const jsonStart = message.indexOf("{", markerIndex + "body=".length)
  if (jsonStart < 0) {
    return null
  }

  const jsonEnd = findJsonObjectEnd(message, jsonStart)
  if (jsonEnd < 0) {
    return null
  }

  try {
    return JSON.parse(message.slice(jsonStart, jsonEnd + 1)) as unknown
  } catch {
    return null
  }
}

function findJsonObjectEnd(value: string, start: number): number {
  let depth = 0
  let inString = false
  let escaping = false

  for (let index = start; index < value.length; index += 1) {
    const character = value.charAt(index)

    if (escaping) {
      escaping = false
      continue
    }

    if (character === "\\") {
      escaping = inString
      continue
    }

    if (character === '"') {
      inString = !inString
      continue
    }

    if (inString) {
      continue
    }

    if (character === "{") {
      depth += 1
      continue
    }

    if (character === "}") {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  return -1
}

function readRequiredJsonRpcResult(response: JsonRpcSessionResponse | undefined, id: string): unknown {
  if (response === undefined) {
    throw new Error("Codex app-server did not return a response for " + id)
  }

  if (response.error !== undefined) {
    throw new Error("Codex app-server returned an error for " + id + ": " + (response.error.message || "unknown"))
  }

  return response.result
}

function readOptionalJsonRpcResult(response: JsonRpcSessionResponse | undefined): unknown {
  if (response === undefined || response.error !== undefined) {
    return undefined
  }

  return response.result
}

async function readFallbackAccount(settings: RuntimeSettings): Promise<AccountInfo | null> {
  const authFilePath = join(settings.codexHome, "auth.json")
  const auth = JSON.parse(await readFile(authFilePath, "utf8")) as Record<string, unknown>
  const authMode = typeof auth.auth_mode === "string" ? auth.auth_mode : "unknown"

  if (!isRecord(auth.tokens)) {
    return {
      mode: normalizeAuthMode(authMode),
      planType: null
    }
  }

  const tokens = auth.tokens
  const jwt = typeof tokens.id_token === "string" ? tokens.id_token : typeof tokens.access_token === "string" ? tokens.access_token : null
  if (jwt === null) {
    return {
      mode: normalizeAuthMode(authMode),
      planType: null
    }
  }

  const payload = decodeJwtPayload(jwt)
  const authPayload = isRecord(payload["https://api.openai.com/auth"]) ? payload["https://api.openai.com/auth"] : null
  const planType = authPayload !== null && typeof authPayload.chatgpt_plan_type === "string" ? authPayload.chatgpt_plan_type : null

  return {
    mode: normalizeAuthMode(authMode),
    planType: planType
  }
}

async function readLocalUsage(settings: RuntimeSettings): Promise<LocalUsageSummary | null> {
  const databasePath = join(settings.codexHome, "state_5.sqlite")
  await access(databasePath)

  const summaryQuery = "select count(*), sum(case when archived = 0 then 1 else 0 end), coalesce(sum(tokens_used), 0), coalesce(max(updated_at), 0) from threads;"
  const sourcesQuery = "select source, count(*), coalesce(sum(tokens_used), 0) from threads group by source order by coalesce(sum(tokens_used), 0) desc;"

  const summaryResult = await runSqliteExecFile(settings.sqliteExecutable, [databasePath, summaryQuery], settings.requestTimeoutMs)
  const sourcesResult = await runSqliteExecFile(settings.sqliteExecutable, [databasePath, sourcesQuery], settings.requestTimeoutMs)

  const summaryLine = firstNonEmptyLine(summaryResult.stdout)
  if (summaryLine === null) {
    return null
  }

  const summaryParts = splitSqliteLine(summaryLine)
  const bySource: LocalUsageSourceSummary[] = []
  const sourceLines = nonEmptyLines(sourcesResult.stdout)

  for (let index = 0; index < sourceLines.length; index += 1) {
    const parts = splitSqliteLine(sourceLines[index])
    if (parts.length < 3) {
      continue
    }

    bySource.push({
      source: parts[0],
      threadCount: toInteger(parts[1]),
      totalTokens: toInteger(parts[2])
    })
  }

  return {
    totalThreads: summaryParts.length > 0 ? toInteger(summaryParts[0]) : 0,
    activeThreads: summaryParts.length > 1 ? toInteger(summaryParts[1]) : 0,
    totalTokens: summaryParts.length > 2 ? toInteger(summaryParts[2]) : 0,
    lastUpdatedAt: summaryParts.length > 3 && toInteger(summaryParts[3]) > 0 ? toInteger(summaryParts[3]) : null,
    bySource: bySource
  }
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

async function runExecFile(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  })
}

async function runSqliteExecFile(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const candidates = platformRuntime.getSqliteExecutableCandidates(command)
  let lastError: Error | null = null

  for (let index = 0; index < candidates.length; index += 1) {
    try {
      return await runExecFile(candidates[index], args, timeoutMs)
    } catch (error) {
      lastError = ensureError(error)
      if (!shouldTryNextCommand(lastError, index, candidates.length)) {
        throw lastError
      }
    }
  }

  throw lastError || new Error("Unable to run sqlite command")
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

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".")
  if (parts.length < 2) {
    return {}
  }

  const segment = parts[1]
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "===".slice((normalized.length + 3) % 4)
  const payload = Buffer.from(padded, "base64").toString("utf8")
  return JSON.parse(payload) as Record<string, unknown>
}

function normalizeAuthMode(value: string): "chatgpt" | "apiKey" | "unknown" {
  if (value === "chatgpt") {
    return "chatgpt"
  }

  if (value === "apikey" || value === "api_key") {
    return "apiKey"
  }

  return "unknown"
}

function splitSqliteLine(value: string): string[] {
  return value.split("|")
}

function firstNonEmptyLine(output: string): string | null {
  const lines = nonEmptyLines(output)
  return lines.length > 0 ? lines[0] : null
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

function toInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 0
  }

  return Math.floor(parsed)
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

function shouldTryNextCommand(error: Error, index: number, total: number): boolean {
  if (index >= total - 1) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.indexOf("enoent") >= 0 || message.indexOf("spawn") >= 0 || message.indexOf("not recognized as an internal or external command") >= 0 || message.indexOf("cannot find the file") >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function formatPlanType(planType: string | null): string {
  if (planType === null || planType.length === 0) {
    return "Unknown"
  }

  return planType.charAt(0).toUpperCase() + planType.slice(1)
}

export function formatWindowLabel(window: RateLimitWindowInfo | null, fallback: string): string {
  if (window === null || window.windowDurationMins === null) {
    return fallback
  }

  if (window.windowDurationMins % 10080 === 0) {
    const weeks = window.windowDurationMins / 10080
    return weeks === 1 ? "Weekly" : String(weeks) + "w"
  }

  if (window.windowDurationMins % 1440 === 0) {
    const days = window.windowDurationMins / 1440
    return days === 1 ? "Daily" : String(days) + "d"
  }

  if (window.windowDurationMins % 60 === 0) {
    return String(window.windowDurationMins / 60) + "h"
  }

  return String(window.windowDurationMins) + "m"
}

export function formatResetTime(epochSeconds: number | null): string {
  if (epochSeconds === null) {
    return "unknown"
  }

  const date = new Date(epochSeconds * 1000)
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date)
}

export function formatCompactNumber(value: number): string {
  const absValue = Math.abs(value)
  if (absValue >= 1000000000) {
    return (value / 1000000000).toFixed(absValue >= 10000000000 ? 0 : 1) + "B"
  }

  if (absValue >= 1000000) {
    return (value / 1000000).toFixed(absValue >= 10000000 ? 0 : 1) + "M"
  }

  if (absValue >= 1000) {
    return (value / 1000).toFixed(absValue >= 10000 ? 0 : 1) + "K"
  }

  return String(value)
}
