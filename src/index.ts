import { Context, Plugin, PluginInitParams, PublicAPI, Query, Result, ResultAction, ResultTail } from "@wox-launcher/wox-plugin"

import { CachedCodexUsageProvider, CodexUsageSnapshot, CodexWindowLabels, listCodexWindows, RateLimitWindowInfo, resolveCodexPlanName, resolveCodexWindowLabel, shouldShowCodexResult, UsageProvider } from "./codex-usage"
import {
  CachedCursorUsageProvider,
  CursorSandUsage,
  CursorUsageProvider,
  CursorUsageSnapshot,
  getCursorModelRemainingPercent,
  getOtherModelRemainingPercent,
  getGrokBotRemainingPercent,
  getRequestRemainingPercent,
  shouldShowCursorResult,
  shouldShowGrokBotReset,
  shouldShowGrokBotResult
} from "./cursor-usage"
import {
  CachedClaudeUsageProvider,
  ClaudeExtraUsage,
  ClaudeUsageProvider,
  ClaudeUsageSnapshot,
  ClaudeUsageWindow,
  formatUsdFromCents as formatClaudeUsdFromCents,
  getClaudeExtraRemainingPercent,
  getClaudeRemainingPercent,
  listClaudeDisplayWindows,
  shouldShowClaudeReset,
  shouldShowClaudeResult
} from "./claude-usage"
import { CachedGrokUsageProvider, getGrokRemainingPercent, GrokPeriodType, GrokUsageProvider, GrokUsageSnapshot, shouldShowGrokReset, shouldShowGrokResult } from "./grok-usage"
import { CLAUDE_ICON, CODEX_ICON, CURSOR_ICON, GROK_BOT_ICON, GROK_ICON } from "./icons"

export type BarFillMode = "remaining" | "used"

const DEFAULT_BAR_FILL_MODE: BarFillMode = "remaining"

interface LocaleStrings {
  subtitleNoLiveData: string
  subtitleFallback: string
  subtitleResetIn: string
  windowWeek: string
  windowMonth: string
  windowDay: string
  windowFiveHour: string
  windowLimit: string
  windowCursorModels: string
  windowOtherModels: string
  windowRequests: string
  summaryLine: string
  summaryWarnings: string
  cursorMonthReset: string
  cursorRequestsLeft: string
  cursorNoLiveData: string
  cursorNotSignedIn: string
  cursorNotFound: string
  grokPeriodReset: string
  grokBotWeekReset: string
  grokNoLiveData: string
  grokNotSignedIn: string
  grokNotFound: string
  claudeNoLiveData: string
  claudeNotSignedIn: string
  claudeNotFound: string
  claudeExtraUsage: string
  namedUsageTitle: string
  planResetIn: string
  groupCodex: string
  groupClaude: string
  groupCursor: string
  groupGrok: string
  windowClaudeSession: string
  windowClaudeWeek: string
  windowClaudeExtra: string
  windowCursorModelsTitle: string
  windowOtherModelsTitle: string
  windowRequestsTitle: string
  windowGrokBuild: string
  windowGrokChat: string
  windowGrokBot: string
  timeUnknown: string
  timeSoon: string
  unitDayShort: string
  unitHourShort: string
  unitMinuteShort: string
  durationJoiner: string
}

const DEFAULT_LOCALE_STRINGS: LocaleStrings = {
  subtitleNoLiveData: "No live rate limit data",
  subtitleFallback: "fallback",
  subtitleResetIn: "%s reset in %s",
  windowWeek: "Week",
  windowMonth: "Month",
  windowDay: "Day",
  windowFiveHour: "5H",
  windowLimit: "Limit",
  windowCursorModels: "Cursor",
  windowOtherModels: "Other",
  windowRequests: "Req",
  summaryLine: "%s left %s, reset in %s",
  summaryWarnings: "Warnings: %s",
  cursorMonthReset: "%s · month reset in %s",
  cursorRequestsLeft: "%s · %s / %s left · reset in %s",
  cursorNoLiveData: "No live Cursor usage data",
  cursorNotSignedIn: "Sign in to Cursor on this machine",
  cursorNotFound: "Cursor is not installed on this machine",
  grokPeriodReset: "%s · %s reset in %s",
  grokBotWeekReset: "%s · week reset in %s",
  grokNoLiveData: "No live Grok usage data",
  grokNotSignedIn: "Run grok login on this machine",
  grokNotFound: "Grok CLI is not installed on this machine",
  claudeNoLiveData: "No live Claude usage data",
  claudeNotSignedIn: "Sign in to Claude Code on this machine",
  claudeNotFound: "Claude Code is not installed on this machine",
  claudeExtraUsage: "Extra %s / %s",
  namedUsageTitle: "%s %s Usage",
  planResetIn: "%s · reset in %s",
  groupCodex: "Codex",
  groupClaude: "Claude",
  groupCursor: "Cursor",
  groupGrok: "Grok",
  windowClaudeSession: "Session",
  windowClaudeWeek: "Week",
  windowClaudeExtra: "Extra",
  windowCursorModelsTitle: "Models",
  windowOtherModelsTitle: "Other Models",
  windowRequestsTitle: "Requests",
  windowGrokBuild: "Build",
  windowGrokChat: "Chat",
  windowGrokBot: "Bot",
  timeUnknown: "unknown",
  timeSoon: "soon",
  unitDayShort: "d",
  unitHourShort: "h",
  unitMinuteShort: "m",
  durationJoiner: " "
}

export class AIQuotaPlugin implements Plugin {
  private api: PublicAPI | null = null
  private provider: UsageProvider
  private cursorProvider: CursorUsageProvider
  private grokProvider: GrokUsageProvider
  private claudeProvider: ClaudeUsageProvider

  constructor(provider?: UsageProvider, cursorProvider?: CursorUsageProvider, grokProvider?: GrokUsageProvider, claudeProvider?: ClaudeUsageProvider) {
    this.provider = provider || new CachedCodexUsageProvider()
    this.cursorProvider = cursorProvider || new CachedCursorUsageProvider()
    this.grokProvider = grokProvider || new CachedGrokUsageProvider()
    this.claudeProvider = claudeProvider || new CachedClaudeUsageProvider()
    this.init = this.init.bind(this)
    this.query = this.query.bind(this)
  }

  async init(ctx: Context, initParams: PluginInitParams): Promise<void> {
    this.api = initParams.API
    await this.provider.start(ctx, this.api)
    await this.cursorProvider.start(ctx, this.api)
    await this.grokProvider.start(ctx, this.api)
    await this.claudeProvider.start(ctx, this.api)
    await safeLog(this.api, ctx, "Info", "AI Quota plugin initialized")
  }

  async query(ctx: Context, query: Query): Promise<Result[]> {
    if (this.api === null) {
      throw new Error("Plugin has not been initialized")
    }

    const filter = resolveUsageFilter(query)
    const forceRefresh = shouldForceRefresh(query.Search)
    const results: Result[] = []
    let cursorSnapshot: CursorUsageSnapshot | null = null

    if (includesProvider(filter, "codex")) {
      try {
        const snapshot = forceRefresh ? await this.provider.refresh(ctx, this.api) : await this.provider.getSnapshot(ctx, this.api)
        if (shouldShowCodexResult(snapshot, filter)) {
          results.push(...(await buildResults(snapshot, this.api, ctx, this.provider)))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(this.api, ctx, "Error", "Failed to read Codex usage: " + message)
        results.push(buildErrorResult(message, this.api, ctx, this.provider))
      }
    }

    if (includesProvider(filter, "cursor") || includesProvider(filter, "grok")) {
      try {
        cursorSnapshot = forceRefresh ? await this.cursorProvider.refresh(ctx, this.api) : await this.cursorProvider.getSnapshot(ctx, this.api)
        if (includesProvider(filter, "cursor") && shouldShowCursorResult(cursorSnapshot, filter)) {
          results.push(...(await buildCursorResults(cursorSnapshot, this.api, ctx, this.cursorProvider)))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(this.api, ctx, "Error", "Failed to read Cursor usage: " + message)
        if (filter === "cursor") {
          results.push(buildCursorErrorResult(message, this.api, ctx, this.cursorProvider))
        }
      }
    }

    if (includesProvider(filter, "claude")) {
      try {
        const snapshot = forceRefresh ? await this.claudeProvider.refresh(ctx, this.api) : await this.claudeProvider.getSnapshot(ctx, this.api)
        if (shouldShowClaudeResult(snapshot, filter)) {
          results.push(...(await buildClaudeResults(snapshot, this.api, ctx, this.claudeProvider)))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(this.api, ctx, "Error", "Failed to read Claude usage: " + message)
        if (filter === "claude") {
          results.push(buildClaudeErrorResult(message, this.api, ctx, this.claudeProvider))
        }
      }
    }

    if (includesProvider(filter, "grok")) {
      try {
        const snapshot = forceRefresh ? await this.grokProvider.refresh(ctx, this.api) : await this.grokProvider.getSnapshot(ctx, this.api)
        const grokBotVisible = shouldShowGrokBotResult(cursorSnapshot, filter)
        const hideCliWhenBotReady = filter === "all" && snapshot.availability !== "ready" && grokBotVisible
        if (shouldShowGrokResult(snapshot, filter) && !hideCliWhenBotReady) {
          results.push(...(await buildGrokResults(snapshot, this.api, ctx, this.grokProvider)))
        }
        if (grokBotVisible && cursorSnapshot !== null) {
          results.push(...(await buildGrokBotResults(cursorSnapshot, this.api, ctx, this.cursorProvider)))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(this.api, ctx, "Error", "Failed to read Grok usage: " + message)
        if (shouldShowGrokBotResult(cursorSnapshot, filter) && cursorSnapshot !== null) {
          results.push(...(await buildGrokBotResults(cursorSnapshot, this.api, ctx, this.cursorProvider)))
        } else if (filter === "grok") {
          results.push(buildGrokErrorResult(message, this.api, ctx, this.grokProvider))
        }
      }
    }

    return results
  }
}

export const plugin: Plugin = new AIQuotaPlugin()

export function shouldForceRefresh(search: string): boolean {
  const normalized = search.trim().toLowerCase()
  return normalized === "refresh" || normalized === "reload" || normalized.endsWith(" refresh") || normalized.endsWith(" reload")
}

export type UsageFilter = "all" | "codex" | "cursor" | "grok" | "claude"

export function includesProvider(filter: UsageFilter, provider: Exclude<UsageFilter, "all">): boolean {
  return filter === "all" || filter === provider
}

export function resolveUsageFilter(query: Pick<Query, "Search"> & { Command?: string }): UsageFilter {
  const command = (query.Command || "").trim().toLowerCase()
  if (command === "cursor") {
    return "cursor"
  }

  if (command === "codex") {
    return "codex"
  }

  if (command === "grok") {
    return "grok"
  }

  if (command === "claude") {
    return "claude"
  }

  const search = query.Search.trim().toLowerCase()
  if (search === "cursor" || search.startsWith("cursor ")) {
    return "cursor"
  }

  if (search === "codex" || search.startsWith("codex ")) {
    return "codex"
  }

  if (search === "grok" || search.startsWith("grok ")) {
    return "grok"
  }

  if (search === "claude" || search.startsWith("claude ")) {
    return "claude"
  }

  return "all"
}

export async function buildResults(snapshot: CodexUsageSnapshot, api: PublicAPI, ctx: Context, provider: UsageProvider): Promise<Result[]> {
  const strings = await readLocaleStrings(api, ctx)
  const barMode = await readBarFillMode(api, ctx)
  const subtitle = buildOverviewSubtitle(snapshot, strings)
  const summaryText = buildSummaryText(snapshot, strings, subtitle)
  const rawText = JSON.stringify(snapshot, null, 2)
  const commonActions = buildCommonActions(summaryText, rawText, api, ctx, provider)
  const group = usageGroup(strings.groupCodex, 100)
  const windows = listCodexWindows(snapshot.rateLimits)
  const labels = toCodexWindowLabels(strings)

  if (windows.length === 0) {
    return [
      groupedResult(
        {
          Id: "codex-usage-overview",
          Title: "i18n:result_title",
          SubTitle: subtitle,
          Icon: CODEX_ICON,
          Tails: [],
          Actions: commonActions
        },
        group,
        100
      )
    ]
  }

  const results: Result[] = []
  const planName = resolveCodexPlanName(snapshot)
  for (let index = 0; index < windows.length; index += 1) {
    const label = resolveCodexWindowLabel(windows[index], labels)
    const resetLabel = formatRelativeReset(windows[index], strings)
    const subtitle = planName !== null ? formatTemplate(strings.planResetIn, planName, resetLabel) : formatTemplate(strings.subtitleResetIn, label, resetLabel)
    results.push(
      groupedResult(
        {
          Id: "codex-usage-" + slugify(label) + "-" + String(index),
          Title: formatTemplate(strings.namedUsageTitle, strings.groupCodex, label),
          SubTitle: subtitle,
          Icon: CODEX_ICON,
          Tails: [buildProgressTail(label, windows[index], barMode)],
          Actions: commonActions
        },
        group,
        100 - index
      )
    )
  }

  return results
}

export async function buildClaudeResults(snapshot: ClaudeUsageSnapshot, api: PublicAPI, ctx: Context, provider: ClaudeUsageProvider): Promise<Result[]> {
  const strings = await readLocaleStrings(api, ctx)
  const barMode = await readBarFillMode(api, ctx)
  const group = usageGroup(strings.groupClaude, 95)
  const actions = buildClaudeActions(api, ctx, provider)

  if (snapshot.availability !== "ready") {
    return [
      groupedResult(
        {
          Id: "claude-usage-overview",
          Title: "i18n:claude_result_title",
          SubTitle: buildClaudeSubtitle(snapshot, strings),
          Icon: CLAUDE_ICON,
          Tails: [],
          Actions: actions
        },
        group,
        95
      )
    ]
  }

  const results: Result[] = []
  const windows = listClaudeDisplayWindows(snapshot.windows)
  const planName = snapshot.planName !== null ? snapshot.planName : strings.groupClaude

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]
    const label = claudeWindowLabel(window, strings)
    results.push(
      groupedResult(
        {
          Id: "claude-usage-" + slugify(label) + "-" + String(index),
          Title: formatTemplate(strings.namedUsageTitle, strings.groupClaude, label),
          SubTitle: buildClaudeWindowSubtitle(planName, window, strings),
          Icon: CLAUDE_ICON,
          Tails: [buildRemainingProgressTail(claudeBarLabel(window, strings), getClaudeRemainingPercent(window.usedPercent), barMode)],
          Actions: actions
        },
        group,
        95 - index
      )
    )
  }

  const extra = formatClaudeExtraUsage(snapshot.extraUsage, strings)
  if (extra !== null) {
    results.push(
      groupedResult(
        {
          Id: "claude-usage-extra",
          Title: formatTemplate(strings.namedUsageTitle, strings.groupClaude, strings.windowClaudeExtra),
          SubTitle: planName + " · " + extra,
          Icon: CLAUDE_ICON,
          Tails: [buildRemainingProgressTail(strings.windowClaudeExtra, getClaudeExtraRemainingPercent(snapshot.extraUsage), barMode)],
          Actions: actions
        },
        group,
        95 - results.length
      )
    )
  }

  if (results.length === 0) {
    return [
      groupedResult(
        {
          Id: "claude-usage-overview",
          Title: "i18n:claude_result_title",
          SubTitle: strings.claudeNoLiveData,
          Icon: CLAUDE_ICON,
          Tails: [],
          Actions: actions
        },
        group,
        95
      )
    ]
  }

  return results
}

export async function buildGrokResults(snapshot: GrokUsageSnapshot, api: PublicAPI, ctx: Context, provider: GrokUsageProvider): Promise<Result[]> {
  const strings = await readLocaleStrings(api, ctx)
  const barMode = await readBarFillMode(api, ctx)
  const group = usageGroup(strings.groupGrok, 80)
  const actions = buildGrokActions(api, ctx, provider)

  if (snapshot.availability !== "ready") {
    return [
      groupedResult(
        {
          Id: "grok-usage-overview",
          Title: "i18n:grok_result_title",
          SubTitle: buildGrokSubtitle(snapshot, strings),
          Icon: GROK_ICON,
          Tails: [],
          Actions: actions
        },
        group,
        80
      )
    ]
  }

  const results: Result[] = []
  const planName = snapshot.planName !== null ? snapshot.planName : "SuperGrok"
  const periodLabel = grokPeriodLabel(snapshot.periodType, strings)
  const remaining = getGrokRemainingPercent(snapshot.creditUsagePercent)
  if (remaining !== null) {
    results.push(
      groupedResult(
        {
          Id: "grok-usage-period",
          Title: formatTemplate(strings.namedUsageTitle, strings.groupGrok, periodLabel),
          SubTitle: formatTemplate(strings.grokPeriodReset, planName, periodLabel, formatRelativeResetAt(snapshot.billingCycleEnd, strings)),
          Icon: GROK_ICON,
          Tails: [buildRemainingProgressTail(periodLabel, remaining, barMode)],
          Actions: actions
        },
        group,
        80
      )
    )
  }

  for (let index = 0; index < snapshot.productUsage.length; index += 1) {
    const product = snapshot.productUsage[index]
    const productRemaining = getGrokRemainingPercent(product.usagePercent)
    if (productRemaining === null || productRemaining === remaining) {
      continue
    }

    const label = productBarLabel(product.product, strings)
    results.push(
      groupedResult(
        {
          Id: "grok-usage-" + slugify(label) + "-" + String(index),
          Title: formatTemplate(strings.namedUsageTitle, strings.groupGrok, label),
          SubTitle: formatTemplate(strings.planResetIn, planName, formatRelativeResetAt(snapshot.billingCycleEnd, strings)),
          Icon: GROK_ICON,
          Tails: [buildRemainingProgressTail(label, productRemaining, barMode)],
          Actions: actions
        },
        group,
        80 - results.length
      )
    )
  }

  if (results.length === 0) {
    return [
      groupedResult(
        {
          Id: "grok-usage-overview",
          Title: "i18n:grok_result_title",
          SubTitle: buildGrokSubtitle(snapshot, strings),
          Icon: GROK_ICON,
          Tails: [],
          Actions: actions
        },
        group,
        80
      )
    ]
  }

  return results
}

export async function buildGrokBotResults(snapshot: CursorUsageSnapshot, api: PublicAPI, ctx: Context, provider: CursorUsageProvider): Promise<Result[]> {
  const strings = await readLocaleStrings(api, ctx)
  const barMode = await readBarFillMode(api, ctx)

  return [
    groupedResult(
      {
        Id: "grok-bot-usage-overview",
        Title: "i18n:grok_bot_result_title",
        SubTitle: buildGrokBotSubtitle(snapshot.sandUsage, snapshot.planName, strings),
        Icon: GROK_BOT_ICON,
        Tails: buildGrokBotTails(snapshot.sandUsage, strings, barMode),
        Actions: buildCursorActions(api, ctx, provider)
      },
      usageGroup(strings.groupGrok, 80),
      70
    )
  ]
}

export async function buildCursorResults(snapshot: CursorUsageSnapshot, api: PublicAPI, ctx: Context, provider: CursorUsageProvider): Promise<Result[]> {
  const strings = await readLocaleStrings(api, ctx)
  const barMode = await readBarFillMode(api, ctx)
  const group = usageGroup(strings.groupCursor, 90)
  const actions = buildCursorActions(api, ctx, provider)
  const subtitle = buildCursorSubtitle(snapshot, strings)

  if (snapshot.availability !== "ready") {
    return [
      groupedResult(
        {
          Id: "cursor-usage-overview",
          Title: "i18n:cursor_result_title",
          SubTitle: subtitle,
          Icon: CURSOR_ICON,
          Tails: [],
          Actions: actions
        },
        group,
        90
      )
    ]
  }

  const results: Result[] = []
  if (snapshot.requestUsage !== null) {
    results.push(
      groupedResult(
        {
          Id: "cursor-usage-requests",
          Title: formatTemplate(strings.namedUsageTitle, strings.groupCursor, strings.windowRequestsTitle),
          SubTitle: subtitle,
          Icon: CURSOR_ICON,
          Tails: [buildRemainingProgressTail(strings.windowRequests, getRequestRemainingPercent(snapshot.requestUsage), barMode)],
          Actions: actions
        },
        group,
        90
      )
    )
    return results
  }

  const cursorRemaining = getCursorModelRemainingPercent(snapshot.planUsage)
  const otherRemaining = getOtherModelRemainingPercent(snapshot.planUsage)
  if (cursorRemaining !== null) {
    results.push(
      groupedResult(
        {
          Id: "cursor-usage-models",
          Title: formatTemplate(strings.namedUsageTitle, strings.groupCursor, strings.windowCursorModelsTitle),
          SubTitle: subtitle,
          Icon: CURSOR_ICON,
          Tails: [buildRemainingProgressTail(strings.windowCursorModels, cursorRemaining, barMode)],
          Actions: actions
        },
        group,
        90
      )
    )
  }

  if (otherRemaining !== null) {
    results.push(
      groupedResult(
        {
          Id: "cursor-usage-other",
          Title: formatTemplate(strings.namedUsageTitle, strings.groupCursor, strings.windowOtherModelsTitle),
          SubTitle: subtitle,
          Icon: CURSOR_ICON,
          Tails: [buildRemainingProgressTail(strings.windowOtherModels, otherRemaining, barMode)],
          Actions: actions
        },
        group,
        89
      )
    )
  }

  if (results.length === 0 && snapshot.planUsage !== null && snapshot.planUsage.totalPercentUsed !== null) {
    results.push(
      groupedResult(
        {
          Id: "cursor-usage-overview",
          Title: "i18n:cursor_result_title",
          SubTitle: subtitle,
          Icon: CURSOR_ICON,
          Tails: [buildRemainingProgressTail(strings.windowLimit, clamp(Math.round(100 - snapshot.planUsage.totalPercentUsed), 0, 100), barMode)],
          Actions: actions
        },
        group,
        90
      )
    )
  }

  if (results.length === 0) {
    return [
      groupedResult(
        {
          Id: "cursor-usage-overview",
          Title: "i18n:cursor_result_title",
          SubTitle: subtitle,
          Icon: CURSOR_ICON,
          Tails: [],
          Actions: actions
        },
        group,
        90
      )
    ]
  }

  return results
}

function buildOverviewSubtitle(snapshot: CodexUsageSnapshot, strings: LocaleStrings): string {
  const parts: string[] = []
  const planName = resolveCodexPlanName(snapshot)
  if (planName !== null) {
    parts.push(planName)
  }

  const windows = listCodexWindows(snapshot.rateLimits)
  const labels = toCodexWindowLabels(strings)

  for (let index = 0; index < windows.length; index += 1) {
    parts.push(formatTemplate(strings.subtitleResetIn, resolveCodexWindowLabel(windows[index], labels), formatRelativeReset(windows[index], strings)))
  }

  if (parts.length === 0) {
    parts.push(strings.subtitleNoLiveData)
  }

  if (snapshot.warnings.length > 0) {
    parts.push(strings.subtitleFallback)
  }

  return parts.join(" · ")
}

function buildClaudeSubtitle(snapshot: ClaudeUsageSnapshot, strings: LocaleStrings): string {
  if (snapshot.availability === "unavailable") {
    if (snapshot.warnings.indexOf("not-signed-in") >= 0) {
      return strings.claudeNotSignedIn
    }

    if (snapshot.warnings.indexOf("claude-not-found") >= 0) {
      return strings.claudeNotFound
    }

    return snapshot.warnings.length > 0 ? snapshot.warnings[0] : strings.claudeNoLiveData
  }

  if (snapshot.availability === "error") {
    return snapshot.warnings.length > 0 ? snapshot.warnings[0] : strings.claudeNoLiveData
  }

  return strings.claudeNoLiveData
}

function formatClaudeExtraUsage(extraUsage: ClaudeExtraUsage | null, strings: LocaleStrings): string | null {
  if (extraUsage === null || !extraUsage.enabled) {
    return null
  }

  if (extraUsage.usedCents === null && extraUsage.limitCents === null) {
    return null
  }

  const used = extraUsage.usedCents !== null ? formatClaudeUsdFromCents(extraUsage.usedCents) : "--"
  const limit = extraUsage.limitCents !== null ? formatClaudeUsdFromCents(extraUsage.limitCents) : "--"
  return formatTemplate(strings.claudeExtraUsage, used, limit)
}

function buildClaudeWindowSubtitle(planName: string, window: ClaudeUsageWindow, strings: LocaleStrings): string {
  if (!shouldShowClaudeReset(window)) {
    return planName
  }

  return formatTemplate(strings.planResetIn, planName, formatRelativeResetAt(window.resetsAt, strings))
}

function claudeWindowLabel(window: ClaudeUsageWindow, strings: LocaleStrings): string {
  if (window.kind === "session") {
    return strings.windowClaudeSession
  }

  if (window.kind === "weekly") {
    return strings.windowClaudeWeek
  }

  return window.label
}

function claudeBarLabel(window: ClaudeUsageWindow, strings: LocaleStrings): string {
  if (window.kind === "session") {
    return strings.windowFiveHour
  }

  if (window.kind === "weekly") {
    return strings.windowClaudeWeek
  }

  return window.label
}

function buildGrokSubtitle(snapshot: GrokUsageSnapshot, strings: LocaleStrings): string {
  if (snapshot.availability === "unavailable") {
    if (snapshot.warnings.indexOf("not-signed-in") >= 0) {
      return strings.grokNotSignedIn
    }

    if (snapshot.warnings.indexOf("grok-not-found") >= 0) {
      return strings.grokNotFound
    }

    return snapshot.warnings.length > 0 ? snapshot.warnings[0] : strings.grokNoLiveData
  }

  if (snapshot.availability === "error") {
    return snapshot.warnings.length > 0 ? snapshot.warnings[0] : strings.grokNoLiveData
  }

  const planName = snapshot.planName !== null ? snapshot.planName : "SuperGrok"
  const parts = shouldShowGrokReset(snapshot)
    ? [formatTemplate(strings.grokPeriodReset, planName, grokPeriodLabel(snapshot.periodType, strings), formatRelativeResetAt(snapshot.billingCycleEnd, strings))]
    : [planName]

  if (snapshot.warnings.length > 0) {
    parts.push(strings.subtitleFallback)
  }

  return parts.join(" | ")
}

function buildGrokBotSubtitle(sandUsage: CursorSandUsage | null, planName: string | null, strings: LocaleStrings): string {
  const name = planName !== null && planName.length > 0 ? planName : "Grok Bot"
  if (!shouldShowGrokBotReset(sandUsage)) {
    return name
  }

  return formatTemplate(strings.grokBotWeekReset, name, formatRelativeResetAt(sandUsage !== null ? sandUsage.resetAt : null, strings))
}

function buildGrokBotTails(sandUsage: CursorSandUsage | null, strings: LocaleStrings, mode: BarFillMode): ResultTail[] {
  const remaining = getGrokBotRemainingPercent(sandUsage)
  if (remaining === null) {
    return []
  }

  return [buildRemainingProgressTail(strings.windowGrokBot, remaining, mode)]
}

function grokPeriodLabel(periodType: GrokPeriodType, strings: LocaleStrings): string {
  if (periodType === "monthly") {
    return strings.windowMonth
  }

  if (periodType === "weekly") {
    return strings.windowWeek
  }

  return strings.windowLimit
}

function productBarLabel(product: string, strings: LocaleStrings): string {
  const normalized = product.toLowerCase()
  if (normalized.indexOf("build") >= 0) {
    return strings.windowGrokBuild
  }

  if (normalized.indexOf("chat") >= 0) {
    return strings.windowGrokChat
  }

  return product
}

function buildCursorSubtitle(snapshot: CursorUsageSnapshot, strings: LocaleStrings): string {
  if (snapshot.availability === "unavailable") {
    if (snapshot.warnings.indexOf("not-signed-in") >= 0) {
      return strings.cursorNotSignedIn
    }

    if (snapshot.warnings.indexOf("cursor-not-found") >= 0) {
      return strings.cursorNotFound
    }

    return snapshot.warnings.length > 0 ? snapshot.warnings[0] : strings.cursorNoLiveData
  }

  if (snapshot.availability === "error") {
    return snapshot.warnings.length > 0 ? snapshot.warnings[0] : strings.cursorNoLiveData
  }

  const planName = snapshot.planName !== null ? snapshot.planName : "Cursor"
  const resetLabel = formatRelativeResetAt(snapshot.billingCycleEnd, strings)
  const parts: string[] = []

  if (snapshot.requestUsage !== null) {
    const remaining = Math.max(0, snapshot.requestUsage.max - snapshot.requestUsage.used)
    parts.push(formatTemplate(strings.cursorRequestsLeft, planName, String(remaining), String(snapshot.requestUsage.max), resetLabel))
  } else if (snapshot.planUsage !== null || snapshot.billingCycleEnd !== null) {
    parts.push(formatTemplate(strings.cursorMonthReset, planName, resetLabel))
  } else {
    parts.push(strings.cursorNoLiveData)
  }

  if (snapshot.warnings.length > 0) {
    parts.push(strings.subtitleFallback)
  }

  return parts.join(" | ")
}

function usageGroup(name: string, score: number): { name: string; score: number } {
  return {
    name: name,
    score: score
  }
}

function groupedResult(result: Result, group: { name: string; score: number }, score: number): Result {
  return {
    ...result,
    Score: score,
    Group: group.name,
    GroupScore: group.score
  }
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
  return slug.length > 0 ? slug : "window"
}

function buildProgressTail(label: string, window: RateLimitWindowInfo | null, mode: BarFillMode): ResultTail {
  return buildRemainingProgressTail(label, getRemainingPercent(window), mode)
}

function buildRemainingProgressTail(label: string, remaining: number | null, mode: BarFillMode): ResultTail {
  const svg = renderProgressSvg(label, remaining, mode)

  return {
    Type: "image",
    Image: {
      ImageType: "svg",
      ImageData: svg
    },
    ImageWidth: 96,
    ImageHeight: 18
  }
}

function renderProgressSvg(label: string, remaining: number | null, mode: BarFillMode): string {
  const shownPercent = resolveShownPercent(remaining, mode)
  const percentText = shownPercent === null ? "--" : String(Math.round(shownPercent)) + "%"
  const fillColor = getProgressFillColor(remaining)
  const safePercent = shownPercent === null ? 0 : shownPercent
  const fillWidth = Math.round((94 * safePercent) / 100)
  const labelText = label + " " + percentText
  const fillPath = buildStadiumFillPath(1, 1, 94, 16, 8, fillWidth)

  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="18" viewBox="0 0 96 18">',
    '<rect x="0" y="0" width="96" height="18" rx="9" fill="#687084"/>',
    '<rect x="1" y="1" width="94" height="16" rx="8" fill="#ffffff"/>'
  ]

  if (fillPath !== null) {
    parts.push('<path d="' + fillPath + '" fill="' + fillColor + '"/>')
  }

  parts.push(
    '<text x="48" y="12.4" text-anchor="middle" font-family="Arial, sans-serif" font-size="9.5" fill="#1f2937">' + escapeXml(labelText) + "</text>",
    "</svg>"
  )

  return parts.join("")
}

function svgNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100
  if (rounded === 0) {
    return "0"
  }

  return String(rounded)
}

function buildStadiumFillPath(x: number, y: number, width: number, height: number, radius: number, fillWidth: number): string | null {
  if (fillWidth <= 0 || width <= 0 || height <= 0) {
    return null
  }

  const maxRadius = Math.min(radius, width / 2, height / 2)
  const right = x + width
  const bottom = y + height
  const cxLeft = x + maxRadius
  const cxRight = right - maxRadius
  const cy = y + height / 2
  const fillRight = Math.min(x + fillWidth, right)
  const arc = svgNumber(maxRadius)

  if (fillRight <= x) {
    return null
  }

  if (fillWidth >= width) {
    return (
      "M " +
      svgNumber(cxLeft) +
      " " +
      svgNumber(y) +
      " H " +
      svgNumber(cxRight) +
      " A " +
      arc +
      " " +
      arc +
      " 0 0 1 " +
      svgNumber(cxRight) +
      " " +
      svgNumber(bottom) +
      " H " +
      svgNumber(cxLeft) +
      " A " +
      arc +
      " " +
      arc +
      " 0 0 1 " +
      svgNumber(cxLeft) +
      " " +
      svgNumber(y) +
      " Z"
    )
  }

  if (fillRight <= cxLeft) {
    const dx = cxLeft - fillRight
    const chordSquare = maxRadius * maxRadius - dx * dx
    if (chordSquare <= 0) {
      return null
    }

    const chord = Math.sqrt(chordSquare)
    return (
      "M " +
      svgNumber(fillRight) +
      " " +
      svgNumber(cy - chord) +
      " L " +
      svgNumber(fillRight) +
      " " +
      svgNumber(cy + chord) +
      " A " +
      arc +
      " " +
      arc +
      " 0 0 1 " +
      svgNumber(fillRight) +
      " " +
      svgNumber(cy - chord) +
      " Z"
    )
  }

  if (fillRight < cxRight) {
    return (
      "M " +
      svgNumber(cxLeft) +
      " " +
      svgNumber(y) +
      " H " +
      svgNumber(fillRight) +
      " V " +
      svgNumber(bottom) +
      " H " +
      svgNumber(cxLeft) +
      " A " +
      arc +
      " " +
      arc +
      " 0 0 1 " +
      svgNumber(cxLeft) +
      " " +
      svgNumber(y) +
      " Z"
    )
  }

  const dx = fillRight - cxRight
  const chordSquare = maxRadius * maxRadius - dx * dx
  if (chordSquare <= 0) {
    return (
      "M " +
      svgNumber(cxLeft) +
      " " +
      svgNumber(y) +
      " H " +
      svgNumber(cxRight) +
      " A " +
      arc +
      " " +
      arc +
      " 0 0 1 " +
      svgNumber(cxRight) +
      " " +
      svgNumber(bottom) +
      " H " +
      svgNumber(cxLeft) +
      " A " +
      arc +
      " " +
      arc +
      " 0 0 1 " +
      svgNumber(cxLeft) +
      " " +
      svgNumber(y) +
      " Z"
    )
  }

  const chord = Math.sqrt(chordSquare)
  return (
    "M " +
    svgNumber(cxLeft) +
    " " +
    svgNumber(y) +
    " H " +
    svgNumber(cxRight) +
    " A " +
    arc +
    " " +
    arc +
    " 0 0 1 " +
    svgNumber(fillRight) +
    " " +
    svgNumber(cy - chord) +
    " L " +
    svgNumber(fillRight) +
    " " +
    svgNumber(cy + chord) +
    " A " +
    arc +
    " " +
    arc +
    " 0 0 1 " +
    svgNumber(cxRight) +
    " " +
    svgNumber(bottom) +
    " H " +
    svgNumber(cxLeft) +
    " A " +
    arc +
    " " +
    arc +
    " 0 0 1 " +
    svgNumber(cxLeft) +
    " " +
    svgNumber(y) +
    " Z"
  )
}

function resolveShownPercent(remaining: number | null, mode: BarFillMode): number | null {
  if (remaining === null) {
    return null
  }

  if (mode === "used") {
    return clamp(100 - remaining, 0, 100)
  }

  return clamp(remaining, 0, 100)
}

function getProgressFillColor(remaining: number | null): string {
  if (remaining !== null && remaining < 10) {
    return "#d95c5c"
  }

  if (remaining !== null && remaining < 30) {
    return "#d8b24c"
  }

  return "#9bc27d"
}

function buildCursorActions(api: PublicAPI, ctx: Context, provider: CursorUsageProvider): ResultAction[] {
  return [
    {
      Id: "refresh-cursor",
      Name: "i18n:action_refresh",
      Icon: {
        ImageType: "svg",
        ImageData: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#0c4cf0" d="M12 20q-3.35 0-5.675-2.325T4 12t2.325-5.675T12 4q1.725 0 3.3.712T18 6.75V4h2v7h-7V9h4.2q-.8-1.4-2.187-2.2T12 6Q9.5 6 7.75 7.75T6 12t1.75 4.25T12 18q1.925 0 3.475-1.1T17.65 14h2.1q-.7 2.65-2.85 4.325T12 20"/></svg>`
      },
      PreventHideAfterAction: true,
      Action: async actionCtx => {
        await safeLog(api, ctx, "Info", "Refreshing Cursor usage")
        try {
          await provider.refresh(ctx, api)
        } catch (error) {
          await safeLog(api, ctx, "Warning", "Manual Cursor usage refresh failed: " + (error instanceof Error ? error.message : String(error)))
        }
        if (typeof api.RefreshQuery === "function") {
          await api.RefreshQuery(actionCtx, {
            PreserveSelectedIndex: true
          })
        }
      }
    }
  ]
}

function buildClaudeActions(api: PublicAPI, ctx: Context, provider: ClaudeUsageProvider): ResultAction[] {
  return [
    {
      Id: "refresh-claude",
      Name: "i18n:action_refresh",
      Icon: {
        ImageType: "svg",
        ImageData: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#0c4cf0" d="M12 20q-3.35 0-5.675-2.325T4 12t2.325-5.675T12 4q1.725 0 3.3.712T18 6.75V4h2v7h-7V9h4.2q-.8-1.4-2.187-2.2T12 6Q9.5 6 7.75 7.75T6 12t1.75 4.25T12 18q1.925 0 3.475-1.1T17.65 14h2.1q-.7 2.65-2.85 4.325T12 20"/></svg>`
      },
      PreventHideAfterAction: true,
      Action: async actionCtx => {
        await safeLog(api, ctx, "Info", "Refreshing Claude usage")
        try {
          await provider.refresh(ctx, api)
        } catch (error) {
          await safeLog(api, ctx, "Warning", "Manual Claude usage refresh failed: " + (error instanceof Error ? error.message : String(error)))
        }
        if (typeof api.RefreshQuery === "function") {
          await api.RefreshQuery(actionCtx, {
            PreserveSelectedIndex: true
          })
        }
      }
    }
  ]
}

function buildGrokActions(api: PublicAPI, ctx: Context, provider: GrokUsageProvider): ResultAction[] {
  return [
    {
      Id: "refresh-grok",
      Name: "i18n:action_refresh",
      Icon: {
        ImageType: "svg",
        ImageData: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#0c4cf0" d="M12 20q-3.35 0-5.675-2.325T4 12t2.325-5.675T12 4q1.725 0 3.3.712T18 6.75V4h2v7h-7V9h4.2q-.8-1.4-2.187-2.2T12 6Q9.5 6 7.75 7.75T6 12t1.75 4.25T12 18q1.925 0 3.475-1.1T17.65 14h2.1q-.7 2.65-2.85 4.325T12 20"/></svg>`
      },
      PreventHideAfterAction: true,
      Action: async actionCtx => {
        await safeLog(api, ctx, "Info", "Refreshing Grok usage")
        try {
          await provider.refresh(ctx, api)
        } catch (error) {
          await safeLog(api, ctx, "Warning", "Manual Grok usage refresh failed: " + (error instanceof Error ? error.message : String(error)))
        }
        if (typeof api.RefreshQuery === "function") {
          await api.RefreshQuery(actionCtx, {
            PreserveSelectedIndex: true
          })
        }
      }
    }
  ]
}

function buildCommonActions(summaryText: string, rawText: string, api: PublicAPI, ctx: Context, provider: UsageProvider): ResultAction[] {
  return [
    {
      Id: "refresh",
      Name: "i18n:action_refresh",
      Icon: {
        ImageType: "svg",
        ImageData: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#0c4cf0" d="M12 20q-3.35 0-5.675-2.325T4 12t2.325-5.675T12 4q1.725 0 3.3.712T18 6.75V4h2v7h-7V9h4.2q-.8-1.4-2.187-2.2T12 6Q9.5 6 7.75 7.75T6 12t1.75 4.25T12 18q1.925 0 3.475-1.1T17.65 14h2.1q-.7 2.65-2.85 4.325T12 20"/></svg>`
      },
      PreventHideAfterAction: true,
      Action: async actionCtx => {
        await safeLog(api, ctx, "Info", "Refreshing Codex usage")
        try {
          await provider.refresh(ctx, api)
        } catch (error) {
          await safeLog(api, ctx, "Warning", "Manual Codex usage refresh failed: " + (error instanceof Error ? error.message : String(error)))
        }
        if (typeof api.RefreshQuery === "function") {
          await api.RefreshQuery(actionCtx, {
            PreserveSelectedIndex: true
          })
        }
      }
    }
  ]
}

function buildCursorErrorResult(message: string, api: PublicAPI, ctx: Context, provider: CursorUsageProvider): Result {
  return {
    Id: "cursor-usage-error",
    Title: "i18n:cursor_error_title",
    SubTitle: message,
    Icon: CURSOR_ICON,
    Group: DEFAULT_LOCALE_STRINGS.groupCursor,
    GroupScore: 90,
    Score: 90,
    Actions: [
      {
        Id: "copy-cursor-error",
        Name: "i18n:action_copy_error",
        IsDefault: true,
        Action: async actionCtx => {
          await api.Copy(actionCtx, {
            type: "text",
            text: message
          })
        }
      },
      {
        Id: "refresh-cursor-error",
        Name: "i18n:action_retry",
        PreventHideAfterAction: true,
        Action: async actionCtx => {
          await safeLog(api, ctx, "Warning", "Retrying Cursor usage fetch after error")
          try {
            await provider.refresh(ctx, api)
          } catch (error) {
            await safeLog(api, ctx, "Warning", "Cursor usage retry failed: " + (error instanceof Error ? error.message : String(error)))
          }
          if (typeof api.RefreshQuery === "function") {
            await api.RefreshQuery(actionCtx, {
              PreserveSelectedIndex: false
            })
          }
        }
      }
    ]
  }
}

function buildClaudeErrorResult(message: string, api: PublicAPI, ctx: Context, provider: ClaudeUsageProvider): Result {
  return {
    Id: "claude-usage-error",
    Title: "i18n:claude_error_title",
    SubTitle: message,
    Icon: CLAUDE_ICON,
    Group: DEFAULT_LOCALE_STRINGS.groupClaude,
    GroupScore: 95,
    Score: 95,
    Actions: [
      {
        Id: "copy-claude-error",
        Name: "i18n:action_copy_error",
        IsDefault: true,
        Action: async actionCtx => {
          await api.Copy(actionCtx, {
            type: "text",
            text: message
          })
        }
      },
      {
        Id: "refresh-claude-error",
        Name: "i18n:action_retry",
        PreventHideAfterAction: true,
        Action: async actionCtx => {
          await safeLog(api, ctx, "Warning", "Retrying Claude usage fetch after error")
          try {
            await provider.refresh(ctx, api)
          } catch (error) {
            await safeLog(api, ctx, "Warning", "Claude usage retry failed: " + (error instanceof Error ? error.message : String(error)))
          }
          if (typeof api.RefreshQuery === "function") {
            await api.RefreshQuery(actionCtx, {
              PreserveSelectedIndex: false
            })
          }
        }
      }
    ]
  }
}

function buildGrokErrorResult(message: string, api: PublicAPI, ctx: Context, provider: GrokUsageProvider): Result {
  return {
    Id: "grok-usage-error",
    Title: "i18n:grok_error_title",
    SubTitle: message,
    Icon: GROK_ICON,
    Group: DEFAULT_LOCALE_STRINGS.groupGrok,
    GroupScore: 80,
    Score: 80,
    Actions: [
      {
        Id: "copy-grok-error",
        Name: "i18n:action_copy_error",
        IsDefault: true,
        Action: async actionCtx => {
          await api.Copy(actionCtx, {
            type: "text",
            text: message
          })
        }
      },
      {
        Id: "refresh-grok-error",
        Name: "i18n:action_retry",
        PreventHideAfterAction: true,
        Action: async actionCtx => {
          await safeLog(api, ctx, "Warning", "Retrying Grok usage fetch after error")
          try {
            await provider.refresh(ctx, api)
          } catch (error) {
            await safeLog(api, ctx, "Warning", "Grok usage retry failed: " + (error instanceof Error ? error.message : String(error)))
          }
          if (typeof api.RefreshQuery === "function") {
            await api.RefreshQuery(actionCtx, {
              PreserveSelectedIndex: false
            })
          }
        }
      }
    ]
  }
}

function buildErrorResult(message: string, api: PublicAPI, ctx: Context, provider: UsageProvider): Result {
  return {
    Id: "codex-usage-error",
    Title: "i18n:error_title",
    SubTitle: message,
    Icon: CODEX_ICON,
    Group: DEFAULT_LOCALE_STRINGS.groupCodex,
    GroupScore: 100,
    Score: 100,
    Actions: [
      {
        Id: "copy-error",
        Name: "i18n:action_copy_error",
        IsDefault: true,
        Action: async actionCtx => {
          await api.Copy(actionCtx, {
            type: "text",
            text: message
          })
        }
      },
      {
        Id: "refresh-error",
        Name: "i18n:action_retry",
        PreventHideAfterAction: true,
        Action: async actionCtx => {
          await safeLog(api, ctx, "Warning", "Retrying Codex usage fetch after error")
          try {
            await provider.refresh(ctx, api)
          } catch (error) {
            await safeLog(api, ctx, "Warning", "Codex usage retry failed: " + (error instanceof Error ? error.message : String(error)))
          }
          if (typeof api.RefreshQuery === "function") {
            await api.RefreshQuery(actionCtx, {
              PreserveSelectedIndex: false
            })
          }
        }
      }
    ]
  }
}

function buildSummaryText(snapshot: CodexUsageSnapshot, strings: LocaleStrings, subtitle: string): string {
  const lines: string[] = []

  lines.push("Codex Usage")
  lines.push(subtitle)

  const windows = listCodexWindows(snapshot.rateLimits)
  const labels = toCodexWindowLabels(strings)
  for (let index = 0; index < windows.length; index += 1) {
    lines.push(buildDetailedWindowLine(resolveCodexWindowLabel(windows[index], labels), windows[index], strings))
  }

  if (snapshot.warnings.length > 0) {
    lines.push(formatTemplate(strings.summaryWarnings, snapshot.warnings.join(" | ")))
  }

  return lines.join("\n")
}

function toCodexWindowLabels(strings: LocaleStrings): CodexWindowLabels {
  return {
    week: strings.windowWeek,
    day: strings.windowDay,
    fiveHour: strings.windowFiveHour,
    hourSuffix: strings.unitHourShort,
    minuteSuffix: strings.unitMinuteShort,
    fallback: strings.windowLimit
  }
}

function buildDetailedWindowLine(label: string, window: RateLimitWindowInfo, strings: LocaleStrings): string {
  return formatTemplate(strings.summaryLine, label, formatRemainingPercent(window), formatRelativeReset(window, strings))
}

function formatRelativeReset(window: RateLimitWindowInfo | null, strings: LocaleStrings): string {
  if (window === null) {
    return strings.timeUnknown
  }

  return formatRelativeResetAt(window.resetsAt, strings)
}

function formatRelativeResetAt(epochSeconds: number | null, strings: LocaleStrings): string {
  if (epochSeconds === null) {
    return strings.timeUnknown
  }

  const diffMs = epochSeconds * 1000 - Date.now()
  if (diffMs <= 0) {
    return strings.timeSoon
  }

  const totalMinutes = Math.floor(diffMs / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []

  if (days > 0) {
    parts.push(String(days) + strings.unitDayShort)
  }

  if (hours > 0 && parts.length < 2) {
    parts.push(String(hours) + strings.unitHourShort)
  }

  if (minutes > 0 && parts.length < 2) {
    parts.push(String(minutes) + strings.unitMinuteShort)
  }

  if (parts.length === 0) {
    return strings.timeSoon
  }

  return parts.join(strings.durationJoiner)
}

function formatRemainingPercent(window: RateLimitWindowInfo | null): string {
  const remaining = getRemainingPercent(window)
  return remaining === null ? "--" : String(remaining) + "%"
}

function getRemainingPercent(window: RateLimitWindowInfo | null): number | null {
  if (window === null) {
    return null
  }

  return Math.max(0, 100 - window.usedPercent)
}

async function readLocaleStrings(api: PublicAPI, ctx: Context): Promise<LocaleStrings> {
  return {
    subtitleNoLiveData: await translate(api, ctx, "subtitle_no_live_data", DEFAULT_LOCALE_STRINGS.subtitleNoLiveData),
    subtitleFallback: await translate(api, ctx, "subtitle_fallback", DEFAULT_LOCALE_STRINGS.subtitleFallback),
    subtitleResetIn: await translate(api, ctx, "subtitle_reset_in", DEFAULT_LOCALE_STRINGS.subtitleResetIn),
    windowWeek: await translate(api, ctx, "window_week", DEFAULT_LOCALE_STRINGS.windowWeek),
    windowMonth: await translate(api, ctx, "window_month", DEFAULT_LOCALE_STRINGS.windowMonth),
    windowDay: await translate(api, ctx, "window_day", DEFAULT_LOCALE_STRINGS.windowDay),
    windowFiveHour: await translate(api, ctx, "window_five_hour", DEFAULT_LOCALE_STRINGS.windowFiveHour),
    windowLimit: await translate(api, ctx, "window_limit", DEFAULT_LOCALE_STRINGS.windowLimit),
    windowCursorModels: await translate(api, ctx, "window_cursor_models", DEFAULT_LOCALE_STRINGS.windowCursorModels),
    windowOtherModels: await translate(api, ctx, "window_other_models", DEFAULT_LOCALE_STRINGS.windowOtherModels),
    windowRequests: await translate(api, ctx, "window_requests", DEFAULT_LOCALE_STRINGS.windowRequests),
    summaryLine: await translate(api, ctx, "summary_line", DEFAULT_LOCALE_STRINGS.summaryLine),
    summaryWarnings: await translate(api, ctx, "summary_warnings", DEFAULT_LOCALE_STRINGS.summaryWarnings),
    cursorMonthReset: await translate(api, ctx, "cursor_month_reset", DEFAULT_LOCALE_STRINGS.cursorMonthReset),
    cursorRequestsLeft: await translate(api, ctx, "cursor_requests_left", DEFAULT_LOCALE_STRINGS.cursorRequestsLeft),
    cursorNoLiveData: await translate(api, ctx, "cursor_no_live_data", DEFAULT_LOCALE_STRINGS.cursorNoLiveData),
    cursorNotSignedIn: await translate(api, ctx, "cursor_not_signed_in", DEFAULT_LOCALE_STRINGS.cursorNotSignedIn),
    cursorNotFound: await translate(api, ctx, "cursor_not_found", DEFAULT_LOCALE_STRINGS.cursorNotFound),
    grokPeriodReset: await translate(api, ctx, "grok_period_reset", DEFAULT_LOCALE_STRINGS.grokPeriodReset),
    grokBotWeekReset: await translate(api, ctx, "grok_bot_week_reset", DEFAULT_LOCALE_STRINGS.grokBotWeekReset),
    grokNoLiveData: await translate(api, ctx, "grok_no_live_data", DEFAULT_LOCALE_STRINGS.grokNoLiveData),
    grokNotSignedIn: await translate(api, ctx, "grok_not_signed_in", DEFAULT_LOCALE_STRINGS.grokNotSignedIn),
    grokNotFound: await translate(api, ctx, "grok_not_found", DEFAULT_LOCALE_STRINGS.grokNotFound),
    claudeNoLiveData: await translate(api, ctx, "claude_no_live_data", DEFAULT_LOCALE_STRINGS.claudeNoLiveData),
    claudeNotSignedIn: await translate(api, ctx, "claude_not_signed_in", DEFAULT_LOCALE_STRINGS.claudeNotSignedIn),
    claudeNotFound: await translate(api, ctx, "claude_not_found", DEFAULT_LOCALE_STRINGS.claudeNotFound),
    claudeExtraUsage: await translate(api, ctx, "claude_extra_usage", DEFAULT_LOCALE_STRINGS.claudeExtraUsage),
    namedUsageTitle: await translate(api, ctx, "named_usage_title", DEFAULT_LOCALE_STRINGS.namedUsageTitle),
    planResetIn: await translate(api, ctx, "plan_reset_in", DEFAULT_LOCALE_STRINGS.planResetIn),
    groupCodex: await translate(api, ctx, "group_codex", DEFAULT_LOCALE_STRINGS.groupCodex),
    groupClaude: await translate(api, ctx, "group_claude", DEFAULT_LOCALE_STRINGS.groupClaude),
    groupCursor: await translate(api, ctx, "group_cursor", DEFAULT_LOCALE_STRINGS.groupCursor),
    groupGrok: await translate(api, ctx, "group_grok", DEFAULT_LOCALE_STRINGS.groupGrok),
    windowClaudeSession: await translate(api, ctx, "window_claude_session", DEFAULT_LOCALE_STRINGS.windowClaudeSession),
    windowClaudeWeek: await translate(api, ctx, "window_claude_week", DEFAULT_LOCALE_STRINGS.windowClaudeWeek),
    windowClaudeExtra: await translate(api, ctx, "window_claude_extra", DEFAULT_LOCALE_STRINGS.windowClaudeExtra),
    windowCursorModelsTitle: await translate(api, ctx, "window_cursor_models_title", DEFAULT_LOCALE_STRINGS.windowCursorModelsTitle),
    windowOtherModelsTitle: await translate(api, ctx, "window_other_models_title", DEFAULT_LOCALE_STRINGS.windowOtherModelsTitle),
    windowRequestsTitle: await translate(api, ctx, "window_requests_title", DEFAULT_LOCALE_STRINGS.windowRequestsTitle),
    windowGrokBuild: await translate(api, ctx, "window_grok_build", DEFAULT_LOCALE_STRINGS.windowGrokBuild),
    windowGrokChat: await translate(api, ctx, "window_grok_chat", DEFAULT_LOCALE_STRINGS.windowGrokChat),
    windowGrokBot: await translate(api, ctx, "window_grok_bot", DEFAULT_LOCALE_STRINGS.windowGrokBot),
    timeUnknown: await translate(api, ctx, "time_unknown", DEFAULT_LOCALE_STRINGS.timeUnknown),
    timeSoon: await translate(api, ctx, "time_soon", DEFAULT_LOCALE_STRINGS.timeSoon),
    unitDayShort: await translate(api, ctx, "unit_day_short", DEFAULT_LOCALE_STRINGS.unitDayShort),
    unitHourShort: await translate(api, ctx, "unit_hour_short", DEFAULT_LOCALE_STRINGS.unitHourShort),
    unitMinuteShort: await translate(api, ctx, "unit_minute_short", DEFAULT_LOCALE_STRINGS.unitMinuteShort),
    durationJoiner: await translate(api, ctx, "duration_joiner", DEFAULT_LOCALE_STRINGS.durationJoiner)
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

async function readBarFillMode(api: PublicAPI, ctx: Context): Promise<BarFillMode> {
  const raw = await readStringSetting(api, ctx, "barFillsAsUsed", "false")
  if (raw.toLowerCase() === "true") {
    return "used"
  }

  return DEFAULT_BAR_FILL_MODE
}

async function translate(api: PublicAPI, ctx: Context, key: string, fallback: string): Promise<string> {
  if (typeof api.GetTranslation !== "function") {
    return fallback
  }

  try {
    const value = await api.GetTranslation(ctx, key)
    if (typeof value === "string" && value.length > 0) {
      return value
    }
  } catch {
    return fallback
  }

  return fallback
}

function formatTemplate(template: string, ...values: string[]): string {
  let result = template

  for (let index = 0; index < values.length; index += 1) {
    result = result.replace("%s", values[index])
  }

  return result
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}

async function safeLog(api: PublicAPI, ctx: Context, level: "Info" | "Warning" | "Error" | "Debug", message: string): Promise<void> {
  if (typeof api.Log !== "function") {
    return
  }

  try {
    await api.Log(ctx, level, message)
  } catch {
    return
  }
}
