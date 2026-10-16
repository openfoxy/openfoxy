# E2E Test Suite

Docker-based end-to-end tests that validate every OpenFoxy protocol, CLI command, and network flow against real proxy daemons.

## Quick Start

```bash
npm run test:e2e
```

Run the separate two-container residential simulation:

```bash
npm run test:e2e:residential
```

Run the real browser-extension proxy test locally after installing Chrome for Testing under `chrome/`:

```bash
npm run test:browser
```

`test:browser` starts the browser proxy stack, loads the unpacked extension in Chrome for Testing, verifies browser traffic through HTTP and residential profiles, and verifies that authenticated SOCKS5 profiles are rejected with a clear Chrome compatibility error. Authenticated SOCKS5 remains supported by OpenFoxy for clients that implement SOCKS5 username/password auth directly.

## Folder Layout

| Path                                   | Purpose                                                               |
| -------------------------------------- | --------------------------------------------------------------------- |
| `e2e/tests/*.sh`                       | Main protocol and CLI e2e assertions sourced by `run.sh`.             |
| `e2e/run.sh`                           | Main Docker e2e test orchestrator and shared shell assertion helpers. |
| `e2e/docker-compose.yml`               | Single-container e2e suite for CI and routine protocol checks.        |
| `e2e/docker-compose.two-container.yml` | Separate server/provider residential simulation.                      |
| `e2e/two-container-*.sh`               | Entrypoints for the two-container residential simulation.             |
| `e2e/docker-compose.browser.yml`       | Host-exposed proxy stack for real browser-extension tests.            |
| `e2e/browser-*.sh`                     | Entrypoints for browser e2e proxy server/provider containers.         |
| `test/*.test.js`                       | Node unit and in-process integration tests (`npm test`).              |
| `e2e/browser/extension.e2e.js`         | Chrome for Testing automation for real extension proxy routing.       |

## Architecture

```
┌──────────────────────────┐       ┌──────────────────────────┐
│         server           │       │         provider         │
│   (privileged Alpine)    │       │         (Alpine)         │
│                          │       │                          │
│  • openfoxy add …       │◄──────│  openfoxy provider      │
│  • curl tests            │ 9000  │    server:9000 --quiet   │
│  • run.sh orchestration  │       │                          │
└──────────────────────────┘       └──────────────────────────┘
           │  openfoxy-net (Docker network)
           ▼
    icanhazip.com / internet
```

- **server** — Runs the full test suite as root (privileged for iptables). Creates proxies with `openfoxy add`, then validates them with `curl`.
- **provider** — Used by the two-container and browser suites. Connects to the server's residential gateway with the generated provider token, simulating a home PC exit node.

## Test Files

| File                | Protocol    | What is tested                                                                                                        |
| ------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `01-http.sh`        | HTTP        | Squid setup, authenticated request, bad creds rejected, unauthenticated blocked, teardown.                            |
| `02-socks5.sh`      | SOCKS5      | Dante setup, authenticated request, bad creds rejected, teardown.                                                     |
| `03-mtproto.sh`     | MTProto     | mtg v2 daemon listening, FakeTLS Telegram link, list/status output, teardown.                                         |
| `04-residential.sh` | Residential | Master gateway + consumer port, provider auto-join, SOCKS5 auth relay through provider, status pool output, teardown. |
| `05-stats.sh`       | Analytics   | Traffic generation, `status` output parsing (port, protocol, traffic section, service state).                         |
| `06-limits.sh`      | Limits      | Residential data limit storage, display, immediate enforcement, and post-limit rejection.                             |
| `07-providers.sh`   | Management  | `providers` list, block/unblock IP, disconnect on block, reconnect after unblock, allowlist add/remove.               |
| `08-change.sh`      | Hot reload  | HTTP password change, old credential rejection, residential `--limit` and `--country` updates.                        |
| `09-lifecycle.sh`   | Lifecycle   | `list` output, `stop`/`start` cycle, input validation (shell injection, bad port, out-of-range port).                 |

## Extending

Add a new test file following the convention:

```bash
# e2e/tests/10-my-test.sh
section "My New Test"

openfoxy add test_user test_pass 8100 http
# ... assertions using pass(), fail(), assert_http(), etc.
openfoxy delete test_user 8100
```

Then append to `e2e/run.sh`:

```bash
source /e2e/tests/10-my-test.sh
```

## Assertion Helpers

Available in every test file (defined in `run.sh`):

| Helper                                 | Description                              |
| -------------------------------------- | ---------------------------------------- |
| `pass "desc"`                          | Record a passing assertion               |
| `fail "desc"`                          | Record a failing assertion               |
| `skip "desc"`                          | Record a skipped assertion               |
| `assert_exit "desc" cmd …`             | Assert command exits 0                   |
| `assert_fail "desc" cmd …`             | Assert command exits non-zero            |
| `assert_output "desc" "needle" cmd …`  | Assert command stdout contains string    |
| `assert_http "desc" "200" curl-opts …` | Assert curl returns specific HTTP status |
| `wait_for_port PORT [TRIES]`           | Block until TCP port is reachable        |
| `section "Title"`                      | Print a section header                   |
