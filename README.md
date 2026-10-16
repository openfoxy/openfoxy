# 🦊 OpenFoxy

<p align="center"><img src="https://raw.githubusercontent.com/openfoxy/openfoxy/refs/heads/main/assets/openfoxy-preview.svg" alt="OpenFoxy"></p>

[![NPM Version](https://img.shields.io/npm/v/openfoxy?style=flat-square&color=cb3837)](https://www.npmjs.com/package/openfoxy)
[![Tests](https://img.shields.io/github/actions/workflow/status/openfoxy/openfoxy/test.yml?label=Tests&style=flat-square)](https://github.com/openfoxy/openfoxy/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

**A dependency-free Node.js CLI that turns a Linux server into an HTTP, SOCKS5, MTProto, or residential proxy, plus a Chromium extension for profile-based browser routing.**

The npm package has no runtime dependencies. On the server it installs and configures `Squid`, `Dante`, and [`mtg`](https://github.com/9seconds/mtg) as needed, and runs its own relay for residential proxies.

---

## ✨ Features

- **Four protocols:** HTTP (Squid), SOCKS5 (Dante), MTProto/FakeTLS (mtg v2), and residential.
- **Your own residential network:** home machines connect out to your server and act as exit nodes; consumers can pin a country.
- **Hard traffic quotas:** residential proxies are cut off the moment their `--limit` is reached.
- **Live changes:** passwords, limits, and countries apply without dropping other users.
- **Safe defaults:** strict input validation, no shell interpolation, proxies cannot reach the server's own `localhost`, and providers refuse to relay into their home network.
- **Traffic analytics:** iptables counters for system proxies, exact app-level counters for residential.

## 📋 Requirements

- Linux server running Alpine, Debian/Ubuntu, or a RHEL-compatible distribution with **systemd or OpenRC**.
- **Node.js 22 or newer** and root access (`sudo`).
- Provider machines only need Node.js 22+ (any OS).

> Residential proxies run a background service that points at the installed CLI. Install globally (`npm install -g openfoxy`) so the service keeps working after the npx cache is cleaned.

---

## 🚀 Quick start

```bash
sudo npx openfoxy add myuser supersecret123 8000
```

```
🚀 Deploying HTTP proxy on port 8000...

✅ Proxy is live.

   🌐 Ready to use: http://myuser:supersecret123@203.0.113.50:8000
```

## 📡 Protocols

### HTTP (Squid)

```bash
sudo openfoxy add myuser mypass 8000 http
```

<p align="center"><img src="https://raw.githubusercontent.com/openfoxy/openfoxy/refs/heads/main/assets/openfoxy-http.svg" alt="HTTP proxy architecture"></p>

### SOCKS5 (Dante)

```bash
sudo openfoxy add myuser mypass 8001 socks5
```

Dante authenticates against local accounts, so OpenFoxy creates a login-less account per SOCKS5 user. Accounts it did not create (e.g. `root`) are never touched; choose another username if one already exists.

<p align="center"><img src="https://raw.githubusercontent.com/openfoxy/openfoxy/refs/heads/main/assets/openfoxy-socks5.svg" alt="SOCKS5 proxy architecture"></p>

### MTProto (Telegram)

```bash
sudo openfoxy add myuser auto 8002 mtproto --domain=www.cloudflare.com
```

```
✅ Proxy is live.

   🌐 Telegram: tg://proxy?server=203.0.113.50&port=8002&secret=ee…
```

Pass an existing FakeTLS secret (`ee…` hex) as the password to reuse it, or any other word to generate one. `--domain` sets the domain used for TLS fronting (default `www.cloudflare.com`).

<p align="center"><img src="https://raw.githubusercontent.com/openfoxy/openfoxy/refs/heads/main/assets/openfoxy-mtproto.svg" alt="MTProto proxy architecture"></p>

### Residential (distributed relay)

```bash
sudo openfoxy add res_user res_pass 8003 residential --country=US --limit=2GB
```

```
✅ Proxy is live.

   🌐 Proxy:    http://res_user:res_pass@203.0.113.50:8003  (HTTP and SOCKS5)
   🏠 Provider: npx openfoxy provider 203.0.113.50:9000:PROVIDER_TOKEN
   🌍 Country:  US
   📊 Limit:    2 GB
```

| Option           | Meaning                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `--country=XX`   | Only relay through providers located in this country (ISO 3166-1 alpha-2).     |
| `--limit=SIZE`   | Traffic cap (`500MB`, `2GB`, …). Connections are cut as soon as it is reached. |
| `--gateway=PORT` | Port providers connect to (default `9000`). Shared by all residential proxies. |

<p align="center"><img src="https://raw.githubusercontent.com/openfoxy/openfoxy/refs/heads/main/assets/openfoxy-residential.svg" alt="Residential proxy architecture"></p>

---

## 🏠 The residential network

Home machines ("providers") open an outbound connection to your server's gateway port and donate their IP address. Consumers connect to your server, which relays each connection through a provider. One master service handles every residential proxy and picks up configuration changes within two seconds.

### Run a provider

Use the command printed by `openfoxy add … residential`:

```bash
npx openfoxy provider "$SERVER_IP:9000:$PROVIDER_TOKEN"
```

```
✅ Connected. Relaying traffic for the gateway.
```

- `--quiet` hides connection messages (useful under systemd, PM2, or Docker).
- Providers only open connections to **public** addresses; requests for `localhost`, private, or link-local networks are refused so consumers cannot reach the provider's LAN. `--allow-private-targets` disables this protection (testing only).
- Stopping with Ctrl+C/SIGTERM disconnects gracefully. Providers that drop off abruptly five times within ten minutes are banned for one hour.
- The provider's country is looked up from its public IP. Set `OPENFOXY_IPINFO_TOKEN` on the server to use IPinfo instead of the keyless public APIs.

### Use the proxy

One port accepts SOCKS5, HTTP `CONNECT`, and plain `http://` proxy requests:

```bash
curl --socks5-hostname "res_user:res_pass@$SERVER_IP:8003" https://icanhazip.com
curl --proxy "http://res_user:res_pass@$SERVER_IP:8003" https://icanhazip.com
```

TLS traffic stays end-to-end encrypted between the consumer and the destination; providers see destinations and any unencrypted traffic, so only use providers you trust.

### Manage providers

```bash
sudo openfoxy providers                      # connected, banned, blocked, allowlisted
sudo openfoxy providers block <ip> [reason]  # disconnect and refuse an IP
sudo openfoxy providers unblock <ip>
sudo openfoxy providers allow <ip>           # once any IP is allowlisted, only those may join
sudo openfoxy providers disallow <ip>
```

```
🏠 Residential providers
══════════════════════════════════════════════════════════

🟢 Connected (2):
   └─ 198.51.100.22 [US] since Oct 16, 14:30 UTC
   └─ 203.0.113.85 [DE] since Oct 16, 14:32 UTC

🚫 Blocked (1):
   └─ 192.0.2.66: suspicious (Oct 16, 15:00 UTC)
```

---

## 📊 Command reference

| Command                                                  | Description                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `add <user> <pass> <port> [protocol] [options]`          | Create a proxy (`http` by default).                                        |
| `change <user> [newpass] [--limit=SIZE\|0] [--country=]` | Update a user's password (all their proxies) or residential limit/country. |
| `delete <user> <port>`                                   | Remove a proxy, its firewall rule, and its account when no longer used.    |
| `stop [port\|protocol]` / `start [port\|protocol]`       | Disable or re-enable proxies; all of them when no target is given.         |
| `list`                                                   | Connection strings with usage against limits.                              |
| `status`                                                 | Service health, traffic per port, and the provider pool.                   |
| `providers …`                                            | Provider list and access control (see above).                              |
| `provider <host>:<port>:<token>`                         | Run a residential exit node.                                               |
| `uninstall`                                              | Remove all proxies, services, accounts, firewall rules, and OpenFoxy data. |

Every command validates its arguments before changing anything, rejects unknown options, and exits non-zero on failure (`2` for usage errors).

```
📊 OpenFoxy: status
══════════════════════════════════════════════════════════
🛠️  Services:
   ├─ HTTP (Squid)                🟢 RUNNING
   ├─ Residential gateway :9000   🟢 RUNNING
   └─ MTProto :8002               🟢 RUNNING

📈 Traffic:
   ├─ Port 8000 [HTTP]
   │  └─ Data: 1.2 GB IN / 856.4 MB OUT
   └─ Port 8003 [RESIDENTIAL]
      ├─ Limit: [████░░░░░░░░░░░░░░░░] 450.2 MB / 2 GB (22%)
      └─ Data:  412.8 MB IN / 37.4 MB OUT

🏠 Residential provider pool:
   🌍 US: 2 nodes
      ├─ 198.51.100.22: 85.3 MB IN / 52.1 MB OUT, 3 streams
      ├─ 203.0.113.85: 43.2 MB IN / 32.1 MB OUT, 1 stream

   📊 Total: 2 nodes: 128.5 MB IN / 84.2 MB OUT
══════════════════════════════════════════════════════════
```

### Files

| Path                               | Contents                                                         |
| ---------------------------------- | ---------------------------------------------------------------- |
| `/etc/openfoxy/config.json`        | Proxies, credentials, gateway port, and provider token (`0600`). |
| `/etc/openfoxy/access.json`        | Provider block list and allowlist.                               |
| `/var/lib/openfoxy/traffic.json`   | Residential traffic counters.                                    |
| `/var/lib/openfoxy/providers.json` | Connected and temporarily banned providers.                      |

Both directories can be relocated with `OPENFOXY_CONFIG_DIR` and `OPENFOXY_STATE_DIR`.

---

## 🐳 Docker

Each container runs exactly one proxy in the foreground; publish its port with `-p`.

```bash
docker run -d -p 8000:8000 --name http-proxy ghcr.io/openfoxy/openfoxy myuser mypass 8000 http
docker run -d -p 8001:8001 --name socks-proxy ghcr.io/openfoxy/openfoxy myuser mypass 8001 socks5
docker run -d -p 8002:8002 --name mtproto-proxy ghcr.io/openfoxy/openfoxy myuser auto 8002 mtproto
```

The Telegram link and connection strings are printed to the container log (`docker logs mtproto-proxy`).

Residential mode needs both the consumer port and the gateway port:

```bash
docker run -d -p 8003:8003 -p 9000:9000 -v openfoxy:/etc/openfoxy --name residential-proxy \
  ghcr.io/openfoxy/openfoxy res_user res_pass 8003 residential --country=US --limit=2GB
docker logs residential-proxy                      # shows the provider command
docker exec residential-proxy openfoxy providers   # manage providers
```

Mount `/etc/openfoxy` as a volume to keep the provider token across container restarts.

Image tags: `latest` and `X`, `X.Y`, `X.Y.Z` for releases; `edge` and `sha-<commit>` track `main`.

---

## 🧩 Browser extension

`extension/` contains a Chromium (MV3, Chrome 111+) extension for browser-only proxy profiles:

- Routes traffic through HTTP, residential, or unauthenticated SOCKS5 profiles, for all sites, include/exclude lists, or a PAC script.
- Answers HTTP/residential proxy authentication challenges only for the active proxy.
- Kill switch: generated PAC rules never fall back to a direct connection.
- Tracker blocking and request-header changes via declarative rules; page-level masking of navigator, screen, timezone, canvas, audio, WebGL, font probing, and selected permission APIs.

Limitations: browser APIs do not provide VPN-level protection. Chrome cannot authenticate SOCKS5 proxies from extensions, so authenticated SOCKS5 profiles are rejected; use an HTTP or residential profile instead. WebRTC, DNS-over-HTTPS, and OS-wide traffic are out of scope.

Load it via `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.

---

## 🛠️ Development

```bash
npm install          # dev tooling and Git hooks
npm run check        # format check, ESLint, and unit/integration tests
npm test             # node --test: CLI, validation, relay protocol, extension
npm run format       # Prettier
```

Docker end-to-end suites (real Squid, Dante, mtg, OpenRC, and iptables):

```bash
npm run test:e2e              # every protocol and CLI command on one host
npm run test:e2e:residential  # server and provider in separate containers
OPENFOXY_CHROME_PATH="/path/to/chrome" npm run test:browser  # real extension routing
```

See [`e2e/README.md`](e2e/README.md) for the suite layout.

### Releasing

Pushes and pull requests to `main` run CI (`.github/workflows/ci.yml`); a green push to `main`
also publishes the `edge` Docker image. To release, add a `## X.Y.Z` section to `CHANGELOG.md`,
set the same version in `extension/manifest.json`, commit both, then:

```bash
npm version X.Y.Z -m "Release v%s"   # bumps package.json/lockfile, commits, tags vX.Y.Z
git push --follow-tags
```

The tag triggers `release.yml`: it checks that the tag, `package.json`, the extension manifest, and
the changelog agree and that the commit is on `main`, runs the full CI, publishes to npm (with
provenance) and GHCR in parallel, then creates the GitHub Release with the changelog notes and the
extension archive. Tags with a suffix (`v2.1.0-rc.1`) publish as pre-releases under npm's `next` tag.

npm publishing uses [trusted publishing](https://docs.npmjs.com/trusted-publishers): register
`openfoxy/openfoxy`, workflow `release.yml`, environment `npm` on npmjs.com. An `NPM_TOKEN`
repository secret is used as a fallback when set.

### Layout

| Path               | Contents                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `bin/openfoxy.js`  | CLI entry point.                                                         |
| `src/cli.js`       | Argument parsing and command dispatch.                                   |
| `src/commands/`    | Command implementations.                                                 |
| `src/backends/`    | Squid, Dante, and mtg configuration.                                     |
| `src/system/`      | Process execution, distro/service-manager detection, firewall, accounts. |
| `src/residential/` | Relay wire protocol, stream multiplexer, master daemon, provider client. |
| `test/`            | `node --test` suites.                                                    |
| `e2e/`             | Docker end-to-end suites.                                                |
| `extension/`       | Chromium extension.                                                      |

## 🛡️ License

MIT
