/**
 * Read-only local diagnostics used by the DevOps Shack VoiceOps Assistant.
 */

import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import { FunctionDeclaration, Type } from "@google/genai";

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "check_cpu_usage",
    description: "Check current CPU usage of the environment running the voice assistant.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "check_memory_usage",
    description: "Check current memory usage of the environment running the voice assistant.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "check_disk_usage",
    description: "Check disk usage for the root filesystem of the environment running the voice assistant.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "check_local_port",
    description: "Check whether a TCP port is reachable from the voice assistant environment.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        port: { type: Type.INTEGER, description: "TCP port number, for example 8080." },
        host: { type: Type.STRING, description: "Hostname or IP. Defaults to localhost." },
      },
      required: ["port"],
    },
  },
  {
    name: "check_http_endpoint",
    description: "Check whether an HTTP or HTTPS endpoint is reachable and report its status code.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "Full URL, for example http://host.docker.internal:8080/health." },
      },
      required: ["url"],
    },
  },
  {
    name: "list_docker_containers",
    description: "List running Docker containers when the Docker Engine socket is available to this demo.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];

function _gb(bytes: number): number {
  return Math.round((bytes / Math.pow(1024, 3)) * 100) / 100;
}

export interface ToolEvent {
  name: string;
  title: string;
  summary: string;
  command: string;
  details: string;
  ok: boolean;
}

function _event(name: string, title: string, summary: string, command: string, details = "", ok = true): ToolEvent {
  return {
    name,
    title,
    summary,
    command,
    details,
    ok,
  };
}

async function readLinuxCpuTimes(): Promise<[number, number]> {
  const data = await fs.promises.readFile("/proc/stat", "utf-8");
  const firstLine = data.split("\n")[0] || "";
  const parts = firstLine.trim().split(/\s+/);
  if (!parts.length || parts[0] !== "cpu") {
    throw new Error("Could not read aggregate CPU counters");
  }
  const values = parts.slice(1).map(Number);
  const idle = values[3] + (values.length > 4 ? values[4] : 0);
  const total = values.reduce((sum, v) => sum + v, 0);
  return [idle, total];
}

export async function cpuUsage(): Promise<[ToolEvent, Record<string, any>]> {
  try {
    let usage = 0.0;
    const cores = os.cpus().length || 1;

    try {
      const [idle1, total1] = await readLinuxCpuTimes();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const [idle2, total2] = await readLinuxCpuTimes();
      const totalDelta = total2 - total1;
      const idleDelta = idle2 - idle1;
      usage = totalDelta <= 0 ? 0.0 : (1.0 - idleDelta / totalDelta) * 100.0;
    } catch {
      // Fallback if /proc/stat is unavailable
      const getCpuTimes = () => {
        const cpus = os.cpus();
        let idle = 0;
        let total = 0;
        for (const cpu of cpus) {
          for (const type in cpu.times) {
            total += (cpu.times as any)[type];
          }
          idle += cpu.times.idle;
        }
        return [idle, total];
      };
      const [idle1, total1] = getCpuTimes();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const [idle2, total2] = getCpuTimes();
      const totalDelta = total2 - total1;
      const idleDelta = idle2 - idle1;
      usage = totalDelta <= 0 ? 0.0 : (1.0 - idleDelta / totalDelta) * 100.0;
    }

    usage = Math.round(Math.max(0.0, Math.min(100.0, usage)) * 10) / 10;
    const summary = `CPU usage is ${usage.toFixed(1)}% across ${cores} logical cores.`;
    return [
      _event("check_cpu_usage", "CPU Usage", summary, "Read /proc/stat", "Read-only Linux runtime metric."),
      { result: "ok", cpu_percent: usage, logical_cores: cores, summary },
    ];
  } catch (exc: any) {
    const summary = "CPU utilization could not be read from this runtime.";
    return [
      _event("check_cpu_usage", "CPU Usage", summary, "Read /proc/stat", String(exc), false),
      { result: "failed", summary },
    ];
  }
}

export async function memoryUsage(): Promise<[ToolEvent, Record<string, any>]> {
  try {
    let total = 0;
    let available = 0;

    try {
      const data = await fs.promises.readFile("/proc/meminfo", "utf-8");
      const values: Record<string, number> = {};
      for (const line of data.split("\n")) {
        const parts = line.split(":");
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const raw = parts[1].trim().split(/\s+/)[0];
          values[key] = parseInt(raw, 10) * 1024;
        }
      }
      total = values["MemTotal"] || 0;
      available = values["MemAvailable"] !== undefined ? values["MemAvailable"] : (values["MemFree"] || 0);
    } catch {
      total = os.totalmem();
      available = os.freemem();
    }

    const used = Math.max(0, total - available);
    const percent = total ? Math.round((used / total) * 1000) / 10 : 0.0;
    const summary = `Memory usage is ${percent.toFixed(1)}%. Used ${_gb(used)} GB out of ${_gb(total)} GB.`;

    return [
      _event("check_memory_usage", "Memory Usage", summary, "Read /proc/meminfo", "Read-only Linux runtime metric."),
      { result: "ok", memory_percent: percent, used_gb: _gb(used), total_gb: _gb(total), summary },
    ];
  } catch (exc: any) {
    const summary = "Memory utilization could not be read from this runtime.";
    return [
      _event("check_memory_usage", "Memory Usage", summary, "Read /proc/meminfo", String(exc), false),
      { result: "failed", summary },
    ];
  }
}

export function diskUsage(): [ToolEvent, Record<string, any>] {
  try {
    const stats = fs.statfsSync("/");
    const total = stats.bsize * stats.blocks;
    const free = stats.bsize * stats.bavail;
    const used = total - free;
    const percent = total ? Math.round((used / total) * 1000) / 10 : 0.0;
    const summary = `Root filesystem usage is ${percent.toFixed(1)}%. Used ${_gb(used)} GB out of ${_gb(total)} GB.`;

    return [
      _event("check_disk_usage", "Disk Usage", summary, "fs.statfsSync('/')", "Read-only runtime metric."),
      { result: "ok", disk_percent: percent, used_gb: _gb(used), total_gb: _gb(total), summary },
    ];
  } catch (exc: any) {
    const summary = "Disk usage could not be determined.";
    return [
      _event("check_disk_usage", "Disk Usage", summary, "fs.statfsSync('/')", String(exc), false),
      { result: "failed", summary },
    ];
  }
}

export async function localPort(host: string, portInput: any): Promise<[ToolEvent, Record<string, any>]> {
  const targetHost = host || "localhost";
  const port = parseInt(portInput, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    const summary = "The requested TCP port is invalid.";
    return [
      _event("check_local_port", "Local Port Check", summary, `TCP connect to ${targetHost}:${portInput}`, "Valid ports are 1-65535.", false),
      { result: "failed", reachable: false, summary },
    ];
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isResolved = false;

    socket.setTimeout(2000);

    socket.connect(port, targetHost, () => {
      if (isResolved) return;
      isResolved = true;
      socket.destroy();
      const summary = `Port ${port} on ${targetHost} is reachable.`;
      resolve([
        _event("check_local_port", "Local Port Check", summary, `TCP connect to ${targetHost}:${port}`, "TCP connection established successfully.", true),
        { result: "ok", host: targetHost, port, reachable: true, summary },
      ]);
    });

    socket.on("error", (err) => {
      if (isResolved) return;
      isResolved = true;
      socket.destroy();
      const summary = `Port ${port} on ${targetHost} is not reachable.`;
      resolve([
        _event("check_local_port", "Local Port Check", summary, `TCP connect to ${targetHost}:${port}`, String(err.message || err), false),
        { result: "failed", host: targetHost, port, reachable: false, summary },
      ]);
    });

    socket.on("timeout", () => {
      if (isResolved) return;
      isResolved = true;
      socket.destroy();
      const summary = `Port ${port} on ${targetHost} timed out.`;
      resolve([
        _event("check_local_port", "Local Port Check", summary, `TCP connect to ${targetHost}:${port}`, "Connection timed out after 2 seconds.", false),
        { result: "failed", host: targetHost, port, reachable: false, summary },
      ]);
    });
  });
}

export async function httpEndpoint(url: string): Promise<[ToolEvent, Record<string, any>]> {
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    const summary = "Endpoint URL must begin with http:// or https://.";
    return [
      _event("check_http_endpoint", "HTTP Endpoint Check", summary, `HTTP GET ${url}`, "Invalid URL scheme.", false),
      { result: "failed", url, summary },
    ];
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "DevOpsShackVoiceOps/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    const code = response.status;
    const ok = code >= 200 && code < 400;
    const summary = `Endpoint returned HTTP ${code}.`;
    return [
      _event("check_http_endpoint", "HTTP Endpoint Check", summary, `HTTP GET ${url}`, `Checked ${url}`, ok),
      { result: ok ? "ok" : "failed", url, status_code: code, summary },
    ];
  } catch (exc: any) {
    const summary = `Endpoint check failed for ${url}.`;
    return [
      _event("check_http_endpoint", "HTTP Endpoint Check", summary, `HTTP GET ${url}`, String(exc.message || exc), false),
      { result: "failed", url, summary },
    ];
  }
}

export async function dockerContainers(): Promise<[ToolEvent, Record<string, any>]> {
  const socketPath = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
  const command = "Docker Engine API: GET /containers/json";

  if (process.platform === "win32") {
    const summary = "Docker socket inspection is not enabled for native Windows execution.";
    const details = "Use Docker Compose with Docker Desktop/WSL2, or run inside WSL where /var/run/docker.sock is available.";
    return [
      _event("list_docker_containers", "Docker Containers", summary, command, details, false),
      { result: "failed", summary },
    ];
  }

  if (!fs.existsSync(socketPath)) {
    const summary = "Docker Engine socket is not available to the application.";
    const details = `Expected socket: ${socketPath}. In Compose, mount /var/run/docker.sock to enable this optional demo feature.`;
    return [
      _event("list_docker_containers", "Docker Containers", summary, command, details, false),
      { result: "failed", summary },
    ];
  }

  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: "/containers/json",
        method: "GET",
        timeout: 4000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            const summary = `Docker Engine returned HTTP ${res.statusCode}.`;
            const details = body.slice(0, 1200);
            return resolve([
              _event("list_docker_containers", "Docker Containers", summary, command, details, false),
              { result: "failed", summary },
            ]);
          }

          try {
            const payload = JSON.parse(body);
            const containers = (payload || []).map((item: any) => {
              const names = (item.Names || []).map((n: string) => n.replace(/^\//, ""));
              return {
                name: names[0] || (item.Id || "").slice(0, 12),
                image: item.Image || "",
                state: item.State || "",
                status: item.Status || "",
              };
            });

            const summary = `Found ${containers.length} running Docker container(s).`;
            const details =
              containers
                .slice(0, 12)
                .map((c: any) => `${c.name} | ${c.image} | ${c.status}`)
                .join("\n") || "No running containers.";

            resolve([
              _event("list_docker_containers", "Docker Containers", summary, command, details, true),
              { result: "ok", containers, summary },
            ]);
          } catch (parseErr: any) {
            resolve([
              _event("list_docker_containers", "Docker Containers", "Could not parse Docker response.", command, String(parseErr), false),
              { result: "failed", summary: "Could not parse Docker response." },
            ]);
          }
        });
      }
    );

    req.on("error", (err) => {
      resolve([
        _event("list_docker_containers", "Docker Containers", "Could not query the Docker Engine socket.", command, String(err.message || err), false),
        { result: "failed", summary: "Could not query the Docker Engine socket." },
      ]);
    });

    req.on("timeout", () => {
      req.destroy();
      resolve([
        _event("list_docker_containers", "Docker Containers", "Timeout querying Docker Engine socket.", command, "Socket query timed out.", false),
        { result: "failed", summary: "Timeout querying Docker Engine socket." },
      ]);
    });

    req.end();
  });
}

export async function dispatchTool(name: string, args: Record<string, any>): Promise<[ToolEvent, Record<string, any>]> {
  if (name === "check_cpu_usage") {
    return cpuUsage();
  }
  if (name === "check_memory_usage") {
    return memoryUsage();
  }
  if (name === "check_disk_usage") {
    return diskUsage();
  }
  if (name === "check_local_port") {
    return localPort(args.host, args.port);
  }
  if (name === "check_http_endpoint") {
    return httpEndpoint(args.url);
  }
  if (name === "list_docker_containers") {
    return dockerContainers();
  }
  const summary = `Tool '${name}' is not implemented in this local demo.`;
  return [
    _event(name, "Unsupported Tool", summary, name, "Only read-only demo tools are exposed.", false),
    { result: "failed", summary },
  ];
}
