/**
 * generation-log.js — cloud-sync log of every image generation attempt.
 *
 * Maintains an in-memory cache so callers stay synchronous; mutations debounce
 * a PUT to /api/log on the server (identity = SHA-256 of the OpenAI key).
 */

import { state } from "./state.js";

const MAX_ENTRIES = 100;
let cache = [];
let initPromise = null;
let saveTimer = null;

function getKey() {
  return localStorage.getItem("openai_api_key") || "";
}

function canSync() {
  return state.hasBackend !== false && !!getKey();
}

export async function initLog() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!canSync()) { cache = []; return; }
    try {
      const res = await fetch("/api/log", {
        headers: { "X-OpenAI-Key": getKey() }
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      cache = Array.isArray(data.entries) ? data.entries : [];
    } catch (err) {
      console.warn("[log] cloud load failed:", err);
      cache = [];
    }
  })();
  return initPromise;
}

export function resetLogCache() {
  cache = [];
  initPromise = null;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

async function saveNow() {
  if (!canSync()) return;
  try {
    await fetch("/api/log", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-OpenAI-Key": getKey()
      },
      body: JSON.stringify({ entries: cache.slice(0, MAX_ENTRIES) })
    });
  } catch (err) {
    console.warn("[log] cloud save failed:", err);
  }
}

export function readLog() {
  return cache.slice();
}

export function logStart(meta) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = { id, time: Date.now(), status: "pending", ...meta };
  cache.unshift(entry);
  if (cache.length > MAX_ENTRIES) cache.length = MAX_ENTRIES;
  scheduleSave();
  if (typeof console !== "undefined") {
    console.log("[layerboard] generation start", entry);
  }
  return id;
}

export function logEnd(id, patch) {
  const idx = cache.findIndex((e) => e.id === id);
  if (idx === -1) return;
  cache[idx] = { ...cache[idx], ...patch };
  scheduleSave();
  if (typeof console !== "undefined") {
    if (patch.status === "failed") console.error("[layerboard] generation failed", cache[idx]);
    else console.log("[layerboard] generation ok", cache[idx]);
  }
}

export async function clearLog() {
  cache = [];
  if (!canSync()) return;
  try {
    await fetch("/api/log", {
      method: "DELETE",
      headers: { "X-OpenAI-Key": getKey() }
    });
  } catch (err) {
    console.warn("[log] cloud clear failed:", err);
  }
}
