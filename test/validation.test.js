import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderDanteConfig } from "../src/backends/dante.js";
import { generateSecret, mtgArgv, telegramLink } from "../src/backends/mtproto.js";
import { renderSquidConfig } from "../src/backends/squid.js";
import { formatBytes, limitHealth, progressBar } from "../src/format.js";
import { isPublicAddress } from "../src/net-info.js";
import {
  isMtprotoSecret,
  normalizeIp,
  parseBytes,
  parseCountry,
  parseLimit,
  parsePort,
  requirePassword,
  requireUser,
  UsageError,
} from "../src/validation.js";

describe("validation", () => {
  it("parses byte sizes", () => {
    assert.equal(parseBytes("5KB"), 5120);
    assert.equal(parseBytes("1.5g"), 1.5 * 1024 ** 3);
    assert.equal(parseBytes("2GiB"), 2 * 1024 ** 3);
    assert.equal(parseBytes("1024"), 1024);
    for (const bad of ["", "abc", "-1MB", "0", "5XB"]) assert.equal(parseBytes(bad), null, bad);
  });

  it("parses ports strictly", () => {
    assert.equal(parsePort("8080"), 8080);
    assert.equal(parsePort(65535), 65535);
    for (const bad of ["0", "65536", "80;id", " 80a", "1e3", "", null]) {
      assert.equal(parsePort(bad), null, String(bad));
    }
  });

  it("rejects usernames that are unsafe as system accounts", () => {
    assert.equal(requireUser("alice_1"), "alice_1");
    for (const bad of ["-rf", "a;b", "1abc", "a b", "x".repeat(33), ""]) {
      assert.throws(() => requireUser(bad), UsageError, bad);
    }
  });

  it("rejects passwords with control characters", () => {
    assert.equal(requirePassword("p@ss:word"), "p@ss:word");
    assert.throws(() => requirePassword("a\nb"), UsageError);
    assert.throws(() => requirePassword(""), UsageError);
  });

  it("validates countries and limits", () => {
    assert.equal(parseCountry("de"), "DE");
    assert.equal(parseCountry(""), null);
    assert.throws(() => parseCountry("GER"), UsageError);
    assert.equal(parseLimit("10KB"), 10240);
    assert.equal(parseLimit("none", { allowClear: true }), null);
    assert.equal(parseLimit("0", { allowClear: true }), null);
    assert.throws(() => parseLimit("0"), UsageError);
  });

  it("normalizes IPv4-mapped addresses", () => {
    assert.equal(normalizeIp("::ffff:203.0.113.5"), "203.0.113.5");
    assert.equal(normalizeIp("2001:DB8::1"), "2001:db8::1");
  });

  it("classifies public and non-public addresses", () => {
    assert.ok(isPublicAddress("1.1.1.1"));
    assert.ok(isPublicAddress("2606:4700:4700::1111"));
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "169.254.1.1",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "nonsense",
    ]) {
      assert.ok(!isPublicAddress(address), address);
    }
  });
});

describe("formatting", () => {
  it("formats bytes and limits", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(2 * 1024 ** 3), "2 GB");
    assert.equal(progressBar(5, 10, 10), "█████░░░░░");
    assert.equal(limitHealth(90, 100), "warning");
    assert.equal(limitHealth(100, 100), "exhausted");
    assert.equal(limitHealth(100, null), "active");
  });
});

describe("backend configs", () => {
  it("renders a Squid config that requires authentication on every port", () => {
    const config = renderSquidConfig({
      ports: [8080, 8081],
      authHelper: "/usr/lib/squid/basic_ncsa_auth",
    });
    assert.match(config, /^# Managed by OpenFoxy/);
    assert.match(config, /http_port 8080\nhttp_port 8081/);
    assert.match(
      config,
      /http_access deny to_localhost\nhttp_access allow authenticated\nhttp_access deny all/,
    );
  });

  it("renders a Dante config restricted to OpenFoxy users", () => {
    const config = renderDanteConfig({ ports: [1080], users: ["alice", "bob"], external: "eth0" });
    assert.match(config, /internal: 0\.0\.0\.0 port = 1080/);
    assert.match(config, /external: eth0/);
    assert.match(config, /user: alice bob/);
    assert.match(config, /socks block \{\n {2}from: 0\.0\.0\.0\/0 to: 127\.0\.0\.0\/8/);
  });

  it("generates FakeTLS MTProto secrets and the mtg v2 command line", () => {
    const secret = generateSecret("www.example.com");
    assert.ok(isMtprotoSecret(secret));
    assert.ok(secret.endsWith(Buffer.from("www.example.com").toString("hex")));
    assert.ok(!isMtprotoSecret("dd" + "0".repeat(32)));
    assert.deepEqual(mtgArgv(443, secret).slice(1), ["simple-run", "0.0.0.0:443", secret]);
    assert.equal(
      telegramLink("1.2.3.4", 443, "ee00"),
      "tg://proxy?server=1.2.3.4&port=443&secret=ee00",
    );
  });
});
