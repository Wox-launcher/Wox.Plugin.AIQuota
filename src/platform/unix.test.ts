import { unixPlatformRuntime } from "./unix"

describe("unixPlatformRuntime", () => {
  test("tries the bundled Codex.app executable on macOS when using the default codex command", () => {
    const launchSpecs = unixPlatformRuntime.getCodexLaunchSpecs("codex")

    expect(launchSpecs.map(spec => spec.command)).toContain("/Applications/Codex.app/Contents/Resources/codex")
  })
})
