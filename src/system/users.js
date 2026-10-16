import fs from "node:fs";
import { UsageError } from "../validation.js";
import { run, tryRun, which } from "./exec.js";

/**
 * Dante authenticates SOCKS5 clients against local accounts. OpenFoxy creates login-less
 * accounts marked with a GECOS tag and refuses to touch any account without that tag, so a
 * proxy user named e.g. `root` can never change a real account's password.
 */
const GECOS_TAG = "openfoxy-proxy";

function passwdEntry(user) {
  let passwd;
  try {
    passwd = fs.readFileSync("/etc/passwd", "utf8");
  } catch {
    return null;
  }
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields[0] === user) return { user, gecos: fields[4] ?? "" };
  }
  return null;
}

export function isManagedUser(user) {
  return passwdEntry(user)?.gecos === GECOS_TAG;
}

function nologinShell() {
  return (
    ["/usr/sbin/nologin", "/sbin/nologin"].find((shell) => fs.existsSync(shell)) ?? "/bin/false"
  );
}

/** Throws if `user` exists but is not an OpenFoxy proxy account. */
export function assertUserAvailable(user) {
  const entry = passwdEntry(user);
  if (entry && entry.gecos !== GECOS_TAG) {
    throw new UsageError(
      `System account '${user}' already exists and is not managed by OpenFoxy. Choose another username.`,
    );
  }
}

/** Creates the account if needed and sets its password (via stdin, never argv). */
export function setProxyUser(user, pass) {
  assertUserAvailable(user);
  if (!passwdEntry(user)) {
    if (which("useradd")) {
      run("useradd", ["--no-create-home", "--shell", nologinShell(), "--comment", GECOS_TAG, user]);
    } else {
      // BusyBox (Alpine without shadow).
      run("adduser", ["-H", "-D", "-s", nologinShell(), "-g", GECOS_TAG, user]);
    }
  }
  run("chpasswd", [], { input: `${user}:${pass}\n` });
}

export function removeProxyUser(user) {
  if (!isManagedUser(user)) return;
  if (which("userdel")) tryRun("userdel", [user]);
  else tryRun("deluser", [user]);
}

/** Every account created by OpenFoxy (used by `uninstall`). */
export function managedUsers() {
  try {
    return fs
      .readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .map((line) => line.split(":"))
      .filter((fields) => fields[4] === GECOS_TAG)
      .map((fields) => fields[0]);
  } catch {
    return [];
  }
}
