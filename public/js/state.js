/**
 * state.js — single source of truth for app state and DOM references.
 */

import { clamp } from "./utils.js";

// ---------- DOM references ----------
export const dom = {
  board: document.querySelector("#board"),
  itemTemplate: document.querySelector("#itemTemplate"),

  // Mixer
  promptInput: document.querySelector("#promptInput"),
  generateBtn: document.querySelector("#generateBtn"),
  mixerCard: document.querySelector(".mixer-card"),
  uploadBtn: document.querySelector("#uploadBtn"),
  fileInput: document.querySelector("#fileInput"),

  // Selection bar
  selectionBar: document.querySelector("#selectionBar"),
  selectedCount: document.querySelector("#selectedCount"),
  magicBtn: document.querySelector("#magicBtn"),
  promptBtn: document.querySelector("#promptBtn"),
  duplicateBtn: document.querySelector("#duplicateBtn"),
  bringFrontBtn: document.querySelector("#bringFrontBtn"),
  sendBackBtn: document.querySelector("#sendBackBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  groupBtn: document.querySelector("#groupBtn"),
  ungroupBtn: document.querySelector("#ungroupBtn"),
  mergeBtn: document.querySelector("#mergeBtn"),
  deleteBtn: document.querySelector("#deleteBtn"),

  // Top bar
  modelLabel: document.querySelector("#modelLabel"),

  // Toast
  toast: document.querySelector("#toast")
};

// ---------- Mutable state ----------
export const state = {
  items: [],
  selectedIds: new Set(),
  primarySelectedId: null,
  zCounter: 10,
  layerMode: "auto",
  mixerHeight: 130,
  suppressMixerClick: false,
  toastTimer: null,
  // null = unknown (pre-probe), true = /api/* available, false = static deploy.
  hasBackend: null,
  // Board viewport: composed transform = translate(centre + pan) · scale.
  boardScale: 1,
  boardPanX: 0,
  boardPanY: 0,
  // Output aspect ratio for new generations: "square" | "portrait" | "landscape"
  aspectRatio: "square"
};

export function applyBoardTransform() {
  if (!dom.board) return;
  const { boardScale, boardPanX, boardPanY } = state;
  dom.board.style.transform =
    `translate(calc(-50% + ${boardPanX}px), calc(-50% + ${boardPanY}px)) scale(${boardScale})`;
}

export function bumpZ() {
  state.zCounter += 1;
  return state.zCounter;
}

// ---------- Mixer height ----------
export function setMixerHeight(height) {
  const maxHeight = Math.max(130, window.innerHeight - 76);
  state.mixerHeight = clamp(Math.round(height), 96, maxHeight);
  document.documentElement.style.setProperty("--mixer-height", `${state.mixerHeight}px`);
  dom.mixerCard?.classList.toggle("is-compact", state.mixerHeight < 90);
}

export function toggleMixerHeight() {
  setMixerHeight(state.mixerHeight < 100 ? 130 : 80);
}

// ---------- Toast ----------
export function showToast(message) {
  if (!dom.toast) return;
  dom.toast.textContent = message;
  dom.toast.classList.add("visible");
  dom.toast.classList.remove("is-progress");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => dom.toast.classList.remove("visible"), 2800);
}

/**
 * Persistent toast for long-running operations. Returns { update, end }.
 *   const p = showLoadingProgress("生成中…");
 *   p.update("生成中… 5 秒");
 *   p.end("完成");
 */
export function showLoadingProgress(initialMessage) {
  if (!dom.toast) return { update: () => {}, end: () => {} };
  dom.toast.textContent = initialMessage;
  dom.toast.classList.add("visible", "is-progress");
  window.clearTimeout(state.toastTimer);
  return {
    update(next) {
      dom.toast.textContent = next;
    },
    end(finalMessage) {
      dom.toast.classList.remove("is-progress");
      if (finalMessage != null) dom.toast.textContent = finalMessage;
      window.clearTimeout(state.toastTimer);
      state.toastTimer = window.setTimeout(() => dom.toast.classList.remove("visible"), 1800);
    }
  };
}

// ---------- Board scale & coords ----------
export function getBoardScale() {
  if (!dom.board) return 1;
  const rect = dom.board.getBoundingClientRect();
  return rect.width && dom.board.offsetWidth ? rect.width / dom.board.offsetWidth : 1;
}

export function getBoardPoint(event) {
  const rect = dom.board.getBoundingClientRect();
  const scale = getBoardScale();
  return {
    x: (event.clientX - rect.left) / scale,
    y: (event.clientY - rect.top) / scale
  };
}
