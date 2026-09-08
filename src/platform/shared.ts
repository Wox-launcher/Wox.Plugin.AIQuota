import { homedir } from "os"
import { join } from "path"

import { RuntimeSettings } from "./types"

export function createRuntimeSettings(codexExecutable: string, sqliteExecutable: string, requestTimeoutMs: number): RuntimeSettings {
  return {
    codexExecutable: codexExecutable,
    codexHome: join(homedir(), ".codex"),
    sqliteExecutable: sqliteExecutable,
    cursorStateDbPath: resolveCursorStateDbPath(process.platform, process.env, homedir()),
    grokHome: resolveGrokHome(process.env, homedir()),
    requestTimeoutMs: requestTimeoutMs
  }
}

export function resolveCursorStateDbPath(platform: string, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === "win32") {
    const appData = env.APPDATA && env.APPDATA.length > 0 ? env.APPDATA : join(home, "AppData", "Roaming")
    return join(appData, "Cursor", "User", "globalStorage", "state.vscdb")
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
  }

  return join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb")
}

export function resolveGrokHome(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.GROK_HOME
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim()
  }

  return join(home, ".grok")
}
