import type { SpawnOptionsWithoutStdio } from "child_process"

export interface RuntimeSettings {
  codexExecutable: string
  codexHome: string
  sqliteExecutable: string
  cursorStateDbPath: string
  grokHome: string
  requestTimeoutMs: number
}

export interface CommandLaunchSpec {
  command: string
  args: string[]
  options: SpawnOptionsWithoutStdio
}

export interface PlatformRuntime {
  getRuntimeSettings(requestTimeoutMs: number): RuntimeSettings
  getCodexLaunchSpecs(executable: string): CommandLaunchSpec[]
  getSqliteExecutableCandidates(executable: string): string[]
}
