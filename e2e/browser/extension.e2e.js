// Drives a real Chrome with the unpacked extension through CDP. The docker compose browser
// stack (e2e/docker-compose.browser.yml) provides the HTTP (18080), SOCKS5 (11080) and
// residential (18083) proxies on localhost.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION_DIR = path.join(ROOT, "extension");
const TEST_URL = "https://icanhazip.com/";

function chromeCandidates() {
  const candidates = [];
  if (process.env.OPENFOXY_CHROME_PATH) candidates.push(process.env.OPENFOXY_CHROME_PATH);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.env.GOOGLE_CHROME_SHIM) candidates.push(process.env.GOOGLE_CHROME_SHIM);

  const bundledChromeDir = path.join(ROOT, "chrome");
  if (fs.existsSync(bundledChromeDir)) {
    for (const channelDir of fs.readdirSync(bundledChromeDir)) {
      candidates.push(
        path.join(
          bundledChromeDir,
          channelDir,
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        path.join(
          bundledChromeDir,
          channelDir,
          "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        path.join(bundledChromeDir, channelDir, "chrome-linux64/chrome"),
        path.join(bundledChromeDir, channelDir, "chrome-win64/chrome.exe"),
        path.join(bundledChromeDir, channelDir, "chrome-win32/chrome.exe"),
      );
    }
  }

  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    );
  } else if (process.platform === "linux") {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  } else if (process.platform === "win32") {
    const suffix = "Google/Chrome/Application/chrome.exe";
    candidates.push(
      path.join(process.env.PROGRAMFILES || "C:/Program Files", suffix),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)", suffix),
      path.join(process.env.LOCALAPPDATA || "", suffix),
    );
  }

  return candidates;
}

function resolveChrome() {
  return chromeCandidates().find((candidate) => candidate && fs.existsSync(candidate));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForPort(port, host = "127.0.0.1", timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs)
          reject(new Error(`Timed out waiting for ${host}:${port}`));
        else setTimeout(attempt, 500);
      });
    }
    attempt();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result || {});
        } else if (message.method) {
          this.events.push(message);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function waitForTarget(port, predicate, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find(predicate);
    if (target) return target;
    await sleep(500);
  }
  throw new Error("Timed out waiting for Chrome DevTools target.");
}

async function evaluate(client, expression, awaitPromise = true) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime.evaluate failed",
    );
  }
  return result.result?.value;
}

// Runs a service-worker function that returns a promise and polls for its JSON result,
// because Runtime.evaluate cannot await promises from the worker reliably across restarts.
async function runInWorker(sw, call) {
  await evaluate(
    sw,
    `(() => {
    globalThis.__openFoxyE2eResult = "pending";
    ${call}
      .then((result) => { globalThis.__openFoxyE2eResult = JSON.stringify(result); })
      .catch((error) => { globalThis.__openFoxyE2eResult = JSON.stringify({ ok: false, error: error.message }); });
    return true;
  })()`,
  );
  return waitForWorkerResult(sw);
}

function connectExtension(sw, profile) {
  return runInWorker(sw, `connectProfile(${JSON.stringify(profile)}, { killSwitch: true })`);
}

function disconnectExtension(sw) {
  return runInWorker(sw, "disconnectProfile()");
}

function readSession(sw) {
  return runInWorker(
    sw,
    `chrome.storage.local.get("openfoxy.session").then((data) => data["openfoxy.session"] || null)`,
  );
}

async function proxyConfig(sw) {
  const result = await evaluate(
    sw,
    `(async () => JSON.stringify(await new Promise((resolve) => chrome.proxy.settings.get({ incognito: false }, (config) => resolve(config.value)))))()`,
  );
  return JSON.parse(result || "null");
}

async function waitForWorkerResult(sw, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await evaluate(sw, "globalThis.__openFoxyE2eResult || null", true).catch(
      () => null,
    );
    if (result && result !== "pending") return JSON.parse(result);
    await sleep(100);
  }
  throw new Error("Timed out waiting for extension service worker result.");
}

async function waitForWorkerApi(sw, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await evaluate(sw, 'typeof connectProfile === "function"', true).catch(
      () => false,
    );
    if (ready) return;
    await sleep(250);
  }
  throw new Error("Timed out waiting for the extension service worker to expose connectProfile.");
}

async function newPage(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  if (!response.ok) throw new Error(`Unable to create Chrome page: HTTP ${response.status}`);
  const target = await response.json();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  return client;
}

async function navigateAndRead(page, url, timeoutMs = 30000) {
  page.events.length = 0;
  await page.send("Page.navigate", { url });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = await evaluate(
      page,
      "document.body ? document.body.innerText.trim() : ''",
      true,
    ).catch(() => "");
    if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text)) return text;
    const failedEvent = page.events.find(
      (event) => event.method === "Network.loadingFailed" && event.params?.type === "Document",
    );
    if (failedEvent) throw new Error(`Navigation failed: ${failedEvent.params.errorText}`);
    const failed = await evaluate(
      page,
      "document.body && /ERR_|This site can't be reached|Proxy/.test(document.documentElement.innerText)",
      true,
    ).catch(() => false);
    if (failed) {
      const html = await evaluate(page, "document.documentElement.innerText", true).catch(() => "");
      throw new Error(`Navigation failed: ${html}`);
    }
    await sleep(500);
  }
  throw new Error(`Timed out reading ${url}`);
}

async function main() {
  const chromePath = resolveChrome();
  assert(
    chromePath,
    `Chrome executable not found. Set OPENFOXY_CHROME_PATH to a Chrome/Chromium executable. Checked: ${chromeCandidates().join(", ")}`,
  );
  assert(fs.existsSync(path.join(EXTENSION_DIR, "manifest.json")), "Extension manifest not found.");

  await Promise.all([waitForPort(18080), waitForPort(11080), waitForPort(18083)]);

  const debugPort = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfoxy-cft-"));
  const chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=DialMediaRouteProvider",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForPort(debugPort, "127.0.0.1", 60000);
    const swTarget = await waitForTarget(
      debugPort,
      (target) =>
        target.type === "service_worker" &&
        /chrome-extension:\/\/[^/]+\/background\.js$/.test(target.url),
      60000,
    );
    const extensionId = swTarget.url.match(/^chrome-extension:\/\/([^/]+)/)[1];
    assert(extensionId, "Extension id not found.");

    const sw = new CdpClient(swTarget.webSocketDebuggerUrl);
    await sw.connect();
    await sw.send("Runtime.enable");
    await waitForWorkerApi(sw);

    const page = await newPage(debugPort, "about:blank");
    await page.send("Network.enable");
    const cases = [
      {
        name: "HTTP",
        expectProxy: "PROXY 127.0.0.1:18080",
        profile: {
          name: "HTTP e2e",
          protocol: "http",
          host: "127.0.0.1",
          port: "18080",
          user: "browser_http",
          pass: "http_pass",
          activation: "all",
        },
      },
      {
        name: "SOCKS5",
        expectError: "cannot authenticate SOCKS5",
        profile: {
          name: "SOCKS5 e2e",
          protocol: "socks5",
          host: "127.0.0.1",
          port: "11080",
          user: "browser_socks",
          pass: "socks_pass",
          activation: "all",
        },
      },
      {
        name: "Residential",
        expectProxy: "PROXY 127.0.0.1:18083",
        profile: {
          name: "Residential e2e",
          protocol: "residential",
          host: "127.0.0.1",
          port: "18083",
          user: "browser_res",
          pass: "res_pass",
          activation: "all",
        },
      },
    ];

    const results = [];
    const failures = [];
    for (const testCase of cases) {
      console.log(`Testing ${testCase.name} profile...`);
      try {
        const connectResult = await connectExtension(sw, testCase.profile);
        if (testCase.expectError) {
          assert(
            connectResult &&
              !connectResult.ok &&
              String(connectResult.error || "").includes(testCase.expectError),
            `${testCase.name} did not return expected error: ${JSON.stringify(connectResult)}.`,
          );
          results.push(`${testCase.name}: rejected authenticated profile`);
          continue;
        }
        assert(
          connectResult && connectResult.ok,
          `Extension connect failed for ${testCase.profile.protocol}: ${JSON.stringify(connectResult)}`,
        );
        const session = await readSession(sw);
        assert(session?.connected === true, `${testCase.name} did not persist session state.`);
        const config = await proxyConfig(sw);
        assert(config.mode === "pac_script", `${testCase.name} did not install PAC script.`);
        assert(
          config.pacScript?.data?.includes(testCase.expectProxy),
          `${testCase.name} PAC did not contain ${testCase.expectProxy}.`,
        );
        const body = await navigateAndRead(page, `${TEST_URL}?${Date.now()}`);
        results.push(`${testCase.name}: ${body.split(/\s+/)[0]}`);
      } catch (error) {
        failures.push(`${testCase.name}: ${error.message}`);
      } finally {
        await disconnectExtension(sw).catch(() => {});
      }
    }

    page.close();
    sw.close();
    console.log("Real Chrome extension proxy tests passed:");
    for (const result of results) console.log(`  ${result}`);
    if (failures.length) {
      console.error("Real Chrome extension proxy test failures:");
      for (const failure of failures) console.error(`  ${failure}`);
      throw new Error(`${failures.length} browser proxy case(s) failed.`);
    }
  } catch (error) {
    if (stderr) console.error(stderr);
    throw error;
  } finally {
    chrome.kill("SIGTERM");
    await sleep(1000);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Could not remove ${profileDir}: ${error.message}`);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`Browser extension e2e failed: ${error.message}`);
  process.exit(1);
}
