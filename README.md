# 🦊 OpenFoxy

<p align="center"><img src="https://raw.githubusercontent.com/maxylev/openfoxy/refs/heads/main/assets/openfoxy-preview.svg" alt="OpenFoxy"></p>

[![NPM Version](https://img.shields.io/npm/v/openfoxy?style=flat-square&color=cb3837)](https://www.npmjs.com/package/openfoxy)
[![Tests](https://img.shields.io/github/actions/workflow/status/maxylev/openfoxy/test.yml?label=Tests&style=flat-square)](https://github.com/maxylev/openfoxy/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

**A dependency-free Node.js CLI for VPS proxy management, plus a Chromium browser extension for profile-based proxy routing.**

The npm package itself has no JavaScript dependencies. On Linux hosts it installs and configures system tools such as `Squid`, `Dante`, `MTG`, `iptables`, and the host firewall as needed.

---

## ✨ Features

- **4 Protocols Supported Native:** HTTP, SOCKS5, MTProto, and Custom Residential.
- **Lightweight Analytics:** Uses kernel `iptables` counters for system proxies and app-level counters for residential relay traffic.
- **Create Your Own Residential Network:** Link home computers to your VPS and route consumer traffic strictly through designated geographic locations.
- **Hot-Reloading:** Change passwords and add new proxies without disconnecting currently active users.
- **Provider Management:** Blacklist, whitelist, and auto-penalize misbehaving residential providers.
- **Dual-Protocol Consumers:** Residential proxies accept SOCKS5 and HTTP proxy traffic on the same port.
- **Instant Output:** Formats proxies beautifully into `user:pass@ip:port` for immediate copy-pasting.

---

## 🚀 Quick Start

Connect to your VPS and run `openfoxy` instantly via `npx` (Requires Node.js):

```bash
npx openfoxy add myuser supersecret123 8000
```

```
🚀 Deploying HTTP Proxy → Port 8000...

✅ Proxy is live.

   🌐 Ready to use: myuser:supersecret123@203.0.113.50:8000
```

---

## 📡 Supported Architectures

You can specify the protocol flag to deploy different proxy architectures natively:

### HTTP (Squid)

```bash
npx openfoxy add myuser mypass 8000 http
```

```
🚀 Deploying HTTP Proxy → Port 8000...

✅ Proxy is live.

   🌐 Ready to use: myuser:mypass@203.0.113.50:8000
```

<p align="center"><img src="https://raw.githubusercontent.com/maxylev/openfoxy/refs/heads/main/assets/openfoxy-http.svg" alt="HTTP Proxy Architecture"></p>

### SOCKS5 (Dante)

```bash
npx openfoxy add myuser mypass 8001 socks5
```

```
🚀 Deploying SOCKS5 Proxy → Port 8001...

✅ Proxy is live.

   🌐 Ready to use: myuser:mypass@203.0.113.50:8001
```

<p align="center"><img src="https://raw.githubusercontent.com/maxylev/openfoxy/refs/heads/main/assets/openfoxy-socks5.svg" alt="SOCKS5 Proxy Architecture"></p>

### MTProto (Telegram)

```bash
npx openfoxy add myuser skip 8002 mtproto
```

```
🚀 Deploying MTPROTO Proxy → Port 8002...

✅ Proxy is live.

   🌐 TG Link: tg://proxy?server=203.0.113.50&port=8002&secret=ee...bHM
```

<p align="center"><img src="https://raw.githubusercontent.com/maxylev/openfoxy/refs/heads/main/assets/openfoxy-mtproto.svg" alt="MTProto Proxy Architecture"></p>

### Residential (Distributed Relay)

```bash
npx openfoxy add res_user res_pass 8003 residential --country=US --limit=2GB
```

```
🚀 Deploying RESIDENTIAL Proxy → Port 8003...

✅ Proxy is live.

   🌐 Proxy:    res_user:res_pass@203.0.113.50:8003
   🏠 Provider: npx openfoxy provider 203.0.113.50:9000:PROVIDER_TOKEN
   🌍 Country:  US
   📊 Limit:    2 GB
```

You can specify a required country code (`--country=XX`), a strict data limit (`--limit=XGB`), and a custom gateway port (`--gateway=PORT`, default 9000). If the data limit is hit, connections are instantly severed.

```bash
# Custom gateway port (providers connect here instead of 9000)
npx openfoxy add res_user res_pass 8003 residential --gateway=5000
# → Provider: npx openfoxy provider 203.0.113.50:5000:PROVIDER_TOKEN
```

<p align="center"><img src="https://raw.githubusercontent.com/maxylev/openfoxy/refs/heads/main/assets/openfoxy-residential.svg" alt="Residential Proxy Architecture"></p>

---

## 🏠 The Residential Relay Network

OpenFoxy allows you to create your own distributed residential proxy pool (similar to BrightData or Honeygain). Home PCs connect to your Master VPS and donate their IPs. Consumers connect to your VPS, which invisibly relays the traffic to the Home PC.

### Run the Provider Script on a Home PC

Providers must use the token printed by `openfoxy add ... residential`. OpenFoxy will auto-detect the Home PC's country using public IP APIs.

```bash
npx openfoxy provider <VPS_IP>:<GATEWAY_PORT>:<PROVIDER_TOKEN>
```

```
✅ Connected! Proxying traffic globally...
```

```bash
# Suppress reconnect messages (useful for Docker / PM2 / systemd)
npx openfoxy provider < VPS_IP > : < GATEWAY_PORT > : < PROVIDER_TOKEN > --quiet

# Run it in the background / on boot
npm install -g pm2 \
  && pm2 start "npx openfoxy provider <VPS_IP>:<GATEWAY_PORT>:<PROVIDER_TOKEN>" --name "proxy-exit-node" --quiet \
  && pm2 startup
```

Providers that gracefully stop (SIGTERM/SIGINT) are disconnected without penalty. Providers that abruptly disconnect too often (>5 times in 10 minutes) are automatically blacklisted.

### Consume the Proxy

Residential proxies accept **SOCKS5**, **HTTP CONNECT**, and plain HTTP proxy requests on the same consumer port:

```bash
# SOCKS5
curl --socks5-hostname res_user:res_pass@ https://icanhazip.com < VPS_IP > :8003

# HTTP / HTTP CONNECT
curl -x http://res_user:res_pass@ https://icanhazip.com < VPS_IP > :8003
```

TLS traffic remains encrypted end-to-end between the client and destination. Provider control traffic uses an authenticated TCP channel; do not run untrusted providers unless you understand the metadata and non-TLS traffic risk.

### Manage Providers (on VPS)

Control which providers can join your network with blacklists and whitelists.

```bash
npx openfoxy providers                           # List connected / blacklisted providers
npx openfoxy providers block <ip> [reason]       # Blacklist a provider IP
npx openfoxy providers unblock <ip>              # Remove IP from blacklist
npx openfoxy providers whitelist <ip>            # Restrict to only whitelisted IPs
npx openfoxy providers unwhitelist <ip>          # Remove IP from whitelist
```

```
🏠 Provider Management
══════════════════════════════════════════════════════════

🟢 Connected (2):
   └─ 198.51.100.22 [US] — since Apr 28 14:30 UTC
   └─ 203.0.113.85 [DE] — since Apr 28 14:32 UTC

🚫 Blacklisted (1):
   └─ 192.0.2.66 — suspicious (Apr 28 15:00 UTC)

══════════════════════════════════════════════════════════
```

---

## 📊 CLI Command Reference & Analytics

### `list` — List All Proxies

```bash
npx openfoxy list
```

```
🦊 OpenFoxy — Active Proxies
══════════════════════════════════════════════════════════
🟢 HTTP             → myuser:mypass@203.0.113.50:8000
🟢 SOCKS5           → myuser:mypass@203.0.113.50:8001
🟢 MTPROTO          → tg://proxy?server=203.0.113.50&port=8002&secret=ee...bHM
🟢 RESIDENTIAL [US] → res_user:res_pass@203.0.113.50:8003 (15% of 2 GB)
🟡 RESIDENTIAL [DE] → res_user2:res_pass2@203.0.113.50:8004 (85% of 1 GB)
🔴 RESIDENTIAL [US] → res_user3:res_pass3@203.0.113.50:8005 ✖ LIMIT REACHED (500 MB)
══════════════════════════════════════════════════════════
```

### `status` — Analytics Dashboard

```bash
npx openfoxy status
```

```
📊 OpenFoxy — Status & Analytics
══════════════════════════════════════════════════════════
🛠️  Core Services:
   ├─ HTTP (Squid):    🟢 RUNNING
   ├─ SOCKS5 (Dante):  🟢 RUNNING
   ├─ Master Gateway:  🟢 RUNNING
   └─ MTProto :8002    🟢 RUNNING

📈 Traffic by Port:
   ├─ Port 8000 [HTTP]
   │  └─ Data: 1.2 GB IN / 856.4 MB OUT
   ├─ Port 8001 [SOCKS5]
   │  └─ Data: 512.0 KB IN / 256.0 KB OUT
   └─ Port 8003 [RESIDENTIAL]
      ├─ Limit: [████░░░░░░░░░░░░░░░░░] 450.2 MB / 2 GB (22%)
      └─ Data:  450.2 MB IN / 312.8 MB OUT

🏠 Residential Provider Pool:
   🌍 US: 2 Nodes Active
      ├─ 198.51.100.22 — 85.3 MB IN / 52.1 MB OUT
      ├─ 203.0.113.85 — 43.2 MB IN / 32.1 MB OUT
      └─ Subtotal: 128.5 MB IN / 84.2 MB OUT
   🌍 DE: 1 Node Active
      ├─ 192.0.2.10 — 42.0 MB IN / 31.2 MB OUT
      └─ Subtotal: 42.0 MB IN / 31.2 MB OUT

   📊 Total: 3 Nodes — 170.5 MB IN / 115.4 MB OUT
══════════════════════════════════════════════════════════
```

```
📊 OPENFOXY STATUS & ANALYTICS
═════════════════════════════════════════════════════════
🛠️  CORE SERVICES:
   ├─ HTTP (Squid):    🟢 RUNNING
   ├─ SOCKS5 (Dante):  🟢 RUNNING
   ├─ Master Gateway:  🟢 RUNNING
   └─ MTProto :8002    🟢 RUNNING

📈 TRAFFIC BY PORT:
   ├─ Port 8000 [HTTP]
   │  └─ Data: 1.2 GB IN / 856.4 MB OUT
   ├─ Port 8001 [SOCKS5]
   │  └─ Data: 512.0 KB IN / 256.0 KB OUT
   ├─ Port 8003 [RESIDENTIAL] (Limit: 2.00 GB)
   │  └─ Data: 450.2 MB IN / 312.8 MB OUT

🏠 RESIDENTIAL PROVIDER POOL:
   🌍 US: 2 Nodes Active
      ├─ 198.51.100.22 — 85.3 MB IN / 52.1 MB OUT
      ├─ 203.0.113.85 — 43.2 MB IN / 32.1 MB OUT
      └─ Subtotal: 128.5 MB IN / 84.2 MB OUT
   🌍 DE: 1 Node Active
      ├─ 192.0.2.10 — 42.0 MB IN / 31.2 MB OUT
      └─ Subtotal: 42.0 MB IN / 31.2 MB OUT

   📊 Total: 3 Nodes — 170.5 MB IN / 115.4 MB OUT
═════════════════════════════════════════════════════════
```

### `change` — Hot-Reload Settings

```bash
npx openfoxy change myuser newsecret456
```

```
✅ Updated 'myuser': password.
```

Live-updates the password across all protocols for that user without dropping active connections.

For residential proxies, you can also hot-reload the data limit and country filter:

```bash
npx openfoxy change res_user --limit=5GB
npx openfoxy change res_user --country=DE
npx openfoxy change res_user newpass --limit=5GB --country=DE
```

Remove a limit or clear the country filter:

```bash
npx openfoxy change res_user --limit=0
npx openfoxy change res_user --country=
```

### `delete` — Remove a Proxy

```bash
npx openfoxy delete myuser 8000
```

```
✅ Deleted http proxy on port 8000.
```

Deletes the proxy, closes the firewall port, and only removes shared OS/auth users when no remaining proxy still uses them.

### `stop` / `start` — Halt or Resume Proxies

```bash
npx openfoxy stop 8000        # Stop a specific port
npx openfoxy start http       # Start all HTTP proxies
npx openfoxy stop residential # Stop the master gateway (disconnects all providers)
npx openfoxy stop             # Stop everything
```

```
✅ Stopped requested services.
```

Note: `stop residential` stops the master gateway daemon (all providers disconnect). `stop <port>` stops a specific consumer proxy but keeps the gateway running (providers stay connected).

### `uninstall` — Nuclear Option

```bash
npx openfoxy uninstall
```

```
⚠️  Removing OpenFoxy...

✅ Uninstallation complete. System is clean.
```

Removes all proxies, databases, firewall rules, and service files.

---

## 🧩 Browser Extension

The `extension/` folder contains a Chromium MV3 extension for browser-only proxy profiles.

- Routes browser traffic through HTTP, SOCKS5, residential, include/exclude, or PAC profiles.
- Handles proxy authentication in the background service worker.
- Uses declarative rules for tracker blocking and supported request-header changes.
- Injects lightweight page-level fingerprint masking for navigator, screen, timezone, canvas, audio, WebGL, and selected permission APIs.
- The kill switch avoids direct fallback in generated PAC rules by routing blocked/failing cases to `127.0.0.1:9`.

Limitations: browser APIs do not provide full VPN-level protection. The extension does not claim OS-wide WebRTC, DNS-over-HTTPS, cookie container, or notification-leak protection.

---

## 🐳 Docker Container Usage

If you prefer containers, OpenFoxy has an optimized Alpine-based Docker image available. Each container runs exactly one proxy — map the port with `-p`.

### HTTP Proxy

```bash
docker run -d -p 8000:8000 --name http-proxy ghcr.io/maxylev/openfoxy:latest myuser mypass 8000 http
```

Use: `curl -x http://myuser:mypass@<VPS_IP>:8000 https://example.com`

### SOCKS5 Proxy

```bash
docker run -d -p 8001:8001 --name socks-proxy ghcr.io/maxylev/openfoxy:latest myuser mypass 8001 socks5
```

Use: `curl --socks5-hostname myuser:mypass@<VPS_IP>:8001 https://example.com`

### MTProto Proxy (Telegram)

```bash
docker run -d -p 8002:8002 --name mtproto-proxy ghcr.io/maxylev/openfoxy:latest myuser mtpass 8002 mtproto
```

The generated `tg://proxy?...` link appears in the container logs: `docker logs mtproto-proxy`

### Residential Master

Residential mode runs **two ports** inside one container:

- **Gateway port** (default 9000) — where Home PC providers connect
- **Consumer port** (e.g., 8003) — accepts SOCKS5 and HTTP proxy traffic, relays through providers

Both ports must be published. You can pass `--country=`, `--limit=`, and `--gateway=` flags:

```bash
# Default gateway (9000)
docker run -d \
  -p 8003:8003 \
  -p 9000:9000 \
  --name residential-proxy \
  ghcr.io/maxylev/openfoxy:latest \
  res_user res_pass 8003 residential --country=US --limit=2GB

# Custom gateway port (5000)
docker run -d \
  -p 8003:8003 \
  -p 5000:5000 \
  --name residential-proxy \
  ghcr.io/maxylev/openfoxy:latest \
  res_user res_pass 8003 residential --country=US --gateway=5000
```

Read the provider token from the container logs or `/etc/openfoxy.json`, then on a **Home PC**, run the provider to donate your IP:

```bash
# Use the gateway port from the --gateway flag (or 9000 by default)
npx openfoxy provider <VPS_IP>:9000:<PROVIDER_TOKEN>
```

```bash
# SOCKS5
curl --socks5-hostname res_user:res_pass@ https://icanhazip.com < VPS_IP > :8003

# HTTP / HTTP CONNECT
curl -x http://res_user:res_pass@ https://icanhazip.com < VPS_IP > :8003
```

Manage providers from inside the container:

```bash
docker exec residential-proxy openfoxy providers
docker exec residential-proxy openfoxy providers block 1.2.3.4 suspicious
docker exec residential-proxy openfoxy providers whitelist 5.6.7.8
```

---

## Development

Install development tooling once:

```bash
npm install
```

Format all project files supported by Prettier:

```bash
npm run format
```

Check formatting without writing changes:

```bash
npm run format:check
```

The repository uses Husky + lint-staged. After `npm install`, staged `js`, `json`, `md`, `yml`, `yaml`, `css`, `html`, and `sh` files are automatically formatted before each commit. Large generated directories such as `chrome/` are excluded by `.prettierignore`.

Run the Node sanity tests:

```bash
npm test
```

## 🧪 End-to-End Testing

OpenFoxy includes a full Docker-based E2E test suite that validates all protocols, traffic analytics, data limits, password hot-reloading, provider management (blacklist/whitelist/graceful disconnect), and the complete residential relay flow.

```bash
npm run test:e2e
```

Run the separate two-container residential simulation:

```bash
npm run test:e2e:residential
```

The suite spins up a **Server** container (runs all proxy services) and a **Provider** container (simulates a Home PC exit node), then runs a comprehensive test battery covering every CLI command and network flow.

---

## 🛡️ License

This project is licensed under the MIT License.
