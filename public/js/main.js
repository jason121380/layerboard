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
  createItem,
  copySelectedToClipboard,
  pasteFromClipboard,
  bringSelectedToFront,
  sendSelectedToBack
} from "./items.js";
import { magicLayerSelected, renderLayerPanel } from "./magic-layer.js";
import { generateImages, exportSelectedItems, saveApiKey } from "./api.js";
import { pushHistory, undo, redo } from "./history.js";
import { loadBoard, scheduleAutoSave, flushBoard, resetPersistCache } from "./persist.js";
import { renderUsage, initUsage, resetUsageCache, getUsage, formatTwd } from "./usage.js";
import { readLog, clearLog, initLog, resetLogCache } from "./generation-log.js";
import {
  initCanvases, initCanvasUi, render as renderCanvases,
  onCanvasSwitch, resetCanvasesCache
} from "./canvases.js";

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

// ---------- Board zoom ----------
function setBoardZoom(scale) {
  state.boardScale = Math.max(0.05, Math.min(2, scale));
  applyBoardTransform();
  const label = document.querySelector("#zoomResetBtn");
  if (label) label.textContent = `${Math.round(state.boardScale * 100)}%`;
  repositionSelectionBar();
}

// ---------- Wipe DOM & in-memory board state ----------
function clearBoardDom() {
  for (const item of state.items) item.el.remove();
  state.items = [];
  state.selectedIds.clear();
  state.primarySelectedId = null;
}

// ---------- Reload cloud data after API key change ----------
async function reloadCloudData() {
  clearBoardDom();
  // Drop caches so they re-fetch under the new identity.
  resetLogCache();
  resetUsageCache();
  resetCanvasesCache();
  resetPersistCache();
  // Pull fresh data for the new key.
  await Promise.all([initUsage(), initLog(), initCanvases()]);
  const saved = await loadBoard();
  for (const data of saved) createItem({ ...data, select: false });
  renderUsage();
  renderCanvases();
}

// ---------- Canvas switch handler (passed to canvases.js) ----------
// Called in two phases: { outgoingFlush } before activeCanvasId changes,
// then { incomingId } after, so persist.js writes/reads against the correct
// canvas at each step.
async function handleCanvasSwitch({ outgoingFlush = false, incomingId = null } = {}) {
  if (outgoingFlush) {
    await flushBoard();
    return;
  }
  if (incomingId) {
    clearBoardDom();
    const saved = await loadBoard(incomingId);
    // Chunk DOM creation so a 30-image canvas doesn't lock the browser for a
    // full second. Yielding every 4 items keeps interaction responsive while
    // the rest of the board paints in.
    for (let i = 0; i < saved.length; i += 1) {
      createItem({ ...saved[i], select: false });
      if ((i + 1) % 4 === 0) {
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
  }
}

// ---------- Settings modal (top-right gear + status-chip click) ----------
function initSettingsModal() {
  const chip = document.querySelector(".status-chip");
  const gearBtn = document.querySelector("#settingsBtn");
  const modal = document.querySelector("#settingsModal");
  const closeBtn = document.querySelector("#settingsClose");
  const cancelBtn = document.querySelector("#settingsCancel");
  const saveBtn = document.querySelector("#settingsSave");
  const openaiInput = document.querySelector("#settingsOpenaiKey");
  const replicateInput = document.querySelector("#settingsReplicateKey");
  const replicateModelInput = document.querySelector("#settingsReplicateModel");
  const numLayersRange = document.querySelector("#settingsNumLayers");
  const numLayersValue = document.querySelector("#settingsNumLayersValue");
  const gridToggle = document.querySelector("#settingsGridToggle");

  function updateNumLayersUi(n) {
    if (numLayersRange) numLayersRange.value = String(n);
    if (numLayersValue) numLayersValue.textContent = String(n);
    if (numLayersRange) {
      const min = +numLayersRange.min, max = +numLayersRange.max;
      const fill = ((n - min) / (max - min)) * 100;
      numLayersRange.style.setProperty("--fill", fill + "%");
    }
  }
  numLayersRange?.addEventListener("input", () => updateNumLayersUi(+numLayersRange.value));
  const tabs = modal?.querySelectorAll(".settings-tab");
  const panels = modal?.querySelectorAll(".settings-panel");
  if (!modal) return;

  // Grid line element — default to hidden, mirror state into the checkbox.
  const gridEl = document.querySelector(".grid-lines");
  gridEl?.classList.add("hidden");

  function updateChipState() {
    chip?.classList.toggle("has-key", !!localStorage.getItem("openai_api_key"));
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleString("zh-TW", { hour12: false });
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
  function escape(s) { return String(s).replace(/</g, "&lt;"); }

  function renderLogList(container, entries, emptyMsg) {
    if (!entries.length) {
      container.innerHTML = `<div class="settings-log-empty">${emptyMsg}</div>`;
      return;
    }
    container.innerHTML = entries.map((e) => {
      const isMagic = e.mode === "magic-layer";
      const isQwen = e.mode === "qwen-layered";
      const modeLabel = isMagic ? "魔法圖層"
        : isQwen ? "分層生成"
        : e.mode === "edit" ? "編輯"
        : "生成";
      // Trim the trailing :version-hash for display — it bloats the row and
      // the hash isn't actionable info for the user.
      const modelLabel = (e.model || "?").split(":").slice(0, 2).join(":");
      const tags = [
        `<span class="log-tag">${modeLabel}</span>`,
        isMagic
          ? `<span class="log-tag">${e.layerMode || "auto"}</span>`
          : `<span class="log-tag">${e.aspectRatio || "square"}</span>`,
        `<span class="log-tag log-tag-model" title="${escape(e.model || "")}">${escape(modelLabel)}</span>`,
        e.referenceCount ? `<span class="log-tag">${e.referenceCount} 參考圖</span>` : "",
        isMagic && e.imageCount ? `<span class="log-tag">${e.imageCount} 輸入</span>` : "",
        !isMagic && e.imageCount ? `<span class="log-tag tag-success">${e.imageCount} 張</span>` : "",
        isMagic && e.textCount ? `<span class="log-tag tag-success">${e.textCount} 段文字</span>` : "",
        isMagic && e.layerCount ? `<span class="log-tag tag-success">${e.layerCount} 圖層</span>` : "",
        `<span class="log-tag">${fmtDuration(e.durationMs)}</span>`
      ].filter(Boolean).join("");
      const errorBlock = e.status === "failed" && e.error
        ? `<div class="log-error">${escape(e.error)}</div>`
        : "";
      return `
        <div class="log-entry">
          <span class="log-status log-status-${e.status || "pending"}">${statusGlyph(e.status)}</span>
          <div>
            <div class="log-row">
              <span class="log-time">${fmtTime(e.time)}</span>
              ${tags}
            </div>
            ${e.prompt ? `<div class="log-prompt">${escape(e.prompt)}</div>` : ""}
            ${errorBlock}
          </div>
        </div>
      `;
    }).join("");
  }

  function renderAll() {
    const u = getUsage();
    document.querySelector("#gptStatCount").textContent = `${u.count || 0} 張`;
    document.querySelector("#gptStatCost").textContent = formatTwd(u.usd || 0);
    document.querySelector("#magicStatCount").textContent = `${u.magicCount || 0} 次`;
    document.querySelector("#magicStatCost").textContent = formatTwd(u.magicUsd || 0);
    const all = readLog();
    // Magic Layer tab also owns Qwen rows — both share the Replicate token.
    const isReplicate = (e) => e.mode === "magic-layer" || e.mode === "qwen-layered";
    renderLogList(
      document.querySelector("#settingsGptLog"),
      all.filter((e) => !isReplicate(e)),
      "尚無生成紀錄。"
    );
    renderLogList(
      document.querySelector("#settingsMagicLog"),
      all.filter(isReplicate),
      "尚無 Magic Layer / Qwen 紀錄。"
    );
  }

  function openModal() {
    if (openaiInput) openaiInput.value = localStorage.getItem("openai_api_key") || "";
    if (replicateInput) replicateInput.value = localStorage.getItem("replicate_api_token") || "";
    if (replicateModelInput) replicateModelInput.value = localStorage.getItem("replicate_model") || "";
    updateNumLayersUi(Number(localStorage.getItem("qwen_num_layers")) || 4);
    if (gridToggle && gridEl) gridToggle.checked = !gridEl.classList.contains("hidden");
    renderAll();
    modal.hidden = false;
    openaiInput?.focus();
  }
  function closeModal() { modal.hidden = true; }

  if (chip) {
    chip.style.cursor = "pointer";
    chip.addEventListener("click", openModal);
  }
  gearBtn?.addEventListener("click", openModal);
  closeBtn?.addEventListener("click", closeModal);
  cancelBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  // Tab switching
  tabs?.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      panels?.forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    });
  });

  // Grid toggle
  gridToggle?.addEventListener("change", () => {
    gridEl?.classList.toggle("hidden", !gridToggle.checked);
  });

  // Save: writes API key, Replicate token + model. Triggers cloud reload
  // when the OpenAI key actually changed.
  saveBtn?.addEventListener("click", async () => {
    const before = (localStorage.getItem("openai_api_key") || "").trim();
    saveApiKey(openaiInput?.value || "");
    const rkey = (replicateInput?.value || "").trim();
    if (rkey) localStorage.setItem("replicate_api_token", rkey);
    else localStorage.removeItem("replicate_api_token");
    const rmodel = (replicateModelInput?.value || "").trim();
    if (rmodel) localStorage.setItem("replicate_model", rmodel);
    else localStorage.removeItem("replicate_model");
    if (numLayersRange) localStorage.setItem("qwen_num_layers", String(+numLayersRange.value || 4));
    closeModal();
    updateChipState();
    const after = (localStorage.getItem("openai_api_key") || "").trim();
    if (after !== before) {
      await reloadCloudData();
      showToast(after ? "已切換帳號，雲端資料載入完成。" : "已登出 — 畫布清空。");
    } else {
      showToast("設定已儲存。");
    }
  });

  // Per-section "clear log" buttons (delete-everything for now; filter is
  // by mode but the backing store is a single list).
  modal.querySelectorAll(".settings-log-clear").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("確定清空所有生成紀錄？（兩個頁籤共用同一份紀錄）")) return;
      await clearLog();
      renderAll();
    });
  });

  [openaiInput, replicateInput, replicateModelInput].forEach((input) => {
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveBtn?.click();
      if (e.key === "Escape") closeModal();
    });
  });

  updateChipState();
}

// ---------- Wire events ----------
function bindEvents() {
  dom.generateBtn?.addEventListener("click", () => { pushHistory(); generateImages(); });
  dom.magicBtn?.addEventListener("click", () => { pushHistory(); magicLayerSelected(); });
  dom.revertBtn?.addEventListener("click", () => { pushHistory(); revertLayer(); });
  dom.duplicateBtn?.addEventListener("click", () => { pushHistory(); duplicateSelected(); });
  dom.bringFrontBtn?.addEventListener("click", () => { pushHistory(); bringSelectedToFront(); });
  dom.sendBackBtn?.addEventListener("click", () => { pushHistory(); sendSelectedToBack(); });
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
      setBoardZoom(state.boardScale * (1 - e.deltaY * 0.008));
    } else {
      // Natural-scroll semantics: swipe down → look further down → translate board up.
      state.boardPanX -= e.deltaX;
      state.boardPanY -= e.deltaY;
      applyBoardTransform();
      repositionSelectionBar();
    }
  }, { passive: false });

  // Zoom controls (bottom-left)
  document.querySelector("#zoomInBtn")?.addEventListener("click", () => setBoardZoom(state.boardScale * 1.2));
  document.querySelector("#zoomOutBtn")?.addEventListener("click", () => setBoardZoom(state.boardScale / 1.2));
  document.querySelector("#zoomResetBtn")?.addEventListener("click", () => setBoardZoom(1));

  // Undo / Redo (top-bar icons, parallels the ⌘Z / ⌘⇧Z shortcuts below)
  document.querySelector("#undoBtn")?.addEventListener("click", undo);
  document.querySelector("#redoBtn")?.addEventListener("click", redo);

  // Mobile / PWA: two-finger pinch zoom on the board frame.
  // The page-level viewport is locked (user-scalable=no), so the browser won't
  // intercept the gesture; we handle it ourselves and feed it through
  // setBoardZoom so the % label stays in sync.
  const touchPointers = new Map();
  let lastPinchDist = null;
  boardFrame?.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPointers.size === 2) {
      const [a, b] = [...touchPointers.values()];
      lastPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  boardFrame?.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch" || !touchPointers.has(e.pointerId)) return;
    touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPointers.size === 2 && lastPinchDist) {
      const [a, b] = [...touchPointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0) setBoardZoom(state.boardScale * (dist / lastPinchDist));
      lastPinchDist = dist;
    }
  });
  const endTouch = (e) => {
    if (e.pointerType !== "touch") return;
    touchPointers.delete(e.pointerId);
    if (touchPointers.size < 2) lastPinchDist = null;
  };
  boardFrame?.addEventListener("pointerup", endTouch);
  boardFrame?.addEventListener("pointercancel", endTouch);

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
    // Copy / paste — works across canvases via localStorage. Ignored while
    // an input/textarea has focus so we don't break the native text clipboard.
    const inField = document.activeElement?.tagName === "TEXTAREA"
      || document.activeElement?.tagName === "INPUT"
      || document.activeElement?.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key === "c" && !inField && state.selectedIds.size) {
      event.preventDefault();
      copySelectedToClipboard();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "v" && !inField) {
      event.preventDefault();
      pushHistory();
      pasteFromClipboard();
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
    if (!localKey) {
      chip?.classList.add("is-warning");
      showToast("提醒：尚未設定 OpenAI API Key。點左下角可輸入；雲端同步會以此為帳號識別。");
    } else {
      chip?.classList.remove("is-warning");
    }
  } catch {
    // Static deploy (no backend → no cloud sync). Image generation can still
    // talk to OpenAI directly, but data won't persist across sessions.
    state.hasBackend = false;
    if (dom.modelLabel) {
      const base = (dom.modelLabel.textContent || "gpt-image-2").replace(/\s·.+$/, "");
      dom.modelLabel.textContent = `${base} · Static`;
    }
    if (!localStorage.getItem("openai_api_key")) {
      chip?.classList.add("is-warning");
      showToast("靜態模式：點左下角輸入 OpenAI Key 即可直接生成。注意此模式下資料不會跨裝置同步。");
    } else {
      showToast("靜態模式：本次工作階段的資料不會被儲存。");
    }
  }
}

async function init() {
  bindEvents();
  initSettingsModal();
  setMixerHeight(state.mixerHeight);
  fitBoard(true);
  setBoardZoom(0.2); // default initial zoom (overrides fitBoard's auto-fit)
  renderLayerPanel();
  onCanvasSwitch(handleCanvasSwitch);
  initCanvasUi();
  await loadHealth(); // resolve hasBackend before any cloud sync calls
  await Promise.all([initUsage(), initLog(), initCanvases()]);
  renderUsage();
  renderCanvases();

  const saved = await loadBoard();
  if (saved.length) {
    const { createItem } = await import("./items.js");
    for (const data of saved) createItem({ ...data, select: false });
    pushHistory();
  }
}

init();
