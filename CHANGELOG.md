# Changelog

## 2.0.0

A ground-up refactor. Not compatible with 1.x configuration, providers, or extension storage:
run `openfoxy uninstall` with 1.x before upgrading, then re-create proxies and providers.

### Fixed

- MTProto never started: mtg v2 is now launched with `simple-run` and FakeTLS secrets.
- SOCKS5 users could take over existing system accounts (e.g. `add root … socks5` changed
  root's password); Dante now only accepts OpenFoxy-managed accounts.
- Shell injection through the MTProto secret in Docker mode; all commands now run without a shell.
- Residential relay: proxy credentials leaked to origin servers on keep-alive HTTP, consumers
  could reach a provider's LAN/localhost, split TCP segments broke handshakes, unbounded
  buffering, IPv6 provider addresses were mangled, and limits were only enforced every 10 s.
- Squid auth was skipped on Debian (commented default config matched), failures exited with
  status 0, `providers block` reported success when it could not save, `stop <port>` stopped
  the whole residential daemon, and `uninstall` left MTProto daemons running.
- Extension: opening the popup reset traffic stats, popup and service worker overwrote each
  other's storage, and `page.js` was web-accessible (extension fingerprinting).

### Changed

- ES modules split into `bin/`, `src/`; Node.js 22+; `node --test`; ESLint 10; Prettier 3.9.
- Binary, flow-controlled relay protocol; one provider token per server; temporary (1 h)
  auto-bans instead of permanent auto-blacklisting.
- Config in `/etc/openfoxy/`, state in `/var/lib/openfoxy/`.
- `stop`/`start` enable or disable individual proxies; `providers allow|disallow` replace
  `whitelist|unwhitelist`.
- Docker image on Alpine 3.24 with mtg built in; CI uses `npm ci`, provenance, semver tags.
