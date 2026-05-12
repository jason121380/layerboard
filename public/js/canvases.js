/**
 * canvases.js — multi-canvas (multi-board) per user.
 *
 * Server stores `data/<user>/canvases.json` (index + active id) plus one
 * `canvas-<id>.json` per board. This module keeps a tiny in-memory cache and
 * exposes CRUD plus rendering of the left-middle list.
 */

import { state, showToast } from "./state.js";

let cache = { canvases: [], activeCanvasId: null };
let initPromise = null;

function getKey() { return localStorage.getItem("openai_api_key") || ""; }
function canSync() { return state.hasBackend !== false && !!getKey(); }

export function getCanvases() { return cache.canvases.slice(); }
export function getActiveCanvasId() { return cache.activeCanvasId; }
export function getActiveCanvas() {
  return cache.canvases.find((c) => c.id === cache.activeCanvasId) || null;
}

export function resetCanvasesCache() {
  cache = { canvases: [], activeCanvasId: null };
  initPromise = null;
}

export async function initCanvases() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!canSync()) { cache = { canvases: [], activeCanvasId: null }; return; }
    try {
      const res = await fetch("/api/canvases", { headers: { "X-OpenAI-Key": getKey() } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      cache = {
        canvases: Array.isArray(data.canvases) ? data.canvases : [],
        activeCanvasId: data.activeCanvasId || null
      };
    } catch (err) {
      console.warn("[canvases] load failed:", err);
      cache = { canvases: [], activeCanvasId: null };
    }
  })();
  return initPromise;
}

async function apiCreate(name) {
  const res = await fetch("/api/canvases", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenAI-Key": getKey() },
    body: JSON.stringify({ name: name || "" })
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function apiRename(id, name) {
  const res = await fetch(`/api/canvases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-OpenAI-Key": getKey() },
    body: JSON.stringify({ name })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `status ${res.status}`);
  }
  return res.json();
}

async function apiDelete(id) {
  const res = await fetch(`/api/canvases/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-OpenAI-Key": getKey() }
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `status ${res.status}`);
  }
  return res.json();
}

async function apiSetActive(id) {
  const res = await fetch("/api/canvases/active", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-OpenAI-Key": getKey() },
    body: JSON.stringify({ id })
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

// ---------- Public ops (wire callbacks from main.js) ----------
let switchHandler = null;
export function onCanvasSwitch(fn) { switchHandler = fn; }

async function switchTo(id) {
  if (!id || id === cache.activeCanvasId) return;
  cache.activeCanvasId = id;
  try { await apiSetActive(id); } catch (err) { console.warn("[canvases] active failed:", err); }
  if (switchHandler) await switchHandler(id);
  render();
}

export async function createCanvas() {
  if (!canSync()) { showToast("請先輸入 OpenAI Key。"); return; }
  const name = (prompt("畫布名稱？", `畫布 ${cache.canvases.length + 1}`) || "").trim();
  if (!name) return;
  // Flush current board before switching so user doesn't lose unsaved edits.
  if (switchHandler) await switchHandler(null, { flushOnly: true });
  try {
    const data = await apiCreate(name);
    cache.canvases.push(data.canvas);
    cache.activeCanvasId = data.activeCanvasId;
    if (switchHandler) await switchHandler(cache.activeCanvasId);
    render();
  } catch (err) {
    showToast(`新增失敗：${err.message}`);
  }
}

async function renameCanvas(id) {
  const current = cache.canvases.find((c) => c.id === id);
  if (!current) return;
  const name = (prompt("新名稱？", current.name) || "").trim();
  if (!name || name === current.name) return;
  try {
    const data = await apiRename(id, name);
    const i = cache.canvases.findIndex((c) => c.id === id);
    if (i !== -1) cache.canvases[i] = data.canvas;
    render();
  } catch (err) {
    showToast(`改名失敗：${err.message}`);
  }
}

async function deleteCanvas(id) {
  if (cache.canvases.length <= 1) {
    showToast("至少要保留一個畫布。");
    return;
  }
  const current = cache.canvases.find((c) => c.id === id);
  if (!current) return;
  if (!confirm(`刪除畫布「${current.name}」？此操作無法復原。`)) return;
  const wasActive = id === cache.activeCanvasId;
  try {
    const data = await apiDelete(id);
    cache.canvases = cache.canvases.filter((c) => c.id !== id);
    cache.activeCanvasId = data.activeCanvasId;
    if (wasActive && switchHandler) await switchHandler(cache.activeCanvasId);
    render();
  } catch (err) {
    showToast(`刪除失敗：${err.message}`);
  }
}

// ---------- Rendering ----------
function renderItem(canvas) {
  const li = document.createElement("div");
  li.className = "canvas-item" + (canvas.id === cache.activeCanvasId ? " active" : "");
  li.dataset.id = canvas.id;
  li.innerHTML = `
    <span class="canvas-item-name" title="${escapeHtml(canvas.name)}">${escapeHtml(canvas.name)}</span>
    <button class="canvas-item-menu" type="button" aria-label="畫布選項" title="重新命名 / 刪除">⋯</button>
  `;
  li.addEventListener("click", (e) => {
    if (e.target.closest(".canvas-item-menu")) return;
    switchTo(canvas.id);
  });
  li.addEventListener("dblclick", () => renameCanvas(canvas.id));
  li.querySelector(".canvas-item-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    openItemMenu(canvas.id, e.currentTarget);
  });
  return li;
}

function openItemMenu(id, anchor) {
  // Close any existing menu.
  document.querySelectorAll(".canvas-item-popup").forEach((m) => m.remove());
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "canvas-item-popup";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  menu.innerHTML = `
    <button type="button" data-act="rename">重新命名</button>
    <button type="button" data-act="delete">刪除</button>
  `;
  menu.addEventListener("click", (e) => {
    const act = e.target.dataset.act;
    menu.remove();
    if (act === "rename") renameCanvas(id);
    else if (act === "delete") deleteCanvas(id);
  });
  document.body.append(menu);
  setTimeout(() => {
    document.addEventListener("click", function close(ev) {
      if (menu.contains(ev.target)) return;
      menu.remove();
      document.removeEventListener("click", close);
    });
  }, 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function render() {
  const list = document.querySelector("#canvasListItems");
  const panel = document.querySelector(".canvas-list");
  if (!list || !panel) return;
  // Hide entire panel until canvases are loaded (no key, or pre-init).
  panel.hidden = cache.canvases.length === 0;
  list.innerHTML = "";
  for (const c of cache.canvases) list.append(renderItem(c));
}

export function initCanvasUi() {
  const addBtn = document.querySelector("#canvasAddBtn");
  addBtn?.addEventListener("click", createCanvas);
  render();
}
