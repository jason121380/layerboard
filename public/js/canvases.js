/**
 * canvases.js — multi-canvas (multi-board) per user.
 *
 * Server stores `data/<user>/canvases.json` (index + active id) plus one
 * `canvas-<id>.json` per board. This module keeps a tiny in-memory cache and
 * exposes CRUD plus rendering of the left-middle list.
 */

import { state, showToast, showLoadingProgress } from "./state.js";

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
//
// IMPORTANT: the switch flow must do { flush } BEFORE updating
// cache.activeCanvasId, then { load } AFTER. If you change activeCanvasId
// first, persist.js's saveNow() will read the new id and write the OUTGOING
// canvas's items into the INCOMING canvas's file — which is exactly the
// "the two canvases are connected" bug that was reported.
let switchHandler = null;
export function onCanvasSwitch(fn) { switchHandler = fn; }

async function switchTo(id) {
  if (!id || id === cache.activeCanvasId) return;
  // Immediate feedback — flushBoard can take seconds on a dirty board with
  // many base64 images, and without a toast the user just sees a frozen UI.
  const progress = showLoadingProgress("切換畫布中…");
  try {
    if (switchHandler) await switchHandler({ outgoingFlush: true });
    cache.activeCanvasId = id;
    try { await apiSetActive(id); } catch (err) { console.warn("[canvases] active failed:", err); }
    if (switchHandler) await switchHandler({ incomingId: id });
    render();
    const target = cache.canvases.find((c) => c.id === id);
    progress.end(`已切換到「${target?.name || "畫布"}」`);
  } catch (err) {
    progress.end(`切換失敗：${err.message}`);
  }
}

// ---------- Styled modals (replace native prompt/confirm) ----------
function promptName({ title, value = "", placeholder = "畫布名稱" }) {
  return new Promise((resolve) => {
    const modal = document.querySelector("#canvasNameModal");
    const titleEl = modal?.querySelector("#canvasNameTitle");
    const input = modal?.querySelector("#canvasNameInput");
    const save = modal?.querySelector("#canvasNameSave");
    const cancel = modal?.querySelector("#canvasNameCancel");
    if (!modal || !titleEl || !input || !save || !cancel) {
      resolve(null);
      return;
    }
    titleEl.textContent = title;
    input.value = value;
    input.placeholder = placeholder;
    modal.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 0);

    function cleanup() {
      modal.hidden = true;
      save.removeEventListener("click", onSave);
      cancel.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      input.removeEventListener("keydown", onKey);
    }
    function onSave() { const v = input.value.trim(); cleanup(); resolve(v); }
    function onCancel() { cleanup(); resolve(null); }
    function onBackdrop(e) { if (e.target === modal) onCancel(); }
    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); onSave(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }
    save.addEventListener("click", onSave);
    cancel.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    input.addEventListener("keydown", onKey);
  });
}

function confirmDelete(canvasName) {
  return new Promise((resolve) => {
    const modal = document.querySelector("#canvasDeleteModal");
    const msg = modal?.querySelector("#canvasDeleteMessage");
    const ok = modal?.querySelector("#canvasDeleteConfirm");
    const cancel = modal?.querySelector("#canvasDeleteCancel");
    if (!modal || !ok || !cancel) { resolve(false); return; }
    if (msg) msg.textContent = `確定要刪除畫布「${canvasName}」嗎？此操作無法復原。`;
    modal.hidden = false;
    setTimeout(() => ok.focus(), 0);

    function cleanup() {
      modal.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function onBackdrop(e) { if (e.target === modal) onCancel(); }
    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); onOk(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

export async function createCanvas() {
  if (!canSync()) { showToast("請先輸入 OpenAI Key。"); return; }
  const name = await promptName({
    title: "新增畫布",
    value: `畫布 ${cache.canvases.length + 1}`
  });
  if (name === null || !name) return;
  // Flush outgoing first (activeCanvasId still old) so unsaved edits aren't lost.
  if (switchHandler) await switchHandler({ outgoingFlush: true });
  try {
    const data = await apiCreate(name);
    cache.canvases.push(data.canvas);
    cache.activeCanvasId = data.activeCanvasId;
    if (switchHandler) await switchHandler({ incomingId: cache.activeCanvasId });
    render();
  } catch (err) {
    showToast(`新增失敗：${err.message}`);
  }
}

async function renameCanvas(id) {
  const current = cache.canvases.find((c) => c.id === id);
  if (!current) return;
  const name = await promptName({ title: "重新命名畫布", value: current.name });
  if (name === null || !name || name === current.name) return;
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
  if (!(await confirmDelete(current.name))) return;
  const wasActive = id === cache.activeCanvasId;
  try {
    const data = await apiDelete(id);
    cache.canvases = cache.canvases.filter((c) => c.id !== id);
    cache.activeCanvasId = data.activeCanvasId;
    // Skip outgoingFlush — the deleted canvas is gone on the server; flushing
    // would overwrite the new active canvas with the deleted board's items.
    if (wasActive && switchHandler) await switchHandler({ incomingId: cache.activeCanvasId });
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
