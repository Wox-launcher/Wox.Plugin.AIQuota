import { execFile } from "child_process"
import { promisify } from "util"

import { getPlatformRuntime } from "./platform"

const execFileAsync = promisify(execFile)
const platformRuntime = getPlatformRuntime()
const PYTHON_SQLITE_SCRIPT =
  "import sqlite3, sys\nconn = sqlite3.connect(sys.argv[1])\ncur = conn.cursor()\ncur.execute(sys.argv[2])\nfor row in cur.fetchall():\n    print('|'.join('' if value is None else str(value) for value in row))\nconn.close()"

export async function runSqliteQuery(executable: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const candidates = platformRuntime.getSqliteExecutableCandidates(executable)
  let lastError: Error | null = null

  for (let index = 0; index < candidates.length; index += 1) {
    try {
      return await runExecFile(candidates[index], args, timeoutMs)
    } catch (error) {
      lastError = ensureError(error)
      if (!shouldTryNextCommand(lastError, index, candidates.length)) {
        break
      }
    }
  }

  if (args.length >= 2) {
    try {
      return await runPythonSqliteQuery(args[0], args[1], timeoutMs)
    } catch (error) {
      lastError = ensureError(error)
    }
  }

  throw lastError || new Error("Unable to run sqlite command")
}

async function runPythonSqliteQuery(databasePath: string, sql: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]
  let lastError: Error | null = null

  for (let index = 0; index < candidates.length; index += 1) {
    try {
      return await runExecFile(candidates[index], ["-c", PYTHON_SQLITE_SCRIPT, databasePath, sql], timeoutMs)
    } catch (error) {
      lastError = ensureError(error)
      if (!shouldTryNextCommand(lastError, index, candidates.length)) {
        throw lastError
      }
    }
  }

  throw lastError || new Error("Unable to run Python sqlite fallback")
}

export async function runExecFile(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  })
}

export function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

export function shouldTryNextCommand(error: Error, index: number, total: number): boolean {
  if (index >= total - 1) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.indexOf("enoent") >= 0 || message.indexOf("spawn") >= 0 || message.indexOf("not recognized as an internal or external command") >= 0 || message.indexOf("cannot find the file") >= 0
}
