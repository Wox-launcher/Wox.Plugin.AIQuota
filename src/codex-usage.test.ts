import { EventEmitter } from "events"
import { PassThrough } from "stream"

import { spawn } from "child_process"

import { listCodexWindows, resolveCodexWindowLabel, runJsonRpcSessionWithLaunchSpec } from "./codex-usage"

jest.mock("child_process", () => ({
  execFile: jest.fn(),
  spawn: jest.fn()
}))

class FakeCodexAppServer extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly seenMethods: string[] = []
  private initialized = false
  private killed = false

  readonly stdin = {
    write: (chunk: string): boolean => {
      this.handleInput(chunk)
      return true
    },
    end: (): void => {
      setImmediate(() => this.exit(0))
    }
  }

  kill(): void {
    this.killed = true
  }

  private handleInput(chunk: string): void {
    const lines = chunk.split(/\r?\n/).filter(line => line.trim().length > 0)
    for (let index = 0; index < lines.length; index += 1) {
      const request = JSON.parse(lines[index]) as { id?: string; method?: string }
      if (typeof request.method === "string") {
        this.seenMethods.push(request.method)
      }

      if (request.method === "initialize" && typeof request.id === "string") {
        this.writeResponse({
          id: request.id,
          result: {
            userAgent: "Codex Test",
            codexHome: "/tmp/codex",
            platformFamily: "unix",
            platformOs: "macos"
          }
        })
        continue
      }

      if (request.method === "initialized") {
        this.initialized = true
        continue
      }

      if (!this.initialized || typeof request.id !== "string") {
        continue
      }

      if (request.method === "account/read") {
        this.writeResponse({
          id: request.id,
          result: {
            account: {
              type: "chatgpt",
              planType: "pro"
            },
            requiresOpenaiAuth: true
          }
        })
      }

      if (request.method === "account/rateLimits/read") {
        this.writeResponse({
          id: request.id,
          result: {
            rateLimits: {
              primary: {
                usedPercent: 46,
                windowDurationMins: 300,
                resetsAt: 1780579854
              },
              secondary: null,
              credits: null,
              planType: "pro"
            }
          }
        })
      }
    }
  }

  private writeResponse(response: unknown): void {
    setImmediate(() => {
      this.stdout.write(JSON.stringify(response) + "\n")
    })
  }

  private exit(code: number): void {
    if (!this.killed) {
      this.emit("exit", code)
    }
  }
}

describe("runJsonRpcSessionWithLaunchSpec", () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  test("sends initialized before account and rate limit requests", async () => {
    const fakeServer = new FakeCodexAppServer()
    ;(spawn as jest.Mock).mockReturnValue(fakeServer)

    const responses = await runJsonRpcSessionWithLaunchSpec(
      {
        command: "codex",
        args: ["app-server"],
        options: {}
      },
      1000,
      [
        {
          id: "initialize",
          method: "initialize",
          params: {
            clientInfo: {
              name: "wox-plugin-ai-quota-test",
              version: "0.0.0"
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
    )

    expect(responses.rateLimits.result).toEqual({
      rateLimits: {
        primary: {
          usedPercent: 46,
          windowDurationMins: 300,
          resetsAt: 1780579854
        },
        secondary: null,
        credits: null,
        planType: "pro"
      }
    })
    expect(fakeServer.seenMethods).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"])
  })
})

describe("resolveCodexWindowLabel", () => {
  const now = Date.UTC(2026, 8, 8, 9, 0, 0)

  test("labels a 5-hour window when reset is still inside that window", () => {
    expect(
      resolveCodexWindowLabel(
        {
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: now / 1000 + 3 * 3600
        },
        undefined,
        now
      )
    ).toBe("5H")
  })

  test("relabels a misleading 5-hour window as weekly when reset is days away", () => {
    expect(
      resolveCodexWindowLabel(
        {
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: now / 1000 + 6 * 86400 + 18 * 3600
        },
        undefined,
        now
      )
    ).toBe("Week")
  })

  test("uses the weekly duration when Codex reports a week window", () => {
    expect(
      resolveCodexWindowLabel(
        {
          usedPercent: 12,
          windowDurationMins: 10080,
          resetsAt: now / 1000 + 6 * 86400
        },
        undefined,
        now
      )
    ).toBe("Week")
  })

  test("lists only windows that exist", () => {
    expect(
      listCodexWindows({
        primary: {
          usedPercent: 12,
          windowDurationMins: 10080,
          resetsAt: 1
        },
        secondary: null,
        credits: null,
        planType: "pro"
      })
    ).toHaveLength(1)
  })
})
