/**
 * persist.js — cloud-sync board state via PUT/GET /api/board.
 *
 * Identity is the SHA-256 of the user's OpenAI key on the server side. With no
 * key (or no backend), loads return empty and saves no-op.
 */

import { state } from "./state.js";

let saveTimer = null;
let saveInFlight = null;
let queuedSave = false;

function getKey() {
  return localStorage.getItem("openai_api_key") || "";
}

function canSync() {
  return state.hasBackend !== false && !!getKey();
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
  if (saveInFlight) {
    queuedSave = true;
    return;
  }
  const items = serialise();
  saveInFlight = (async () => {
    try {
      const res = await fetch("/api/board", {
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
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

export async function loadBoard() {
  if (!canSync()) return [];
  try {
    const res = await fetch("/api/board", {
      headers: { "X-OpenAI-Key": getKey() }
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch (err) {
    console.warn("[persist] cloud load failed:", err);
    return [];
  }
}
