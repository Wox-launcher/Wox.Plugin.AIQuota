import { join } from "path"

import {
  formatMembershipType,
  formatUsdFromCents,
  getCursorModelRemainingPercent,
  getOtherModelRemainingPercent,
  getPlanRemainingPercent,
  isJwtExpired,
  readLegacyRequestUsage,
  getGrokBotRemainingPercent,
  readPeriodUsage,
  readPlanInfo,
  readPlanUsage,
  readSandUsage,
  shouldShowCursorResult,
  shouldShowGrokBotResult
} from "./cursor-usage"
import { resolveCursorStateDbPath } from "./platform/shared"
import { resolveUsageFilter, shouldForceRefresh } from "./index"

describe("readPlanUsage", () => {
  test("derives remaining from limit and included spend when remaining is omitted", () => {
    const usage = readPlanUsage({
      includedSpend: 23222,
      limit: 40000,
      totalPercentUsed: 15.48,
      apiPercentUsed: 46.444
    })

    expect(usage).toEqual({
      usedCents: 23222,
      remainingCents: 16778,
      limitCents: 40000,
      includedSpendCents: 23222,
      bonusSpendCents: null,
      totalPercentUsed: 15.48,
      autoPercentUsed: null,
      apiPercentUsed: 46.444
    })
  })

  test("uses limit minus remaining when included spend is missing", () => {
    const usage = readPlanUsage({
      limit: 2000,
      remaining: 500
    })

    expect(usage).not.toBeNull()
    expect(usage?.usedCents).toBe(1500)
    expect(usage?.remainingCents).toBe(500)
  })
})

describe("readPeriodUsage", () => {
  test("reads billing cycle timestamps published as millisecond strings", () => {
    const period = readPeriodUsage({
      billingCycleStart: "1768399334000",
      billingCycleEnd: "1771077734000",
      planUsage: {
        includedSpend: 100,
        remaining: 1900,
        limit: 2000
      },
      displayMessage: "You've used 5% of your usage limit"
    })

    expect(period.billingCycleStart).toBe(1768399334)
    expect(period.billingCycleEnd).toBe(1771077734)
    expect(period.planUsage?.usedCents).toBe(100)
    expect(period.displayMessage).toBe("You've used 5% of your usage limit")
  })
})

describe("readPlanInfo", () => {
  test("reads plan name and included amount", () => {
    expect(
      readPlanInfo({
        planInfo: {
          planName: "Ultra",
          includedAmountCents: 40000,
          price: "$200/mo"
        }
      })
    ).toEqual({
      planName: "Ultra",
      planPrice: "$200/mo",
      includedAmountCents: 40000,
      billingCycleEnd: null
    })
  })
})

describe("readLegacyRequestUsage", () => {
  test("reads the gpt-4 request bucket", () => {
    expect(
      readLegacyRequestUsage({
        "gpt-4": {
          numRequests: 120,
          maxRequestUsage: 500
        }
      })
    ).toEqual({
      used: 120,
      max: 500,
      percentUsed: 24
    })
  })
})

describe("readSandUsage", () => {
  test("reads the weekly Grok Bot allowance", () => {
    const usage = readSandUsage({
      currentPeriodStart: "2026-08-17T07:57:50.647Z",
      nextResetTimestampUtc: "2026-08-24T07:57:50.647Z",
      usagePercent: 12,
      hasAvailableUsage: true,
      hasNonZeroIncludedLimit: true
    })

    expect(usage).toEqual({
      usagePercent: 12,
      periodStart: 1786953470,
      resetAt: 1787558270
    })
    expect(getGrokBotRemainingPercent(usage)).toBe(88)
  })

  test("hides accounts without an included Grok Bot limit", () => {
    expect(
      readSandUsage({
        usagePercent: 100,
        hasNonZeroIncludedLimit: false
      })
    ).toBeNull()
  })

  test("shows a Grok Bot result only for all or grok queries", () => {
    const snapshot = {
      fetchedAt: 1,
      availability: "ready" as const,
      source: "dashboard" as const,
      planName: "Ultra",
      planPrice: null,
      membershipType: "ultra",
      email: null,
      billingCycleStart: null,
      billingCycleEnd: null,
      planUsage: null,
      spendLimit: null,
      requestUsage: null,
      sandUsage: {
        usagePercent: 12,
        periodStart: 1786953470,
        resetAt: 1787558270
      },
      displayMessage: null,
      warnings: []
    }

    expect(shouldShowGrokBotResult(snapshot, "all")).toBe(true)
    expect(shouldShowGrokBotResult(snapshot, "grok")).toBe(true)
    expect(shouldShowGrokBotResult(snapshot, "cursor")).toBe(false)
    expect(shouldShowGrokBotResult({ ...snapshot, sandUsage: null }, "all")).toBe(false)
  })
})

describe("cursor display helpers", () => {
  test("formats cents as USD", () => {
    expect(formatUsdFromCents(16778)).toBe("$167.78")
    expect(formatUsdFromCents(0)).toBe("$0.00")
  })

  test("formats membership types", () => {
    expect(formatMembershipType("pro_plus")).toBe("Pro+")
    expect(formatMembershipType("ultra")).toBe("Ultra")
    expect(formatMembershipType(null)).toBeNull()
  })

  test("maps auto and api percents to Cursor Models and Other Models remaining", () => {
    const usage = {
      usedCents: 0,
      remainingCents: 0,
      limitCents: 0,
      includedSpendCents: 0,
      bonusSpendCents: 0,
      totalPercentUsed: 15.48,
      autoPercentUsed: 48,
      apiPercentUsed: 63
    }

    expect(getCursorModelRemainingPercent(usage)).toBe(52)
    expect(getOtherModelRemainingPercent(usage)).toBe(37)
  })

  test("computes remaining plan percent from included allowance", () => {
    expect(
      getPlanRemainingPercent({
        usedCents: 23222,
        remainingCents: 16778,
        limitCents: 40000,
        includedSpendCents: 23222,
        bonusSpendCents: 0,
        totalPercentUsed: 15.48,
        autoPercentUsed: null,
        apiPercentUsed: 46.444
      })
    ).toBe(42)
  })

  test("hides pending cursor results unless the query asked for cursor", () => {
    const pending = {
      fetchedAt: 1,
      availability: "pending" as const,
      source: "local-fallback" as const,
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

    expect(shouldShowCursorResult(pending, "all")).toBe(false)
    expect(shouldShowCursorResult(pending, "cursor")).toBe(true)
    expect(shouldShowCursorResult({ ...pending, availability: "ready" }, "all")).toBe(true)
  })
})

describe("isJwtExpired", () => {
  test("treats tokens without exp as not expired", () => {
    expect(isJwtExpired("not-a-jwt", 0)).toBe(false)
  })

  test("detects expired jwt payloads", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1 }), "utf8").toString("base64")
    expect(isJwtExpired("header." + payload + ".sig", 0)).toBe(true)
  })
})

describe("resolveCursorStateDbPath", () => {
  test("uses APPDATA on Windows", () => {
    expect(resolveCursorStateDbPath("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me")).toBe(
      join("C:\\Users\\me\\AppData\\Roaming", "Cursor", "User", "globalStorage", "state.vscdb")
    )
  })

  test("uses Application Support on macOS", () => {
    expect(resolveCursorStateDbPath("darwin", {}, "/Users/me")).toBe(join("/Users/me", "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"))
  })
})

describe("query filters", () => {
  test("force refresh accepts trailing refresh after a provider name", () => {
    expect(shouldForceRefresh("refresh")).toBe(true)
    expect(shouldForceRefresh("cursor refresh")).toBe(true)
    expect(shouldForceRefresh("status")).toBe(false)
  })

  test("resolves cursor and codex filters from command or search", () => {
    expect(resolveUsageFilter({ Search: "", Command: "cursor" })).toBe("cursor")
    expect(resolveUsageFilter({ Search: "codex" })).toBe("codex")
    expect(resolveUsageFilter({ Search: "" })).toBe("all")
  })
})
