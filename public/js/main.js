/**
 * main.js — entry point. Wires DOM events to feature modules.
 */

import { state, dom, showToast, setMixerHeight, toggleMixerHeight, getBoardScale, getBoardPoint, applyBoardTransform } from "./state.js";
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
  uploadImage,
  createItem
} from "./items.js";
import { magicLayerSelected, renderLayerPanel } from "./magic-layer.js";
import { generateImages, exportSelectedItems, saveApiKey } from "./api.js";
import { pushHistory, undo, redo } from "./history.js";
import { loadBoard, scheduleAutoSave } from "./persist.js";
import { renderUsage } from "./usage.js";
import { readLog, clearLog } from "./generation-log.js";
import { getNamespace } from "./namespace.js";

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

// ---------- Per-namespace data reload ----------
async function reloadNamespaceData() {
  // Wipe current board off the DOM.
  for (const item of state.items) item.el.remove();
  state.items = [];
  state.selectedIds.clear();
  state.primarySelectedId = null;
  // Pull board for the new namespace.
  const saved = await loadBoard();
  for (const data of saved) createItem({ ...data, select: false });
  // Refresh usage chip — log modal re-reads on open.
  renderUsage();
}

// ---------- API Key modal ----------
function initApiKeyModal() {
  const chip = document.querySelector(".status-chip");
  const modal = document.querySelector("#apiKeyModal");
  const openaiInput = document.querySelector("#apiKeyInput");
  const replicateInput = document.querySelector("#replicateKeyInput");
  const save = document.querySelector("#apiKeySave");
  const cancel = document.querySelector("#apiKeyCancel");
  if (!chip || !modal) return;

  function updateChipState() {
    const has = !!localStorage.getItem("openai_api_key");
    chip.classList.toggle("has-key", has);
  }

  chip.style.cursor = "pointer";
  chip.addEventListener("click", () => {
    if (openaiInput) openaiInput.value = localStorage.getItem("openai_api_key") || "";
    if (replicateInput) replicateInput.value = localStorage.getItem("replicate_api_token") || "";
    modal.hidden = false;
    openaiInput?.focus();
  });

  save.addEventListener("click", async () => {
    const before = getNamespace();
    saveApiKey(openaiInput?.value || "");
    const rkey = (replicateInput?.value || "").trim();
    if (rkey) localStorage.setItem("replicate_api_token", rkey);
    else localStorage.removeItem("replicate_api_token");
    modal.hidden = true;
    updateChipState();
    const after = getNamespace();
    if (after !== before) {
      await reloadNamespaceData();
      showToast(`切換到 ${after === "default" ? "未登入" : after} 的帳號`);
    } else {
      showToast(rkey ? "Keys 已儲存。" : "OpenAI Key 已儲存。");
    }
  });

  cancel.addEventListener("click", () => { modal.hidden = true; });

  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

  [openaiInput, replicateInput].forEach((input) => {
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save.click();
      if (e.key === "Escape") cancel.click();
    });
  });

  updateChipState();
}

// ---------- Generation log modal ----------
function initHistoryModal() {
  const btn = document.querySelector("#historyBtn");
  const modal = document.querySelector("#historyModal");
  const list = document.querySelector("#historyList");
  const closeBtn = document.querySelector("#historyClose");
  const clearBtn = document.querySelector("#historyClear");
  const copyBtn = document.querySelector("#historyCopy");
  const filters = modal?.querySelectorAll(".history-filter");
  if (!btn || !modal || !list) return;

  let activeFilter = "all";

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString("zh-TW", { hour12: false });
  }

  function fmtDuration(ms) {
    if (ms == null) return "—";
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} 秒`;
  }

  function statusGlyph(s) {
    if (s === "success") return "✓";
    if (s === "failed") return "✕";
    return "…";
  }

  function render() {
    const entries = readLog().filter((e) =>
      activeFilter === "all" ? true : e.status === activeFilter
    );
    if (!entries.length) {
      list.innerHTML = '<div class="history-empty">尚無紀錄。試試在下方輸入 prompt 並按生成。</div>';
      return;
    }
    list.innerHTML = entries.map((e) => {
      const tags = [
        `<span class="log-tag">${e.mode === "edit" ? "編輯" : "生成"}</span>`,
        `<span class="log-tag">${e.aspectRatio || "square"}</span>`,
        `<span class="log-tag">${e.model || "?"}</span>`,
        `<span class="log-tag">${e.backend || "?"}</span>`,
        e.referenceCount ? `<span class="log-tag">${e.referenceCount} 參考圖</span>` : "",
        e.imageCount ? `<span class="log-tag tag-success">${e.imageCount} 張</span>` : ""
      ].filter(Boolean).join("");
      const errorBlock = e.status === "failed" && e.error
        ? `<div class="log-error">${e.error.replace(/</g, "&lt;")}</div>`
        : "";
      return `
        <div class="log-entry">
          <span class="log-status log-status-${e.status || "pending"}">${statusGlyph(e.status)}</span>
          <div>
            <div class="log-row">
              <span class="log-time">${fmtTime(e.time)}</span>
              ${tags}
              <span class="log-tag">${fmtDuration(e.durationMs)}</span>
            </div>
            <div class="log-prompt">${(e.prompt || "").replace(/</g, "&lt;")}</div>
            ${errorBlock}
          </div>
        </div>
      `;
    }).join("");
  }

  btn.addEventListener("click", () => {
    render();
    modal.hidden = false;
  });
  closeBtn?.addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

  filters?.forEach((f) => {
    f.addEventListener("click", () => {
      activeFilter = f.dataset.filter;
      filters.forEach((b) => b.classList.toggle("active", b === f));
      render();
    });
  });

  clearBtn?.addEventListener("click", () => {
    if (!confirm("確定清空所有生成紀錄？")) return;
    clearLog();
    render();
  });

  copyBtn?.addEventListener("click", async () => {
    const json = JSON.stringify(readLog(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      showToast("紀錄已複製為 JSON。");
    } catch {
      showToast("複製失敗，請手動從 console 取得。");
      console.log(json);
    }
  });
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
      // Enter is easy to hit by accident, so always show the confirm modal
      // even when the user previously checked "this session don't ask again".
      generateImages({ forceConfirm: true });
    }
  });

  document.querySelector("#mixerSelectionClear")?.addEventListener("click", clearSelection);

  // Aspect ratio dropdown — toggle button + menu inside the input row.
  const aspectToggle = document.querySelector("#aspectMenuBtn");
  const aspectMenu = document.querySelector("#aspectMenu");
  const aspectLabel = document.querySelector("#aspectMenuLabel");

  function setAspectRatio(ratio) {
    state.aspectRatio = ratio;
    const labels = { square: "1:1", portrait: "9:16", landscape: "16:9" };
    if (aspectLabel) aspectLabel.textContent = labels[ratio] || "1:1";
    aspectMenu?.querySelectorAll(".aspect-menu-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.ratio === ratio);
    });
  }

  function closeAspectMenu() {
    if (!aspectMenu) return;
    aspectMenu.hidden = true;
    aspectToggle?.setAttribute("aria-expanded", "false");
  }

  aspectToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!aspectMenu) return;
    const isOpen = !aspectMenu.hidden;
    aspectMenu.hidden = isOpen;
    aspectToggle.setAttribute("aria-expanded", String(!isOpen));
  });

  aspectMenu?.addEventListener("click", (e) => {
    const item = e.target.closest("[data-ratio]");
    if (!item) return;
    setAspectRatio(item.dataset.ratio);
    closeAspectMenu();
  });

  document.addEventListener("click", (e) => {
    if (!aspectMenu || aspectMenu.hidden) return;
    if (e.target.closest("#aspectMenu") || e.target.closest("#aspectMenuBtn")) return;
    closeAspectMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAspectMenu();
  });

  // "查看提示詞" button on selection bar.
  document.querySelector("#promptBtn")?.addEventListener("click", () => {
    const primary = state.items.find((i) => i.id === state.primarySelectedId);
    if (!primary?.prompt) return;
    const modal = document.querySelector("#promptViewModal");
    const textEl = document.querySelector("#promptViewText");
    if (textEl) textEl.textContent = primary.prompt;
    if (modal) modal.hidden = false;
  });
  document.querySelector("#promptViewClose")?.addEventListener("click", () => {
    const modal = document.querySelector("#promptViewModal");
    if (modal) modal.hidden = true;
  });
  document.querySelector("#promptViewCopy")?.addEventListener("click", async () => {
    const text = document.querySelector("#promptViewText")?.textContent || "";
    try {
      await navigator.clipboard.writeText(text);
      showToast("提示詞已複製。");
    } catch {
      showToast("複製失敗，請手動選取。");
    }
  });
  document.querySelector("#promptViewModal")?.addEventListener("click", (e) => {
    if (e.target.id === "promptViewModal") e.currentTarget.hidden = true;
  });

  // Textarea auto-resize.
  function autoResizePrompt() {
    if (!dom.promptInput) return;
    dom.promptInput.style.height = "auto";
    dom.promptInput.style.height = Math.min(200, dom.promptInput.scrollHeight) + "px";
  }
  dom.promptInput?.addEventListener("input", autoResizePrompt);

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

  // Trackpad / wheel: ctrl = pinch zoom, otherwise 2-D pan.
  const boardFrame = document.querySelector(".board-frame");

  boardFrame?.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const newScale = Math.max(0.05, Math.min(2, state.boardScale * (1 - e.deltaY * 0.008)));
      state.boardScale = newScale;
    } else {
      // Natural-scroll semantics: swipe down → look further down → translate board up.
      state.boardPanX -= e.deltaX;
      state.boardPanY -= e.deltaY;
    }
    applyBoardTransform();
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
      generateImages({ forceConfirm: true });
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
  initHistoryModal();
  initGridToggle();
  setMixerHeight(state.mixerHeight);
  fitBoard(true);
  renderLayerPanel();
  await loadHealth(); // resolve hasBackend before user can hit the generate button
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
