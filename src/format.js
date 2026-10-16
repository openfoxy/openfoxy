const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), SIZE_UNITS.length - 1);
  return `${Number((value / 1024 ** exponent).toFixed(2))} ${SIZE_UNITS[exponent]}`;
}

export function progressBar(used, total, width = 20) {
  const filled = Math.round(Math.min(used / total, 1) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

const timestampFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatTimestamp(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown" : `${timestampFormat.format(date)} UTC`;
}

export const rule = (width = 58) => "═".repeat(width);

export const color = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
};

/** Usage of a limited proxy: `exhausted` at 100%, `warning` from 80%. */
export function limitHealth(used, limit) {
  if (!limit) return "active";
  if (used >= limit) return "exhausted";
  return used >= limit * 0.8 ? "warning" : "active";
}

export const HEALTH_ICON = { active: "🟢", warning: "🟡", exhausted: "🔴", stopped: "⚪" };

export const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
