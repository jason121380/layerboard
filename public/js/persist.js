/**
 * persist.js — cloud-sync board state via PUT/GET /api/board.
 *
 * Identity is the SHA-256 of the user's OpenAI key on the server side; the
 * concrete canvas to read/write is determined by the active canvas id from
 * canvases.js. With no key, no backend, or no active canvas, loads return
 * empty and saves no-op.
 */

import { state } from "./state.js";
import { getActiveCanvasId } from "./canvases.js";

let saveTimer = null;
let saveInFlight = null;
let queuedSave = false;
// True when state.items has changed since the last successful PUT. Without this,
// every canvas switch pushes the (unchanged) board back to the server, which is
// expensive on big base64 payloads — making "switching" feel laggy.
let dirty = false;
// In-memory cache of items per canvas, so switching to a recently-loaded canvas
// is instant (no GET round-trip). Invalidated on save.
const boardCache = new Map();

function getKey() {
  return localStorage.getItem("openai_api_key") || "";
}

function canSync() {
  return state.hasBackend !== false && !!getKey() && !!getActiveCanvasId();
}

function serialise() {
  return state.items.map((item) => ({
    id: item.id,
    type: item.type,
    x: item.x, y: item.y,
    width: item.width, height: item.height,
    src: item.src,
    text: item.text,
    caption: item.caption,
    fit: item.fit,
    visible: item.visible,
    opacity: item.opacity,
    z: item.z,
    layerGroup: item.layerGroup || null,
    groupId: item.groupId || null,
    sourceId: item.sourceId || null,
    fontSize: item.fontSize ?? null,
    color: item.color ?? null,
    fontFamily: item.fontFamily ?? null,
    fontWeight: item.fontWeight ?? null,
    prompt: item.prompt ?? null,
    source: item.source ?? null
  }));
}

async function saveNow() {
  if (!canSync()) return;
  if (!dirty) return; // nothing changed since last save — skip the upload
  if (saveInFlight) {
    queuedSave = true;
    return;
  }
  const canvasId = getActiveCanvasId();
  const items = serialise();
  // Update cache so a switch-away/switch-back can skip the GET.
  boardCache.set(canvasId, items);
  dirty = false;
  saveInFlight = (async () => {
    try {
      const res = await fetch(`/api/board?canvasId=${encodeURIComponent(canvasId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-OpenAI-Key": getKey()
        },
        body: JSON.stringify({ items })
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      console.warn("[persist] cloud save failed:", err);
      // Roll dirty back so the next flush retries the upload.
      dirty = true;
    } finally {
      saveInFlight = null;
      if (queuedSave) {
        queuedSave = false;
        scheduleAutoSave();
      }
    }
  })();
  await saveInFlight;
}

export function scheduleAutoSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

/** Force any pending save to complete now. Used when switching canvases so the
 *  outgoing canvas isn't left mid-write. No-ops when nothing has changed. */
export async function flushBoard() {
  clearTimeout(saveTimer);
  if (saveInFlight) await saveInFlight;
  if (!dirty) return;
  await saveNow();
}

export async function loadBoard(canvasId = null) {
  if (state.hasBackend === false || !getKey()) return [];
  const id = canvasId || getActiveCanvasId();
  if (!id) return [];
  // Cache hit: instant return, avoids re-fetching the same (potentially huge)
  // payload when the user toggles between canvases.
  if (boardCache.has(id)) return boardCache.get(id);
  try {
    const res = await fetch(`/api/board?canvasId=${encodeURIComponent(id)}`, {
      headers: { "X-OpenAI-Key": getKey() }
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    boardCache.set(id, items);
    return items;
  } catch (err) {
    console.warn("[persist] cloud load failed:", err);
    return [];
  }
}

/** Drop the in-memory cache (call on identity change so a different user's
 *  data isn't surfaced from the previous tenant's session). */
export function resetPersistCache() {
  boardCache.clear();
  dirty = false;
}
