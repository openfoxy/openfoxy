const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION_DIR = path.join(ROOT, "extension");
const CHROME = path.join(
  ROOT,
  "chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const TEST_URL = "https://icanhazip.com/";

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
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function connectExtension(sw, profile) {
  const expression = `(async () => {
    const profile = ${JSON.stringify(profile)};
    const settings = { killSwitch: true };
    if (typeof connectProfile === "function") return connectProfile(profile, settings);
    return new Promise((resolve) => chrome.runtime.sendMessage({ type: "connect", profile, settings }, resolve));
  })()`;
  const result = await evaluate(sw, expression);
  assert(
    result && result.ok,
    `Extension connect failed for ${profile.protocol}: ${JSON.stringify(result)}`,
  );
}

async function disconnectExtension(sw) {
  await evaluate(
    sw,
    `(async () => {
    if (typeof disconnectProfile === "function") return disconnectProfile();
    return new Promise((resolve) => chrome.runtime.sendMessage({ type: "disconnect" }, resolve));
  })()`,
  );
}

async function proxyConfig(sw) {
  return evaluate(
    sw,
    `new Promise((resolve) => chrome.proxy.settings.get({ incognito: false }, (config) => resolve(config.value)))`,
  );
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
  assert(fs.existsSync(CHROME), `Chrome for Testing not found at ${CHROME}`);
  assert(fs.existsSync(path.join(EXTENSION_DIR, "manifest.json")), "Extension manifest not found.");

  await Promise.all([waitForPort(18080), waitForPort(11080), waitForPort(18083)]);

  const debugPort = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfoxy-cft-"));
  const chrome = spawn(
    CHROME,
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
    await sleep(1000);

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
        expectProxy: "SOCKS5 127.0.0.1:11080",
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
        await connectExtension(sw, testCase.profile);
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
    } catch {}
  }
}

main().catch((error) => {
  console.error(`Browser extension e2e failed: ${error.message}`);
  process.exit(1);
});
