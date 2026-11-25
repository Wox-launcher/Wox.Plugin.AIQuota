import { Context, PublicAPI, Query } from "@wox-launcher/wox-plugin"

import { CachedAntigravityUsageProvider, readAntigravityUsage } from "./antigravity-usage"
import { CachedClaudeUsageProvider, createEmptyClaudeSnapshot } from "./claude-usage"
import { CachedCodexUsageProvider, createEmptyCodexSnapshot } from "./codex-usage"
import { CachedCursorUsageProvider, createEmptyCursorSnapshot } from "./cursor-usage"
import { CachedGrokUsageProvider, createEmptyGrokSnapshot } from "./grok-usage"
import { AIQuotaPlugin } from "./index"

const resetTime = "2026-11-26T02:00:00Z"
const report = {
  response: {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 0, resetTime },
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.625 }
        ]
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-5h", window: "5h", remainingFraction: 0, disabled: true },
          { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: "invalid" },
          { bucketId: "invalid", remainingFraction: 2 },
          { bucketId: "unknown" }
        ]
      }
    ]
  }
}

afterEach(() => jest.restoreAllMocks())

test("reads enabled quota windows, including an exhausted bucket", () => {
  expect(readAntigravityUsage(report)).toEqual({
    status: "ready",
    buckets: [
      { id: "gemini-5h", group: "Gemini Models", window: "5h", remainingPercent: 0, resetsAt: Date.parse(resetTime) / 1000 },
      { id: "gemini-weekly", group: "Gemini Models", window: "weekly", remainingPercent: 62.5, resetsAt: null },
      { id: "3p-weekly", group: "Claude and GPT models", window: "weekly", remainingPercent: 100, resetsAt: null }
    ]
  })
  expect(readAntigravityUsage({ response: {} })).toEqual({ status: "no_live_data" })
})

test("renders Antigravity in the overview and directs explicit refreshes to its provider", async () => {
  const codex = new CachedCodexUsageProvider()
  jest.spyOn(codex, "start").mockResolvedValue(undefined)
  jest.spyOn(codex, "getSnapshot").mockResolvedValue(createEmptyCodexSnapshot())
  const cursor = new CachedCursorUsageProvider()
  jest.spyOn(cursor, "start").mockResolvedValue(undefined)
  jest.spyOn(cursor, "getSnapshot").mockResolvedValue(createEmptyCursorSnapshot())
  const grok = new CachedGrokUsageProvider()
  jest.spyOn(grok, "start").mockResolvedValue(undefined)
  jest.spyOn(grok, "getSnapshot").mockResolvedValue(createEmptyGrokSnapshot())
  const claude = new CachedClaudeUsageProvider()
  jest.spyOn(claude, "start").mockResolvedValue(undefined)
  jest.spyOn(claude, "getSnapshot").mockResolvedValue(createEmptyClaudeSnapshot())

  jest.spyOn(CachedAntigravityUsageProvider.prototype, "start").mockImplementation(() => {})
  jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-26T00:00:00Z"))
  const snapshot = jest.spyOn(CachedAntigravityUsageProvider.prototype, "getSnapshot").mockReturnValue(readAntigravityUsage(report))
  const refresh = jest.spyOn(CachedAntigravityUsageProvider.prototype, "refresh").mockResolvedValue({ status: "app_not_running" })
  const plugin = new AIQuotaPlugin(codex, cursor, grok, claude)
  const ctx = {} as Context
  const api = { GetSetting: jest.fn().mockResolvedValue("false") } as unknown as PublicAPI
  await plugin.init(ctx, { API: api, PluginDirectory: "" })

  const overview: Query = {
    Id: "overview",
    Type: "input",
    RawQuery: "quota",
    Search: "",
    Selection: { Type: "text", Text: "", FilePaths: [] },
    Env: { ActiveWindowTitle: "", ActiveWindowPid: 0, ActiveWindowIcon: { ImageType: "relative", ImageData: "" }, ActiveBrowserUrl: "" },
    IsGlobalQuery: () => false
  }
  const rows = await plugin.query(ctx, overview)
  expect(rows.map(row => row.Id)).toEqual(["antigravity-usage-gemini-5h", "antigravity-usage-gemini-weekly", "antigravity-usage-3p-weekly"])
  expect(rows[0].SubTitle).toBe("5H reset in 2h")
  expect(rows[0].Tails?.[0].Image?.ImageData).toContain("5H 0%")

  api.GetSetting = jest.fn().mockResolvedValue("true")
  const explicit = await plugin.query(ctx, { ...overview, RawQuery: "quota antigravity", Command: "antigravity" })
  expect(explicit[0].Tails?.[0].Image?.ImageData).toContain("5H 100%")

  const unavailable = await plugin.query(ctx, { ...overview, RawQuery: "quota antigravity refresh", Search: "antigravity refresh" })
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(unavailable[0].SubTitle).toBe("Open the Antigravity App and sign in to see your quota")
  snapshot.mockReturnValue({ status: "app_not_running" })
  await expect(plugin.query(ctx, overview)).resolves.toEqual([])

  refresh.mockResolvedValue(readAntigravityUsage(report))
  await expect(plugin.query(ctx, { ...overview, Command: "antigravity" })).resolves.toHaveLength(3)
})
