import { join } from "path"

import { decodeGrokCreditsUsedPercent, formatGrokPlanName, getGrokRemainingPercent, isGrokAccessExpired, mergeGrokAuth, readGrokAuthFile, readGrokBilling, readGrokSettings, resolveGrokCreditUsagePercent, shouldShowGrokReset, shouldShowGrokResult } from "./grok-usage"
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

  test("reads a SuperGrok Heavy period-only payload without inventing a percent", () => {
    const billing = readGrokBilling({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-09-17T07:07:59.159559+00:00",
          end: "2026-09-24T07:07:59.159559+00:00"
        },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        isUnifiedBillingUser: true,
        billingPeriodStart: "2026-09-17T07:07:59.159559+00:00",
        billingPeriodEnd: "2026-09-24T07:07:59.159559+00:00"
      }
    })

    expect(billing.creditUsagePercent).toBeNull()
    expect(billing.periodType).toBe("weekly")
    expect(resolveGrokCreditUsagePercent(billing, null)).toBe(0)
    expect(resolveGrokCreditUsagePercent(billing, 1.25)).toBe(1.25)
    expect(getGrokRemainingPercent(resolveGrokCreditUsagePercent(billing, null))).toBe(100)
  })

  test("falls back to product usage when the credits percent is omitted", () => {
    const billing = readGrokBilling({
      config: {
        productUsage: [{ product: "GrokBuild", usagePercent: 12 }]
      }
    })

    expect(billing.creditUsagePercent).toBe(12)
  })
})

describe("decodeGrokCreditsUsedPercent", () => {
  test("reads a framed usage ratio as percent used", () => {
    const ratio = Buffer.alloc(4)
    ratio.writeFloatLE(0.01, 0)
    const credits = Buffer.concat([Buffer.from([0x0d]), ratio])
    const message = Buffer.concat([Buffer.from([0x0a, credits.length]), credits])
    const frame = Buffer.alloc(5 + message.length)
    frame.writeUInt32BE(message.length, 1)
    message.copy(frame, 5)

    expect(decodeGrokCreditsUsedPercent(frame)).toBeCloseTo(1, 5)
  })

  test("treats an omitted usage ratio as zero used", () => {
    const credits = Buffer.from([0x12, 0x00])
    const message = Buffer.concat([Buffer.from([0x0a, credits.length]), credits])
    const frame = Buffer.alloc(5 + message.length)
    frame.writeUInt32BE(message.length, 1)
    message.copy(frame, 5)

    expect(decodeGrokCreditsUsedPercent(frame)).toBe(0)
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
    expect(auth?.entryKey).toBe("https://auth.x.ai::client")
  })

  test("reads the OIDC refresh fields used by grok login", () => {
    const auth = readGrokAuthFile({
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        key: "access-token",
        auth_mode: "oidc",
        refresh_token: "refresh-token",
        expires_at: "2026-09-15T20:36:14.692406900Z",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828"
      }
    })

    expect(auth).not.toBeNull()
    expect(auth?.refreshToken).toBe("refresh-token")
    expect(auth?.issuer).toBe("https://auth.x.ai")
    expect(auth?.clientId).toBe("b1a00492-073a-47ea-816f-4c329264a828")
    expect(auth?.expiresAt).toBe(Math.floor(Date.parse("2026-09-15T20:36:14.692Z") / 1000))
  })

  test("returns null when no bearer token is present", () => {
    expect(readGrokAuthFile({ email: "user@example.com" })).toBeNull()
  })
})

describe("mergeGrokAuth", () => {
  test("updates the matching OIDC entry without dropping other fields", () => {
    const merged = mergeGrokAuth(
      {
        "https://auth.x.ai::client": {
          key: "old-access",
          auth_mode: "oidc",
          email: "user@example.com",
          refresh_token: "old-refresh"
        }
      },
      {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        email: "user@example.com",
        authMode: "oidc",
        expiresAt: 1789504574,
        clientId: "client",
        issuer: "https://auth.x.ai",
        entryKey: "https://auth.x.ai::client"
      }
    )

    expect(merged["https://auth.x.ai::client"]).toEqual({
      key: "new-access",
      auth_mode: "oidc",
      email: "user@example.com",
      refresh_token: "new-refresh",
      expires_at: "2026-09-15T20:36:14.000Z"
    })
  })
})

describe("isGrokAccessExpired", () => {
  test("uses expires_at when present", () => {
    expect(isGrokAccessExpired({ accessToken: "token", expiresAt: 100 }, 0, 99999)).toBe(false)
    expect(isGrokAccessExpired({ accessToken: "token", expiresAt: 100 }, 0, 100000)).toBe(true)
  })

  test("falls back to the JWT exp claim", () => {
    const token = ["eyJhbGciOiJub25lIn0", Buffer.from(JSON.stringify({ exp: 100 })).toString("base64url"), "sig"].join(".")
    expect(isGrokAccessExpired({ accessToken: token, expiresAt: null }, 0, 99000)).toBe(false)
    expect(isGrokAccessExpired({ accessToken: token, expiresAt: null }, 0, 100000)).toBe(true)
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

  test("hides pending grok results until the first fetch finishes", () => {
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
    expect(shouldShowGrokResult(pending, "grok")).toBe(false)
    expect(shouldShowGrokResult({ ...pending, availability: "ready" }, "all")).toBe(true)
  })

  test("hides reset text when the period is unused", () => {
    expect(shouldShowGrokReset({ creditUsagePercent: 0, billingCycleEnd: 1 })).toBe(false)
    expect(shouldShowGrokReset({ creditUsagePercent: 98, billingCycleEnd: null })).toBe(false)
    expect(shouldShowGrokReset({ creditUsagePercent: 98, billingCycleEnd: 1 })).toBe(true)
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
