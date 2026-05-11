/**
 * generation-log.js — persisted log of every image-generation attempt for debugging.
 */

import { namespaced } from "./namespace.js";

const MAX_ENTRIES = 100;
function logKey() { return namespaced("layerboard_generation_log"); }

export function readLog() {
  try {
    return JSON.parse(localStorage.getItem(logKey()) || "[]");
  } catch {
    return [];
  }
}

function writeLog(entries) {
  try {
    localStorage.setItem(logKey(), JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Likely quota exceeded — drop the oldest entries until it fits.
    try {
      localStorage.setItem(logKey(), JSON.stringify(entries.slice(0, Math.floor(MAX_ENTRIES / 2))));
    } catch {}
  }
}

/** Append a new entry to the log. Returns the entry id so callers can later
 *  update it (start → success / failed). */
export function logStart(meta) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    time: Date.now(),
    status: "pending",
    ...meta
  };
  const list = readLog();
  list.unshift(entry);
  writeLog(list);
  if (typeof console !== "undefined") {
    console.log("[layerboard] generation start", entry);
  }
  return id;
}

export function logEnd(id, patch) {
  const list = readLog();
  const idx = list.findIndex((e) => e.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...patch };
  writeLog(list);
  if (typeof console !== "undefined") {
    if (patch.status === "failed") console.error("[layerboard] generation failed", list[idx]);
    else console.log("[layerboard] generation ok", list[idx]);
  }
}

export function clearLog() {
  localStorage.removeItem(logKey());
}
