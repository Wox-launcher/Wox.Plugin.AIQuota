import { PlatformRuntime } from "./types"
import { createRuntimeSettings } from "./shared"

const DEFAULT_CODEX_EXECUTABLE = "codex"
const DEFAULT_SQLITE_EXECUTABLE = "sqlite3"
const DARWIN_CODEX_APP_EXECUTABLE = "/Applications/Codex.app/Contents/Resources/codex"

export const unixPlatformRuntime: PlatformRuntime = {
  getRuntimeSettings(requestTimeoutMs) {
    return createRuntimeSettings(DEFAULT_CODEX_EXECUTABLE, DEFAULT_SQLITE_EXECUTABLE, requestTimeoutMs)
  },

  getCodexLaunchSpecs(executable) {
    return getUnixCodexCandidates(executable).map(candidate => {
      return {
        command: candidate,
        args: ["app-server"],
        options: {
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env
        }
      }
    })
  },

  getSqliteExecutableCandidates(executable) {
    return [executable]
  }
}

function getUnixCodexCandidates(executable: string): string[] {
  if (process.platform !== "darwin" || executable !== DEFAULT_CODEX_EXECUTABLE) {
    return [executable]
  }

  return [executable, DARWIN_CODEX_APP_EXECUTABLE]
}
