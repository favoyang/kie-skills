import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * The dashboard is meant to be resident, so installing the skill should also
 * install the service. Each platform gets its native supervisor: launchd on
 * macOS, Task Scheduler on Windows. Nothing here is specific to one user.
 */

const run = promisify(execFile);

export const SERVICE_LABEL = "local.kie.dashboard";
export const WINDOWS_TASK_NAME = "Kie Dashboard";

export function servicePaths({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "darwin") {
    return {
      platform,
      plistPath: path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
      logPath: path.join(home, "Library", "Logs", "kie-dashboard.log"),
    };
  }
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const dir = path.join(base, "kie");
    return {
      platform,
      dir,
      scriptPath: path.join(dir, "dashboard.cmd"),
      launcherPath: path.join(dir, "dashboard.vbs"),
      logPath: path.join(dir, "dashboard.log"),
    };
  }
  throw new Error(`no service backend for ${platform}; run "kie dashboard" under your own supervisor`);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderLaunchdPlist({ nodePath, cliPath, host, port, logPath, label = SERVICE_LABEL }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xmlEscape(nodePath)}</string><string>${xmlEscape(cliPath)}</string>
    <string>dashboard</string><string>--host</string><string>${xmlEscape(host)}</string>
    <string>--port</string><string>${xmlEscape(port)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict></plist>
`;
}

/**
 * Windows has no KeepAlive flag here, so the wrapper restarts the process. The
 * health probe keeps a second wrapper (another logon) from competing for the
 * port and respawning a doomed child every few seconds.
 */
export function renderWindowsScript({ nodePath, cliPath, host, port, logPath }) {
  return `@echo off
setlocal
:loop
curl -s -f --max-time 2 http://127.0.0.1:${port}/api/health >nul 2>&1
if not errorlevel 1 goto done
"${nodePath}" "${cliPath}" dashboard --host ${host} --port ${port} >> "${logPath}" 2>&1
ping -n 4 127.0.0.1 >nul
goto loop
:done
endlocal
`;
}

/** Task Scheduler starts this with wscript so no console window appears. */
export function renderWindowsLauncher({ scriptPath }) {
  return `Set shell = CreateObject("WScript.Shell")\r
shell.Run Chr(34) & "${scriptPath}" & Chr(34), 0, False\r
`;
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

async function stopProcesses({ platform, cliPath }) {
  if (platform === "darwin") {
    await run("pkill", ["-f", `${cliPath} dashboard`]).catch(() => {});
    return;
  }
  if (platform === "win32") {
    const escaped = cliPath.replaceAll("'", "''");
    // The restart wrapper outlives the task, so stopping only the node process
    // would let the wrapper bring it straight back.
    const filter = [
      `($_.CommandLine -like '*${escaped}*' -and $_.CommandLine -like '*dashboard*')`,
      "$_.CommandLine -like '*dashboard.cmd*'",
      "$_.CommandLine -like '*dashboard.vbs*'",
    ].join(" -or ");
    await run("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and (${filter}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ]).catch(() => {});
  }
}

export async function stopService({ platform = process.platform, cliPath, log = console.log } = {}) {
  const paths = servicePaths({ platform });
  if (platform === "darwin") {
    await run("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]).catch(() => {});
  } else {
    await run("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]).catch(() => {});
  }
  await stopProcesses({ platform, cliPath });
  log(`stopped    ${paths.platform}`);
}

export async function installService({
  nodePath = process.execPath,
  cliPath,
  host = "0.0.0.0",
  port = 4173,
  platform = process.platform,
  log = console.log,
} = {}) {
  if (!cliPath) throw new Error("installService needs the CLI path");
  const paths = servicePaths({ platform });
  await stopService({ platform, cliPath, log: () => {} });

  if (platform === "darwin") {
    await mkdir(path.dirname(paths.plistPath), { recursive: true });
    await mkdir(path.dirname(paths.logPath), { recursive: true });
    await writeFile(paths.plistPath, renderLaunchdPlist({ nodePath, cliPath, host, port, logPath: paths.logPath }), "utf8");
    await run("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]).catch(() => {});
    await run("launchctl", ["bootstrap", `gui/${uid()}`, paths.plistPath]);
    log(`installed  ${paths.plistPath}`);
    log(`service    launchd ${SERVICE_LABEL} (RunAtLoad, KeepAlive)`);
    return paths;
  }

  if (platform === "win32") {
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.scriptPath, renderWindowsScript({ nodePath, cliPath, host, port, logPath: paths.logPath }), "utf8");
    await writeFile(paths.launcherPath, renderWindowsLauncher({ scriptPath: paths.scriptPath }), "utf8");
    await run("schtasks", [
      "/Create", "/F", "/TN", WINDOWS_TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED",
      "/TR", `wscript.exe "${paths.launcherPath}"`,
    ]);
    await run("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]);
    log(`installed  ${paths.scriptPath}`);
    log(`service    Task Scheduler "${WINDOWS_TASK_NAME}" (at logon)`);
    return paths;
  }

  throw new Error(`no service backend for ${platform}`);
}

export async function uninstallService({ platform = process.platform, cliPath, log = console.log } = {}) {
  const paths = servicePaths({ platform });
  await stopService({ platform, cliPath, log: () => {} });
  if (platform === "darwin") {
    await rm(paths.plistPath, { force: true });
  } else {
    await run("schtasks", ["/Delete", "/F", "/TN", WINDOWS_TASK_NAME]).catch(() => {});
    await rm(paths.scriptPath, { force: true });
    await rm(paths.launcherPath, { force: true });
  }
  log(`uninstalled ${paths.platform} service`);
  return paths;
}

export async function serviceStatus({ platform = process.platform } = {}) {
  const paths = servicePaths({ platform });
  if (platform === "darwin") {
    try {
      const { stdout } = await run("launchctl", ["print", `gui/${uid()}/${SERVICE_LABEL}`]);
      const state = /state = (\w+)/.exec(stdout)?.[1] ?? "loaded";
      return { platform, installed: true, detail: state, plistPath: paths.plistPath };
    } catch {
      return { platform, installed: false, detail: "not loaded", plistPath: paths.plistPath };
    }
  }
  try {
    const { stdout } = await run("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST"]);
    // The launcher detaches, so the task state is "Ready" while the server runs.
    // Callers should treat the health endpoint as the source of truth.
    const state = /Status:\s*(.+)/.exec(stdout)?.[1]?.trim() ?? "installed";
    return { platform, installed: true, detail: state, scriptPath: paths.scriptPath };
  } catch {
    return { platform, installed: false, detail: "task not found", scriptPath: paths.scriptPath };
  }
}
