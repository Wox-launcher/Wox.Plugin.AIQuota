import { join } from "path"

import { formatGrokPlanName, getGrokRemainingPercent, readGrokAuthFile, readGrokBilling, readGrokSettings, shouldShowGrokResult } from "./grok-usage"
import { includesProvider, resolveUsageFilter } from "./index"
import { resolveGrokHome } from "./platform/shared"

describe("readGrokBilling", () => {
  test("reads the SuperGrok weekly credits payload", () => {
    const billing = readGrokBilling({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-08-17T17:33:48.278812+00:00",
          end: "2026-08-24T17:33:48.278812+00:00"
        },
        creditUsagePercent: 1.0,
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        productUsage: [{ product: "GrokBuild", usagePercent: 1.0 }],
        prepaidBalance: { val: 0 },
        billingPeriodStart: "2026-08-17T17:33:48.278812+00:00",
        billingPeriodEnd: "2026-08-24T17:33:48.278812+00:00"
      }
    })

    expect(billing.periodType).toBe("weekly")
    expect(billing.creditUsagePercent).toBe(1)
    expect(billing.billingCycleEnd).toBe(Math.floor(Date.parse("2026-08-24T17:33:48.278812+00:00") / 1000))
    expect(billing.productUsage).toEqual([{ product: "GrokBuild", usagePercent: 1 }])
    expect(getGrokRemainingPercent(billing.creditUsagePercent)).toBe(99)
  })

  test("treats 100 percent used as nothing remaining", () => {
    expect(getGrokRemainingPercent(100)).toBe(0)
  })
})

describe("readGrokAuthFile", () => {
  test("prefers the auth.x.ai SuperGrok entry", () => {
    const auth = readGrokAuthFile({
      "https://accounts.x.ai/sign-in": {
        key: "legacy-token",
        email: "old@example.com"
      },
      "https://auth.x.ai::client": {
        key: "supergrok-token",
        email: "user@example.com",
        auth_mode: "supergrok"
      }
    })

    expect(auth).not.toBeNull()
    expect(auth?.email).toBe("user@example.com")
    expect(auth?.authMode).toBe("supergrok")
    expect(auth?.accessToken).toBe("supergrok-token")
  })

  test("returns null when no bearer token is present", () => {
    expect(readGrokAuthFile({ email: "user@example.com" })).toBeNull()
  })
})

describe("grok display helpers", () => {
  test("reads the settings tier overlay", () => {
    expect(readGrokSettings({ subscription_tier_display: "SuperGrok Heavy" })).toBe("SuperGrok Heavy")
  })

  test("formats plan names", () => {
    expect(formatGrokPlanName("supergrok_heavy")).toBe("SuperGrok Heavy")
    expect(formatGrokPlanName(null)).toBe("SuperGrok")
  })

  test("hides pending grok results unless the query asked for grok", () => {
    const pending = {
      fetchedAt: 1,
      availability: "pending" as const,
      source: "local-fallback" as const,
      planName: null,
      email: null,
      periodType: "unknown" as const,
      creditUsagePercent: null,
      billingCycleStart: null,
      billingCycleEnd: null,
      prepaidBalanceCents: null,
      onDemandUsedCents: null,
      onDemandCapCents: null,
      productUsage: [],
      warnings: []
    }

    expect(shouldShowGrokResult(pending, "all")).toBe(false)
    expect(shouldShowGrokResult(pending, "grok")).toBe(true)
    expect(shouldShowGrokResult({ ...pending, availability: "ready" }, "all")).toBe(true)
  })
})

describe("resolveGrokHome", () => {
  test("uses GROK_HOME when set", () => {
    expect(resolveGrokHome({ GROK_HOME: "D:\\grok-home" }, "C:\\Users\\me")).toBe("D:\\grok-home")
  })

  test("falls back to ~/.grok", () => {
    expect(resolveGrokHome({}, "/Users/me")).toBe(join("/Users/me", ".grok"))
  })
})

describe("provider filter", () => {
  test("resolves grok from command or search", () => {
    expect(resolveUsageFilter({ Search: "", Command: "grok" })).toBe("grok")
    expect(resolveUsageFilter({ Search: "grok refresh" })).toBe("grok")
    expect(resolveUsageFilter({ Search: "" })).toBe("all")
  })

  test("keeps a grok-only filter from showing the other providers", () => {
    expect(includesProvider("grok", "codex")).toBe(false)
    expect(includesProvider("grok", "cursor")).toBe(false)
    expect(includesProvider("grok", "grok")).toBe(true)
    expect(includesProvider("all", "grok")).toBe(true)
  })
})
