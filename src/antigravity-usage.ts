import { Context, PublicAPI } from "@wox-launcher/wox-plugin"
import { execFile } from "child_process"
import { once } from "events"
import { readdir, readFile, readlink } from "fs/promises"
import { request } from "http"
import { connect } from "net"
import { homedir } from "os"
import { join } from "path"
import { promisify } from "util"

const LOOPBACK = "127.0.0.1"
const MAX_RESPONSE_LENGTH = 1024 * 1024
const execFileAsync = promisify(execFile)

interface AppDaemon {
  pid: number
  port: number
  csrfToken: string
}

interface AntigravityBucket {
  id: string
  group: string
  window: string
  remainingPercent: number
  resetsAt: number | null
}

export type AntigravitySnapshot = { status: "ready"; buckets: AntigravityBucket[] } | { status: "app_not_running" | "no_live_data" }

export class CachedAntigravityUsageProvider {
  private snapshot: AntigravitySnapshot | null = null
  private inflight: Promise<AntigravitySnapshot> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  start(ctx: Context, api: PublicAPI): void {
    void this.refresh(ctx, api)
  }

  getSnapshot(): AntigravitySnapshot | null {
    return this.snapshot
  }

  refresh(ctx: Context, api: PublicAPI): Promise<AntigravitySnapshot> {
    if (this.inflight !== null) {
      return this.inflight
    }

    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.inflight = (async () => {
      const snapshot = await fetchAntigravityUsage()
      this.snapshot = snapshot
      const delay = await readRefreshDelay(ctx, api)
      this.timer = setTimeout(() => this.start(ctx, api), delay)
      this.timer.unref()
      return snapshot
    })().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }
}

async function readRefreshDelay(ctx: Context, api: PublicAPI): Promise<number> {
  try {
    const seconds = Number(await api.GetSetting(ctx, "cacheTtlSeconds"))
    if (Number.isInteger(seconds) && seconds > 0 && seconds <= 2147483) {
      return seconds * 1000
    }
  } catch {
    // Wox settings can be temporarily unavailable.
  }
  return 180000
}

async function fetchAntigravityUsage(): Promise<AntigravitySnapshot> {
  const folder = join(homedir(), ".gemini", "antigravity", "daemon")
  let files
  try {
    files = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    return { status: asRecord(error)?.code === "ENOENT" ? "app_not_running" : "no_live_data" }
  }

  let foundLiveDaemon = false
  for (const file of files) {
    const port = Number(/^hub_(\d+)\.json$/.exec(file.name)?.[1])
    if (!file.isFile() || !Number.isInteger(port) || port < 1 || port > 65535) {
      continue
    }
    try {
      const descriptor = asRecord(JSON.parse(await readFile(join(folder, file.name), "utf8")))
      const pid = descriptor?.pid
      const token = descriptor?.csrfToken
      if (descriptor?.httpPort !== port || typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || typeof token !== "string" || token.length === 0) {
        continue
      }
      process.kill(pid, 0)
      foundLiveDaemon = true
      const snapshot = readAntigravityUsage(await requestAppQuota({ pid, port, csrfToken: token }))
      if (snapshot.status === "ready") {
        return snapshot
      }
    } catch {
      // A descriptor can outlive its process or be replaced during a restart.
    }
  }
  return { status: foundLiveDaemon ? "no_live_data" : "app_not_running" }
}

async function requestAppQuota(daemon: AppDaemon): Promise<unknown> {
  const socket = connect(daemon.port, LOOPBACK)
  socket.on("error", () => {})
  const deadline = setTimeout(() => socket.destroy(new Error("Antigravity quota request timed out")), 5000)
  try {
    await once(socket, "connect")
    // Verify the peer before sending the local token, since the descriptor may be stale.
    if (socket.localPort === undefined || !(await verifyAppSocket(daemon, socket.localPort)) || socket.destroyed) {
      return null
    }

    return await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: LOOPBACK,
          port: daemon.port,
          method: "POST",
          path: "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
          createConnection: () => socket,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": 2,
            "Connect-Protocol-Version": "1",
            "X-Codeium-Csrf-Token": daemon.csrfToken
          }
        },
        res => {
          if (res.statusCode !== 200) {
            resolve(null)
            return
          }
          let body = ""
          res.setEncoding("utf8")
          res.on("data", (chunk: string) => {
            body += chunk
            if (body.length > MAX_RESPONSE_LENGTH) {
              res.destroy(new Error("Antigravity quota response too large"))
            }
          })
          res.on("error", reject)
          res.on("end", () => {
            try {
              resolve(JSON.parse(body))
            } catch (error) {
              reject(error)
            }
          })
        }
      )
      req.on("error", reject)
      req.end("{}")
    })
  } finally {
    clearTimeout(deadline)
    socket.destroy()
  }
}

async function verifyAppSocket(daemon: AppDaemon, clientPort: number): Promise<boolean> {
  const serverAddress = LOOPBACK + ":" + daemon.port
  const clientAddress = LOOPBACK + ":" + clientPort
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 3000 })
    return stdout.split(/\r?\n/).some(line => {
      const [protocol, local, remote, , pid] = line.trim().split(/\s+/)
      return protocol === "TCP" && local === serverAddress && remote === clientAddress && pid === String(daemon.pid)
    })
  }
  if (process.platform === "linux") {
    const proc = "/proc/" + daemon.pid
    const fds = await readdir(proc + "/fd")
    const links = new Set(await Promise.all(fds.map(fd => readlink(proc + "/fd/" + fd).catch(() => ""))))
    for (const [table, address] of [
      ["tcp", "0100007F"],
      ["tcp6", "0000000000000000FFFF00000100007F"]
    ]) {
      const connections = await readFile(proc + "/net/" + table, "utf8").catch(() => "")
      const local = address + ":" + daemon.port.toString(16).toUpperCase().padStart(4, "0")
      const remote = address + ":" + clientPort.toString(16).toUpperCase().padStart(4, "0")
      if (
        connections.split("\n").some(line => {
          const fields = line.trim().split(/\s+/)
          return fields[1] === local && fields[2] === remote && fields[3] === "01" && links.has("socket:[" + fields[9] + "]")
        })
      ) {
        return true
      }
    }
    return false
  }

  const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(daemon.pid), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"], { timeout: 3000 })
  return stdout.split("\n").includes("n" + serverAddress + "->" + clientAddress)
}

export function readAntigravityUsage(value: unknown): AntigravitySnapshot {
  const groups = asRecord(asRecord(value)?.response)?.groups
  if (!Array.isArray(groups)) {
    return { status: "no_live_data" }
  }

  const buckets: AntigravityBucket[] = []
  const seen = new Set<string>()
  for (const entry of groups) {
    const group = asRecord(entry)
    const name = group?.displayName
    if (typeof name !== "string" || name.trim() === "" || !Array.isArray(group?.buckets)) {
      continue
    }
    for (const entry of group.buckets) {
      const bucket = asRecord(entry)
      const id = bucket?.bucketId
      const fraction = bucket?.remainingFraction
      if (typeof id !== "string" || id.trim() === "" || seen.has(id) || bucket?.disabled === true || typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
        continue
      }
      const reset = typeof bucket?.resetTime === "string" ? Date.parse(bucket.resetTime) : NaN
      buckets.push({
        id,
        group: name.trim(),
        window: typeof bucket?.window === "string" ? bucket.window : "",
        remainingPercent: fraction * 100,
        resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null
      })
      seen.add(id)
    }
  }
  return buckets.length > 0 ? { status: "ready", buckets } : { status: "no_live_data" }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
