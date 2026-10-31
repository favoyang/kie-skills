import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  renderLaunchdPlist,
  renderWindowsLauncher,
  renderWindowsScript,
  servicePaths,
} from "../scripts/lib/service.js";

const args = {
  nodePath: "/usr/local/bin/node",
  cliPath: "/skills/kie-skills/scripts/cli.js",
  host: "0.0.0.0",
  port: 4173,
  logPath: "/logs/kie-dashboard.log",
};

test("the launchd plist restarts the dashboard and passes host and port", () => {
  const plist = renderLaunchdPlist(args);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/skills\/kie-skills\/scripts\/cli\.js<\/string>/);
  assert.match(plist, /<string>--port<\/string><string>4173<\/string>/);
  assert.match(plist, /<string>--host<\/string><string>0\.0\.0\.0<\/string>/);
  assert.match(plist, /local\.kie\.dashboard/);
});

test("the plist escapes characters that would break the XML", () => {
  const plist = renderLaunchdPlist({ ...args, cliPath: "/a & b/<cli>.js" });
  assert.match(plist, /\/a &amp; b\/&lt;cli&gt;\.js/);
  assert.doesNotMatch(plist, /<cli>/);
});

test("the Windows wrapper restarts the dashboard in a loop", () => {
  const script = renderWindowsScript({
    ...args,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\me\\.agents\\skills\\kie-skills\\scripts\\cli.js",
    logPath: "C:\\Users\\me\\AppData\\Local\\kie\\dashboard.log",
  });
  assert.match(script, /:loop/);
  assert.match(script, /goto loop/);
  assert.match(script, /"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(script, /dashboard --host 0\.0\.0\.0 --port 4173/);
  assert.match(script, /curl -s -f --max-time 2 http:\/\/127\.0\.0\.1:4173\/api\/health/);
  assert.match(script, /if not errorlevel 1 goto done/);
});

test("the Windows launcher runs the wrapper without a console window", () => {
  const launcher = renderWindowsLauncher({ scriptPath: "C:\\Users\\me\\AppData\\Local\\kie\\dashboard.cmd" });
  assert.match(launcher, /WScript\.Shell/);
  assert.match(launcher, /, 0, False/);
  assert.match(launcher, /dashboard\.cmd/);
});

test("service paths follow each platform's convention", () => {
  const mac = servicePaths({ platform: "darwin", home: "/Users/me", env: {} });
  assert.equal(mac.plistPath, path.join("/Users/me", "Library", "LaunchAgents", "local.kie.dashboard.plist"));
  assert.equal(mac.logPath, path.join("/Users/me", "Library", "Logs", "kie-dashboard.log"));

  const win = servicePaths({ platform: "win32", home: "C:\\Users\\me", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } });
  assert.equal(win.scriptPath, path.join("C:\\Users\\me\\AppData\\Local", "kie", "dashboard.cmd"));
  assert.equal(win.launcherPath, path.join("C:\\Users\\me\\AppData\\Local", "kie", "dashboard.vbs"));

  assert.throws(() => servicePaths({ platform: "linux", home: "/home/me", env: {} }), /no service backend/);
});
