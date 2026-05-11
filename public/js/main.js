/**
 * main.js — entry point. Wires DOM events to feature modules.
 */

import { state, dom, showToast, setMixerHeight, toggleMixerHeight, getBoardScale, getBoardPoint } from "./state.js";
import {
  clearSelection,
  deleteSelected,
  duplicateSelected,
  groupSelected,
  ungroupSelected,
  mergeSelected,
  revertLayer,
  fitBoard,
  handleBoardPointerDown,
  repositionSelectionBar,
  uploadImage
} from "./items.js";
import { magicLayerSelected, renderLayerPanel } from "./magic-layer.js";
import { generateImages, exportSelectedItems, saveApiKey } from "./api.js";
import { pushHistory, undo, redo } from "./history.js";
import { loadBoard, scheduleAutoSave } from "./persist.js";
import { renderUsage } from "./usage.js";

// ---------- Mixer resize ----------
function handleMixerResizePointerDown(event) {
  if (!dom.mixerHandle) return;
  event.preventDefault();
  event.stopPropagation();

  const startY = event.clientY;
  const startHeight = state.mixerHeight;
  let moved = false;
  dom.mixerCard.classList.add("is-resizing");
  dom.mixerHandle.setPointerCapture(event.pointerId);

  function onMove(moveEvent) {
    const dy = moveEvent.clientY - startY;
    if (Math.abs(dy) > 3) moved = true;
    setMixerHeight(startHeight - dy);
  }

  function onUp() {
    dom.mixerCard.classList.remove("is-resizing");
    dom.mixerHandle.removeEventListener("pointermove", onMove);
    dom.mixerHandle.removeEventListener("pointerup", onUp);
    dom.mixerHandle.removeEventListener("pointercancel", onUp);
    if (!moved) toggleMixerHeight();
    state.suppressMixerClick = true;
    window.setTimeout(() => {
      state.suppressMixerClick = false;
    }, 120);
  }

  dom.mixerHandle.addEventListener("pointermove", onMove);
  dom.mixerHandle.addEventListener("pointerup", onUp);
  dom.mixerHandle.addEventListener("pointercancel", onUp);
}

function handleMixerHandleClick(event) {
  event.preventDefault();
  event.stopPropagation();
  if (state.suppressMixerClick) return;
  toggleMixerHeight();
}

// ---------- API Key modal ----------
function initApiKeyModal() {
  const chip = document.querySelector(".status-chip");
  const modal = document.querySelector("#apiKeyModal");
  const input = document.querySelector("#apiKeyInput");
  const save = document.querySelector("#apiKeySave");
  const cancel = document.querySelector("#apiKeyCancel");
  if (!chip || !modal) return;

  function updateChipState() {
    const has = !!localStorage.getItem("openai_api_key");
    chip.classList.toggle("has-key", has);
  }

  chip.style.cursor = "pointer";
  chip.addEventListener("click", () => {
    input.value = localStorage.getItem("openai_api_key") || "";
    modal.hidden = false;
    input.focus();
  });

  save.addEventListener("click", () => {
    saveApiKey(input.value);
    modal.hidden = true;
    updateChipState();
    showToast("API Key 已儲存。");
  });

  cancel.addEventListener("click", () => { modal.hidden = true; });

  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save.click();
    if (e.key === "Escape") cancel.click();
  });

  updateChipState();
}

// ---------- Grid toggle ----------
function initGridToggle() {
  const btn = document.querySelector("#gridToggleBtn");
  const gridEl = document.querySelector(".grid-lines");
  if (!btn || !gridEl) return;

  // 預設關閉格線
  gridEl.classList.add("hidden");
  btn.setAttribute("aria-pressed", "false");

  btn.addEventListener("click", () => {
    const isVisible = btn.getAttribute("aria-pressed") === "true";
    gridEl.classList.toggle("hidden", isVisible);
    btn.setAttribute("aria-pressed", String(!isVisible));
  });
}

// ---------- Wire events ----------
function bindEvents() {
  dom.generateBtn?.addEventListener("click", () => { pushHistory(); generateImages(); });
  dom.magicBtn?.addEventListener("click", () => { pushHistory(); magicLayerSelected(); });
  dom.revertBtn?.addEventListener("click", () => { pushHistory(); revertLayer(); });
  dom.duplicateBtn?.addEventListener("click", () => { pushHistory(); duplicateSelected(); });
  dom.groupBtn?.addEventListener("click", () => { pushHistory(); groupSelected(); });
  dom.ungroupBtn?.addEventListener("click", () => { pushHistory(); ungroupSelected(); });
  dom.mergeBtn?.addEventListener("click", () => { pushHistory(); mergeSelected(); });
  dom.exportBtn?.addEventListener("click", exportSelectedItems);
  dom.deleteBtn?.addEventListener("click", () => { pushHistory(); deleteSelected(); });

  dom.promptInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      generateImages();
    }
  });

  dom.uploadBtn?.addEventListener("click", () => dom.fileInput?.click());
  dom.fileInput?.addEventListener("change", () => {
    const files = Array.from(dom.fileInput.files || []);
    files.forEach((f) => uploadImage(f));
    dom.fileInput.value = "";
  });

  window.addEventListener("resize", () => {
    setMixerHeight(state.mixerHeight);
    repositionSelectionBar();
  });

  // Trackpad / pinch zoom
  const boardFrame = document.querySelector(".board-frame");

  boardFrame?.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const currentScale = getBoardScale();
    const newScale = Math.max(0.05, Math.min(2, currentScale * (1 - e.deltaY * 0.008)));
    dom.board.style.transform = `translate(-50%, -50%) scale(${newScale})`;
    repositionSelectionBar();
  }, { passive: false });

  // Drag & drop image files
  const dropOverlay = document.createElement("div");
  dropOverlay.className = "drop-overlay";
  dropOverlay.textContent = "拖曳圖片到這裡";
  document.body.append(dropOverlay);

  let dragCounter = 0;

  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragCounter++;
    dropOverlay.classList.add("visible");
  });

  document.addEventListener("dragleave", () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dropOverlay.classList.remove("visible");
  });

  // Must be on boardFrame (not document) to receive the drop
  boardFrame?.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });

  boardFrame?.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove("visible");

    const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (!files.length) return;

    const boardRect = dom.board.getBoundingClientRect();
    const scale = getBoardScale();
    const baseX = (e.clientX - boardRect.left) / scale;
    const baseY = (e.clientY - boardRect.top) / scale;
    files.forEach((f, i) => uploadImage(f, Math.round(baseX + i * 24), Math.round(baseY + i * 24)));
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === "y" || (event.key === "z" && event.shiftKey))) {
      event.preventDefault();
      redo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      generateImages();
      return;
    }
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      state.selectedIds.size &&
      document.activeElement?.tagName !== "TEXTAREA" &&
      document.activeElement?.tagName !== "INPUT"
    ) {
      event.preventDefault();
      deleteSelected();
      return;
    }
    if (event.key === "Escape") {
      clearSelection();
    }
  });

  // Marquee selection is attached to the frame, not the board itself,
  // so dragging from anywhere in the viewport (including outside the
  // 4200×2600 board area) starts a selection box.
  document.querySelector(".board-frame")?.addEventListener("pointerdown", handleBoardPointerDown);
}

// ---------- Boot ----------
async function loadHealth() {
  const chip = document.querySelector(".status-chip");
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error("no backend");
    const payload = await response.json();
    state.hasBackend = true;
    if (payload.model && dom.modelLabel) dom.modelLabel.textContent = payload.model;
    const localKey = !!localStorage.getItem("openai_api_key");
    if (!payload.hasKey && !localKey) {
      chip?.classList.add("is-warning");
      showToast("提醒：尚未設定 OpenAI API Key。點左下角可輸入。");
    } else {
      chip?.classList.remove("is-warning");
    }
  } catch {
    // Static deploy (GitHub Pages, Netlify static, etc.). Direct OpenAI call.
    state.hasBackend = false;
    if (dom.modelLabel) {
      const base = (dom.modelLabel.textContent || "gpt-image-2").replace(/\s·.+$/, "");
      dom.modelLabel.textContent = `${base} · Static`;
    }
    if (!localStorage.getItem("openai_api_key")) {
      chip?.classList.add("is-warning");
      showToast("靜態模式：點左下角輸入 OpenAI Key 即可直接生成。");
    }
  }
}

async function init() {
  bindEvents();
  initApiKeyModal();
  initGridToggle();
  setMixerHeight(state.mixerHeight);
  fitBoard(true);
  renderLayerPanel();
  loadHealth();
  renderUsage();

  // 還原上次 board
  const saved = await loadBoard();
  if (saved.length) {
    const { createItem } = await import("./items.js");
    for (const data of saved) createItem({ ...data, select: false });
    pushHistory();
  }
}

init();
