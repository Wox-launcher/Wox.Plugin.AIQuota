import { join } from "path"

import {
  formatClaudePlanName,
  formatUsdFromCents,
  getClaudeExtraRemainingPercent,
  getClaudeRemainingPercent,
  isOauthExpired,
  listClaudeDisplayWindows,
  mergeClaudeOauth,
  readClaudeOauth,
  readClaudeUsage,
  shouldShowClaudeReset,
  shouldShowClaudeResult,
  shortModelLabel
} from "./claude-usage"
import { includesProvider, resolveUsageFilter } from "./index"
import { resolveClaudeHome } from "./platform/shared"

describe("readClaudeUsage", () => {
  test("reads the modern limits array and extra usage", () => {
    const usage = readClaudeUsage({
      five_hour: { utilization: 15.0, resets_at: "2026-07-03T22:09:59.594819+00:00" },
      seven_day: { utilization: 40.0, resets_at: "2026-07-09T10:59:59.594840+00:00" },
      limits: [
        { kind: "session", group: "session", percent: 15, resets_at: "2026-07-03T22:09:59.594819+00:00" },
        { kind: "weekly_all", group: "weekly", percent: 40, resets_at: "2026-07-09T10:59:59.594840+00:00" },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 60,
          resets_at: "2026-07-09T10:59:59.595109+00:00",
          scope: { model: { id: null, display_name: "Fable" } },
          is_active: true
        }
      ],
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100000,
        used_credits: 4132,
        utilization: null
      }
    })

    expect(usage.windows.map(window => window.kind)).toEqual(["session", "weekly", "scoped"])
    expect(usage.windows[0].usedPercent).toBe(15)
    expect(usage.windows[1].usedPercent).toBe(40)
    expect(usage.windows[2].label).toBe("Fable")
    expect(usage.windows[2].usedPercent).toBe(60)
    expect(usage.windows[0].resetsAt).toBe(Math.floor(Date.parse("2026-07-03T22:09:59.594819+00:00") / 1000))
    expect(usage.extraUsage).toEqual({
      enabled: true,
      usedCents: 4132,
      limitCents: 100000,
      utilization: null
    })
    expect(getClaudeRemainingPercent(usage.windows[0].usedPercent)).toBe(85)
    expect(getClaudeExtraRemainingPercent(usage.extraUsage)).toBe(96)
  })

  test("falls back to the legacy five_hour and seven_day buckets", () => {
    const usage = readClaudeUsage({
      five_hour: { utilization: 35.0, resets_at: "2026-02-06T22:00:00+00:00" },
      seven_day: { utilization: 14.0, resets_at: "2026-02-12T20:00:00+00:00" },
      seven_day_sonnet: { utilization: 39.0, resets_at: "2026-02-09T14:00:00+00:00" },
      seven_day_opus: null,
      extra_usage: {
        is_enabled: false,
        monthly_limit: 0,
        used_credits: 0
      }
    })

    expect(usage.windows).toEqual([
      {
        kind: "session",
        label: "Session",
        usedPercent: 35,
        resetsAt: Math.floor(Date.parse("2026-02-06T22:00:00+00:00") / 1000)
      },
      {
        kind: "weekly",
        label: "Week",
        usedPercent: 14,
        resetsAt: Math.floor(Date.parse("2026-02-12T20:00:00+00:00") / 1000)
      },
      {
        kind: "scoped",
        label: "Sonnet",
        usedPercent: 39,
        resetsAt: Math.floor(Date.parse("2026-02-09T14:00:00+00:00") / 1000)
      }
    ])
  })

  test("scales fractional utilization values to percents", () => {
    const usage = readClaudeUsage({
      five_hour: { utilization: 0.35 },
      seven_day: { utilization: 0.14 }
    })

    expect(usage.windows[0].usedPercent).toBe(35)
    expect(usage.windows[1].usedPercent).toBe(14)
  })

  test("drops scoped limits that have no model name", () => {
    const usage = readClaudeUsage({
      limits: [
        { kind: "session", percent: 10 },
        { kind: "weekly_all", percent: 20 },
        { kind: "weekly_scoped", percent: 55 }
      ]
    })

    expect(usage.windows.map(window => window.kind)).toEqual(["session", "weekly"])
  })

  test("reads spend credits when extra_usage is absent", () => {
    const usage = readClaudeUsage({
      spend: {
        used: { amount_minor: 500, currency: "USD", exponent: 2 },
        balance: { amount_minor: 100000, currency: "USD", exponent: 2 },
        enabled: true
      }
    })

    expect(usage.extraUsage).toEqual({
      enabled: true,
      usedCents: 500,
      limitCents: 100000,
      utilization: null
    })
    expect(formatUsdFromCents(500)).toBe("$5.00")
  })
})

describe("readClaudeOauth", () => {
  test("reads the claudeAiOauth block used by Claude Code", () => {
    const oauth = readClaudeOauth({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-token",
        refreshToken: "sk-ant-ort01-refresh",
        expiresAt: 1770412938485,
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_5x",
        scopes: ["user:profile", "user:inference"]
      }
    })

    expect(oauth).toEqual({
      accessToken: "sk-ant-oat01-token",
      refreshToken: "sk-ant-ort01-refresh",
      expiresAt: 1770412938485,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_5x",
      scopes: ["user:profile", "user:inference"]
    })
  })

  test("returns null when no bearer token is present", () => {
    expect(readClaudeOauth({ claudeAiOauth: { subscriptionType: "pro" } })).toBeNull()
  })
})

describe("claude display helpers", () => {
  test("formats plan names from rateLimitTier and subscriptionType", () => {
    expect(formatClaudePlanName("default_claude_max_20x", "max")).toBe("Max 20x")
    expect(formatClaudePlanName("default_claude_pro", null)).toBe("Pro")
    expect(formatClaudePlanName(null, "team")).toBe("Team")
    expect(formatClaudePlanName(null, null)).toBe("Claude")
  })

  test("shortens scoped model labels for progress bars", () => {
    expect(shortModelLabel("Claude Opus 4.5")).toBe("Opus")
    expect(shortModelLabel("Fable")).toBe("Fable")
    expect(shortModelLabel("Sonnet")).toBe("Sonnet")
  })

  test("hides reset text when a window is unused or has no reset time", () => {
    expect(shouldShowClaudeReset({ usedPercent: 0, resetsAt: 1 })).toBe(false)
    expect(shouldShowClaudeReset({ usedPercent: 12, resetsAt: null })).toBe(false)
    expect(shouldShowClaudeReset({ usedPercent: 98, resetsAt: 1 })).toBe(true)
  })

  test("lists session, week, and every scoped window for split results", () => {
    const windows = listClaudeDisplayWindows([
      { kind: "session", label: "Session", usedPercent: 15, resetsAt: 1 },
      { kind: "weekly", label: "Week", usedPercent: 40, resetsAt: 2 },
      { kind: "scoped", label: "Haiku", usedPercent: 20, resetsAt: 3 },
      { kind: "scoped", label: "Opus", usedPercent: 60, resetsAt: 4 }
    ])

    expect(windows.map(window => window.label)).toEqual(["Session", "Week", "Opus", "Haiku"])
  })

  test("hides pending claude results until the first fetch finishes", () => {
    const pending = {
      fetchedAt: 1,
      availability: "pending" as const,
      source: "local-fallback" as const,
      planName: null,
      windows: [],
      extraUsage: null,
      warnings: []
    }

    expect(shouldShowClaudeResult(pending, "all")).toBe(false)
    expect(shouldShowClaudeResult(pending, "claude")).toBe(false)
    expect(shouldShowClaudeResult({ ...pending, availability: "ready" }, "all")).toBe(true)
  })

  test("treats tokens without expiry as not expired", () => {
    expect(isOauthExpired(null, 0)).toBe(false)
  })
})

describe("mergeClaudeOauth", () => {
  test("preserves unrelated credential fields while rotating tokens", () => {
    const merged = mergeClaudeOauth(
      {
        mcpOAuth: { token: "keep-me" },
        claudeAiOauth: {
          accessToken: "old",
          refreshToken: "old-refresh",
          subscriptionType: "max"
        }
      },
      {
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresAt: 1000,
        subscriptionType: "max",
        rateLimitTier: null,
        scopes: ["user:inference"]
      }
    )

    expect(merged.mcpOAuth).toEqual({ token: "keep-me" })
    expect(merged.claudeAiOauth).toEqual({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      subscriptionType: "max",
      expiresAt: 1000,
      scopes: ["user:inference"]
    })
  })
})

describe("resolveClaudeHome", () => {
  test("uses CLAUDE_CONFIG_DIR when set", () => {
    expect(resolveClaudeHome({ CLAUDE_CONFIG_DIR: "D:\\claude-home" }, "C:\\Users\\me")).toBe("D:\\claude-home")
  })

  test("falls back to ~/.claude", () => {
    expect(resolveClaudeHome({}, "/Users/me")).toBe(join("/Users/me", ".claude"))
  })
})

describe("provider filter", () => {
  test("resolves claude from command or search", () => {
    expect(resolveUsageFilter({ Search: "", Command: "claude" })).toBe("claude")
    expect(resolveUsageFilter({ Search: "claude refresh" })).toBe("claude")
    expect(resolveUsageFilter({ Search: "" })).toBe("all")
  })

  test("keeps a claude-only filter from showing the other providers", () => {
    expect(includesProvider("claude", "codex")).toBe(false)
    expect(includesProvider("claude", "cursor")).toBe(false)
    expect(includesProvider("claude", "grok")).toBe(false)
    expect(includesProvider("claude", "claude")).toBe(true)
    expect(includesProvider("all", "claude")).toBe(true)
  })
})
