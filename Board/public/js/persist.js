/**
 * persist.js — IndexedDB autosave / restore for board state.
 */

import { state } from "./state.js";

const DB_NAME = "layerboard";
const DB_VERSION = 1;
const STORE = "board";
const KEY = "items";

let db = null;
let saveTimer = null;

// ---------- Open DB ----------
function openDb() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE);
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

// ---------- Serialise items (no DOM refs) ----------
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
    fontWeight: item.fontWeight ?? null
  }));
}

// ---------- Save ----------
async function saveNow() {
  try {
    const idb = await openDb();
    const data = serialise();
    await new Promise((resolve, reject) => {
      const tx = idb.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(data, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[persist] save failed:", err);
  }
}

export function scheduleAutoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

// ---------- Load ----------
export async function loadBoard() {
  try {
    const idb = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[persist] load failed:", err);
    return [];
  }
}
