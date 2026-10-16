import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/openfoxy.js", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function cli(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
}

describe("cli", () => {
  it("prints help and version", () => {
    for (const flag of ["--help", "-h", "help"]) {
      const { code, out } = cli(flag);
      assert.equal(code, 0);
      assert.match(out, /OpenFoxy v/);
      assert.match(out, /openfoxy provider <gateway-host>:<port>:<token>/);
    }
    for (const flag of ["--version", "-v"]) assert.equal(cli(flag).out.trim(), version);
  });

  it("validates input before requiring root or touching the system", () => {
    const cases = [
      [["add", "user", "pass", "8000;touch /tmp/x"], /Invalid port/],
      [["add", "user;rm", "pass", "8000"], /Invalid username/],
      [["add", "user", "pass", "8000", "badproto"], /Invalid protocol/],
      [["add", "user", "pass", "8000", "http", "--country=US"], /only applies to residential/],
      [["add", "user", "pass", "8000", "residential", "--limit=lots"], /Invalid limit/],
      [["docker", "user", "pass", "8000", "badproto"], /Invalid protocol/],
      [["change", "user"], /Nothing to change/],
      [["delete", "user", "abc"], /Invalid port/],
      [["stop", "nope"], /Invalid port/],
      [["provider", "missing-token"], /Usage: openfoxy provider/],
    ];
    for (const [args, message] of cases) {
      const { code, out } = cli(...args);
      assert.notEqual(code, 0, args.join(" "));
      assert.match(out, message, args.join(" "));
    }
  });

  it("rejects unknown commands and options with exit code 2", () => {
    assert.equal(cli("frobnicate").code, 2);
    assert.equal(cli("list", "--bogus").code, 2);
    const { code, out } = cli("list", "--limit=1GB");
    assert.equal(code, 2);
    assert.match(out, /does not accept --limit/);
  });
});
