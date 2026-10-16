import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Process helpers. Commands are always executed with an argument vector (never through a
 * shell), so user-supplied values cannot be interpreted as shell syntax.
 */

/** Runs a command, streaming its output; throws with the exit status on failure. */
export function run(command, args = [], { input } = {}) {
  const result = spawnSync(command, args, {
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    input,
  });
  if (result.error) throw new Error(`${command}: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

/** Runs a command quietly; returns whether it succeeded. */
export function tryRun(command, args = [], { input } = {}) {
  const result = spawnSync(command, args, {
    stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
    input,
  });
  return !result.error && result.status === 0;
}

/** Runs a command and returns its stdout, or null on failure. */
export function capture(command, args = []) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Locates an executable on PATH (plus sbin directories, which sudo may omit). */
export function which(name) {
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}
