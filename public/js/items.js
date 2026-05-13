/**
 * items.js — item lifecycle, drag/resize, selection, and board interactions.
 */

import { state, dom, bumpZ, showToast, getBoardScale, getBoardPoint, applyBoardTransform } from "./state.js";
import { uid, rectFromPoints, intersectsRect, getItemsBounds } from "./utils.js";
import { renderLayerPanel } from "./magic-layer.js";
import { scheduleAutoSave } from "./persist.js";

// ---------- Selection helpers ----------
export function getSelectedItems() {
  return state.items.filter((item) => state.selectedIds.has(item.id));
}

export function getSelectedItem() {
  return (
    state.items.find((item) => item.id === state.primarySelectedId) ||
    getSelectedItems()[0] ||
    null
  );
}

function syncSelectionClasses() {
  for (const item of state.items) {
    item.el.classList.toggle("selected", state.selectedIds.has(item.id));
  }
}

export function repositionSelectionBar() {
  if (!dom.selectionBar) return;
  const selectedItems = getSelectedItems();
  if (!selectedItems.length) return;

  const scale = getBoardScale();
  const boardRect = dom.board.getBoundingClientRect();
  const minX = Math.min(...selectedItems.map((i) => i.x));
  const minY = Math.min(...selectedItems.map((i) => i.y));
  const maxX = Math.max(...selectedItems.map((i) => i.x + i.width));

  const centerX = boardRect.left + (minX + (maxX - minX) / 2) * scale;
  const itemTopY = boardRect.top + minY * scale;
  const barH = dom.selectionBar.offsetHeight || 48;
  const barW = dom.selectionBar.offsetWidth || 320;

  const top = Math.max(60, itemTopY - barH - 12);
  const left = Math.max(barW / 2 + 8, Math.min(window.innerWidth - barW / 2 - 8, centerX));

  dom.selectionBar.style.top = `${Math.round(top)}px`;
  dom.selectionBar.style.left = `${Math.round(left)}px`;
}

export function updateControls() {
  const selectedItems = getSelectedItems();
  const editableImages = selectedItems.filter((item) => ["image", "layer"].includes(item.type));
  const hasSelection = selectedItems.length > 0;
  const isMulti = selectedItems.length > 1;

  if (dom.selectedCount) dom.selectedCount.textContent = String(selectedItems.length);
  dom.selectionBar?.classList.toggle("visible", hasSelection);

  const selectedHasGroup = getSelectedItems().some((i) => i.groupId);

  const primaryItem = getSelectedItem();
  const isLayerItem = primaryItem?.type === "layer" && primaryItem?.sourceId;

  // Single-select buttons
  if (dom.magicBtn) {
    dom.magicBtn.hidden = isMulti || isLayerItem;
    dom.magicBtn.disabled = editableImages.length === 0;
    if (!dom.magicBtn.classList.contains("is-busy")) dom.magicBtn.textContent = "魔法圖層";
  }
  if (dom.revertBtn) {
    dom.revertBtn.hidden = isMulti || !isLayerItem;
    dom.revertBtn.disabled = !isLayerItem;
  }
  if (dom.promptBtn) {
    const showPrompt = !isMulti && !!primaryItem?.prompt;
    dom.promptBtn.hidden = !showPrompt;
    dom.promptBtn.disabled = !showPrompt;
  }
  if (dom.duplicateBtn) {
    dom.duplicateBtn.hidden = isMulti;
    dom.duplicateBtn.disabled = !hasSelection;
    dom.duplicateBtn.textContent = "複製";
  }
  if (dom.exportBtn) {
    // Visible in both single + multi-select — exportSelectedItems already
    // composites a multi-item bounding box, no reason to hide it on multi.
    dom.exportBtn.hidden = false;
    dom.exportBtn.disabled = !hasSelection;
    dom.exportBtn.textContent = isMulti ? `匯出 (${state.selectedIds.size})` : "匯出";
  }
  // Z-order buttons — active whenever anything is selected (works for both
  // single and multi-select cases).
  if (dom.bringFrontBtn) dom.bringFrontBtn.disabled = !hasSelection;
  if (dom.sendBackBtn) dom.sendBackBtn.disabled = !hasSelection;

  // Multi-select buttons
  if (dom.groupBtn) {
    dom.groupBtn.hidden = !isMulti;
    dom.groupBtn.disabled = !isMulti;
  }
  if (dom.ungroupBtn) {
    dom.ungroupBtn.hidden = !isMulti;
    dom.ungroupBtn.disabled = !selectedHasGroup;
  }
  if (dom.mergeBtn) {
    dom.mergeBtn.hidden = !isMulti;
    dom.mergeBtn.disabled = editableImages.length < 2;
  }

  if (dom.deleteBtn) {
    dom.deleteBtn.disabled = !hasSelection;
    dom.deleteBtn.textContent = isMulti ? `刪除 (${selectedItems.length})` : "刪除";
  }

  // Mixer-card selection chip: shows the user that the bottom prompt will be
  // applied to these images as reference (image-edit mode).
  const chip = document.querySelector("#mixerSelectionChip");
  const label = document.querySelector("#mixerSelectionLabel");
  const thumbs = document.querySelector("#mixerSelectionThumbs");
  if (chip) {
    const refItems = selectedItems.filter((it) => ["image", "layer"].includes(it.type) && it.src);
    if (refItems.length) {
      chip.hidden = false;
      if (label) label.textContent = `已選 ${refItems.length} 張，下方 prompt 會以這些圖為參考`;
      if (thumbs) {
        thumbs.innerHTML = refItems
          .slice(0, 4)
          .map((it) => `<img src="${it.src}" alt="">`)
          .join("");
      }
    } else {
      chip.hidden = true;
    }
  }

  if (hasSelection) repositionSelectionBar();
}

export function selectItems(ids) {
  state.selectedIds = new Set(ids.filter((id) => state.items.some((item) => item.id === id)));
  state.primarySelectedId = [...state.selectedIds].at(-1) || null;
  syncSelectionClasses();
  updateControls();
  renderLayerPanel();
}

export function selectItem(id, options = {}) {
  if (options.toggle) {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
      state.primarySelectedId = [...state.selectedIds].at(-1) || null;
    } else {
      state.selectedIds.add(id);
      state.primarySelectedId = id;
    }
  } else if (options.additive) {
    state.selectedIds.add(id);
    state.primarySelectedId = id;
  } else {
    state.selectedIds = new Set([id]);
    state.primarySelectedId = id;
  }
  syncSelectionClasses();
  updateControls();
  renderLayerPanel();
}

export function clearSelection() {
  state.selectedIds.clear();
  state.primarySelectedId = null;
  syncSelectionClasses();
  updateControls();
  renderLayerPanel();
}

// ---------- Item DOM render ----------
export function syncItemElement(item) {
  item.el.style.left = `${item.x}px`;
  item.el.style.top = `${item.y}px`;
  item.el.style.width = `${item.width}px`;
  item.el.style.height = `${item.height}px`;
  item.el.style.zIndex = String(item.z);
  item.el.style.opacity = item.opacity ?? 1;
  item.el.style.display = item.visible === false ? "none" : "block";
  item.el.classList.toggle("layer-item", item.type === "layer");
  item.el.classList.toggle("text-item", item.type === "text");
  item.el.classList.toggle("is-generated", item.source === "generated");
  item.el.classList.toggle("is-edited", item.source === "edit");
}

const DEFAULT_TEXT_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif';

function renderTextItem(item, media) {
  const editor = document.createElement("div");
  editor.dataset.role = "text-editor";
  editor.contentEditable = "false";
  editor.spellcheck = false;
  editor.textContent = item.text || "";
  Object.assign(editor.style, {
    fontSize: `${item.fontSize || 24}px`,
    fontFamily: item.fontFamily || DEFAULT_TEXT_FONT,
    fontWeight: String(item.fontWeight || 600),
    color: item.color || "#26252a"
  });

  editor.addEventListener("input", () => {
    item.text = editor.textContent;
  });

  // Double-click → enter edit mode (single-click stays for select+drag).
  item.el.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    editor.contentEditable = "true";
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  editor.addEventListener("blur", () => {
    editor.contentEditable = "false";
    item.text = editor.textContent;
  });

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Escape") editor.blur();
  });

  media.append(editor);
}

function renderItemContent(item) {
  const media = item.el.querySelector(".item-media");
  const caption = item.el.querySelector(".item-caption");
  media.innerHTML = "";
  caption.textContent = item.caption || "";

  if (item.type === "text") {
    renderTextItem(item, media);
    return;
  }

  if (item.type === "note") {
    const textarea = document.createElement("textarea");
    textarea.value = item.text || "";
    textarea.addEventListener("input", () => {
      item.text = textarea.value;
    });
    media.append(textarea);
    return;
  }

  const img = document.createElement("img");
  img.alt = item.caption || "Moodboard image";
  // Decode off the main thread so large base64 PNGs don't freeze the UI
  // (especially noticeable when a canvas with many images is loaded on
  // switch).
  img.decoding = "async";
  img.loading = "lazy";
  img.src = item.src;
  img.draggable = false;
  img.style.objectFit = item.fit || "cover";
  media.append(img);
}

// ---------- Item creation ----------
export function createItem(data) {
  const node = dom.itemTemplate.content.firstElementChild.cloneNode(true);
  const item = {
    id: data.id || uid(data.type || "item"),
    type: data.type || "image",
    x: data.x ?? 120,
    y: data.y ?? 120,
    width: data.width ?? 280,
    height: data.height ?? 220,
    src: data.src || "",
    text: data.text || "",
    caption: data.caption || "",
    fit: data.fit || "cover",
    visible: data.visible !== false,
    opacity: data.opacity ?? 1,
    z: data.z ?? bumpZ(),
    el: node,
    layerGroup: data.layerGroup || null,
    groupId: data.groupId || null,
    sourceId: data.sourceId || null,
    fontSize: data.fontSize ?? null,
    color: data.color ?? null,
    fontFamily: data.fontFamily ?? null,
    fontWeight: data.fontWeight ?? null,
    prompt: data.prompt ?? null,
    source: data.source ?? null // "generated" | "edit" | "upload" | null
  };

  node.dataset.id = item.id;
  node.addEventListener("pointerdown", (event) => handleItemPointerDown(event, item));
  node.addEventListener("focus", () => {
    if (!state.selectedIds.has(item.id)) selectItem(item.id);
  });
  node.querySelector(".resize-handle").addEventListener("pointerdown", (event) =>
    handleResizePointerDown(event, item)
  );

  dom.board.append(node);
  state.items.push(item);
  renderItemContent(item);
  syncItemElement(item);
  if (data.select !== false) selectItem(item.id);
  return item;
}

// ---------- Drag & resize ----------
function handleItemPointerDown(event, item) {
  if (event.target.closest(".resize-handle")) return;
  if (event.target.tagName === "TEXTAREA") return;
  // Allow caret placement when a text item is in edit mode.
  if (event.target.isContentEditable) return;
  event.preventDefault();

  const shouldToggle = event.shiftKey || event.metaKey || event.ctrlKey;
  if (shouldToggle) {
    selectItem(item.id, { toggle: true });
  } else if (!state.selectedIds.has(item.id)) {
    if (item.groupId && !shouldToggle) {
      const groupIds = state.items.filter((i) => i.groupId === item.groupId).map((i) => i.id);
      selectItems(groupIds);
    } else {
      selectItem(item.id);
    }
  } else {
    state.primarySelectedId = item.id;
    updateControls();
    renderLayerPanel();
  }

  if (!state.selectedIds.has(item.id)) return;

  item.el.focus({ preventScroll: true });

  const movingItems = getSelectedItems();
  for (const movingItem of movingItems) {
    movingItem.z = bumpZ();
    syncItemElement(movingItem);
  }

  const startX = event.clientX;
  const startY = event.clientY;
  const initialPositions = new Map(
    movingItems.map((m) => [m.id, { x: m.x, y: m.y }])
  );
  const boardScale = getBoardScale();
  item.el.setPointerCapture(event.pointerId);

  function onMove(moveEvent) {
    const dx = (moveEvent.clientX - startX) / boardScale;
    const dy = (moveEvent.clientY - startY) / boardScale;
    for (const movingItem of movingItems) {
      const initial = initialPositions.get(movingItem.id);
      movingItem.x = Math.round(initial.x + dx);
      movingItem.y = Math.round(initial.y + dy);
      syncItemElement(movingItem);
    }
    repositionSelectionBar();
  }

  function onUp() {
    item.el.removeEventListener("pointermove", onMove);
    item.el.removeEventListener("pointerup", onUp);
    item.el.removeEventListener("pointercancel", onUp);
    scheduleAutoSave();
  }

  item.el.addEventListener("pointermove", onMove);
  item.el.addEventListener("pointerup", onUp);
  item.el.addEventListener("pointercancel", onUp);
}

function handleResizePointerDown(event, item) {
  event.stopPropagation();
  event.preventDefault();
  if (!state.selectedIds.has(item.id)) selectItem(item.id);

  const startX = event.clientX;
  const startY = event.clientY;
  const resizeItems = state.selectedIds.has(item.id) ? getSelectedItems() : [item];
  const initialRects = new Map(
    resizeItems.map((r) => [r.id, { x: r.x, y: r.y, width: r.width, height: r.height }])
  );
  const bounds = getItemsBounds(resizeItems);
  const boardScale = getBoardScale();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);

  function onMove(moveEvent) {
    const dx = (moveEvent.clientX - startX) / boardScale;
    const dy = (moveEvent.clientY - startY) / boardScale;
    if (resizeItems.length === 1) {
      const initial = initialRects.get(item.id);
      const aspectRatio = initial.width / initial.height;
      const newWidth = Math.max(96, Math.round(initial.width + dx));
      item.width = newWidth;
      item.height = Math.max(88, Math.round(newWidth / aspectRatio));
      syncItemElement(item);
      repositionSelectionBar();
      return;
    }

    const scale = Math.max(0.2, (bounds.width + dx) / bounds.width);
    for (const r of resizeItems) {
      const initial = initialRects.get(r.id);
      const ar = initial.width / initial.height;
      const newW = Math.max(34, Math.round(initial.width * scale));
      r.x = Math.round(bounds.x + (initial.x - bounds.x) * scale);
      r.y = Math.round(bounds.y + (initial.y - bounds.y) * scale);
      r.width = newW;
      r.height = Math.max(34, Math.round(newW / ar));
      syncItemElement(r);
    }
    repositionSelectionBar();
  }

  function onUp() {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    scheduleAutoSave();
  }

  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

// ---------- Marquee selection ----------
export function handleBoardPointerDown(event) {
  // Marquee works from anywhere except inside items or UI controls.
  if (event.target.closest(".board-item")) return;
  if (event.target.closest(".selection-bar, .mixer-card, .canvas-topbar, .api-modal")) return;
  if (event.target.matches("button, input, textarea, select")) return;

  // Touch (mobile / PWA) — single finger pans the viewport instead of starting
  // a marquee. The two-finger pinch handler in main.js still owns zoom.
  // Mouse / pen continue to marquee-select as before.
  if (event.pointerType === "touch") {
    event.preventDefault();
    const captureTarget = event.currentTarget;
    captureTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startPanX = state.boardPanX;
    const startPanY = state.boardPanY;
    let didDrag = false;
    function onMove(moveEvent) {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
      state.boardPanX = startPanX + dx;
      state.boardPanY = startPanY + dy;
      applyBoardTransform();
    }
    function onUp() {
      captureTarget.removeEventListener("pointermove", onMove);
      captureTarget.removeEventListener("pointerup", onUp);
      captureTarget.removeEventListener("pointercancel", onUp);
      if (!didDrag) clearSelection(); // tap on empty area deselects
    }
    captureTarget.addEventListener("pointermove", onMove);
    captureTarget.addEventListener("pointerup", onUp);
    captureTarget.addEventListener("pointercancel", onUp);
    return;
  }

  event.preventDefault();

  const captureTarget = event.currentTarget; // .board-frame
  const additive = event.shiftKey || event.metaKey || event.ctrlKey;
  const initialSelection = new Set(state.selectedIds);
  const start = getBoardPoint(event);
  const box = document.createElement("div");
  box.className = "selection-box";
  box.hidden = true;
  dom.board.append(box);
  captureTarget.setPointerCapture(event.pointerId);

  let didDrag = false;

  function updateBox(rect) {
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  function onMove(moveEvent) {
    const current = getBoardPoint(moveEvent);
    const rect = rectFromPoints(start, current);
    didDrag = rect.width > 5 || rect.height > 5;
    if (!didDrag) return;

    box.hidden = false;
    updateBox(rect);
    const hits = state.items.filter((it) => intersectsRect(it, rect)).map((it) => it.id);
    const next = additive ? [...new Set([...initialSelection, ...hits])] : hits;
    selectItems(next);
  }

  function onUp() {
    if (!didDrag && !additive) clearSelection();
    box.remove();
    captureTarget.removeEventListener("pointermove", onMove);
    captureTarget.removeEventListener("pointerup", onUp);
    captureTarget.removeEventListener("pointercancel", onUp);
  }

  captureTarget.addEventListener("pointermove", onMove);
  captureTarget.addEventListener("pointerup", onUp);
  captureTarget.addEventListener("pointercancel", onUp);
}

// ---------- Bulk operations ----------
// ---------- Z-order ----------
export function bringSelectedToFront() {
  const selected = getSelectedItems().sort((a, b) => a.z - b.z);
  if (!selected.length) return;
  for (const item of selected) {
    item.z = bumpZ();
    syncItemElement(item);
  }
  scheduleAutoSave();
}

export function sendSelectedToBack() {
  const selected = getSelectedItems().sort((a, b) => b.z - a.z);
  if (!selected.length) return;
  // Find current minimum z across all items, then place selected items below
  // it (preserving their relative order).
  const minZ = state.items.reduce((m, i) => Math.min(m, i.z ?? 0), Infinity);
  let next = minZ - selected.length;
  for (const item of selected) {
    item.z = next;
    next += 1;
    syncItemElement(item);
  }
  scheduleAutoSave();
}

export function duplicateSelected() {
  const selectedItems = getSelectedItems().sort((a, b) => a.z - b.z);
  if (!selectedItems.length) return;
  const copies = selectedItems.map((s) =>
    createItem({
      type: s.type,
      src: s.src,
      text: s.text,
      fit: s.fit,
      visible: s.visible,
      opacity: s.opacity,
      layerGroup: s.layerGroup,
      x: s.x + 28,
      y: s.y + 28,
      width: s.width,
      height: s.height,
      caption: s.caption ? `${s.caption} copy` : "",
      select: false
    })
  );
  selectItems(copies.map((c) => c.id));
}

// ---------- Cross-canvas clipboard ----------
const CLIPBOARD_KEY = "layerboard_clipboard";

function serializeForClipboard(item) {
  return {
    type: item.type,
    src: item.src,
    text: item.text,
    fit: item.fit,
    visible: item.visible,
    opacity: item.opacity,
    layerGroup: item.layerGroup,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    caption: item.caption,
    fontSize: item.fontSize ?? null,
    color: item.color ?? null,
    fontFamily: item.fontFamily ?? null,
    fontWeight: item.fontWeight ?? null,
    prompt: item.prompt ?? null,
    source: item.source ?? null
  };
}

export function copySelectedToClipboard() {
  const selected = getSelectedItems();
  if (!selected.length) return 0;
  const payload = selected.map(serializeForClipboard);
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(payload));
  } catch (err) {
    // Quota exceeded (large base64 images). Fall back to in-memory clipboard.
    inMemoryClipboard = payload;
    console.warn("[clipboard] localStorage quota exceeded, using in-memory fallback");
  }
  showToast(`已複製 ${selected.length} 個項目`);
  return selected.length;
}

let inMemoryClipboard = null;

export function pasteFromClipboard() {
  let data = null;
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    if (raw) data = JSON.parse(raw);
  } catch {}
  if (!Array.isArray(data) || !data.length) data = inMemoryClipboard;
  if (!Array.isArray(data) || !data.length) return 0;

  clearSelection();
  const created = data.map((d) =>
    createItem({
      ...d,
      x: (d.x || 0) + 28,
      y: (d.y || 0) + 28,
      select: false
    })
  );
  selectItems(created.map((c) => c.id));
  scheduleAutoSave();
  showToast(`已貼上 ${created.length} 個項目`);
  return created.length;
}

export function revertLayer() {
  const primary = getSelectedItem();
  if (!primary?.sourceId) return;

  const sourceId = primary.sourceId;
  const group = primary.layerGroup;

  // 刪除同一 layerGroup 的所有 layer
  const toRemove = state.items.filter(
    (item) => item.layerGroup === group && item.type === "layer"
  );
  for (const item of toRemove) item.el.remove();
  const removedIds = new Set(toRemove.map((i) => i.id));
  state.items = state.items.filter((i) => !removedIds.has(i.id));

  // 還原原圖
  const source = state.items.find((i) => i.id === sourceId);
  if (source) {
    source.visible = true;
    syncItemElement(source);
    selectItems([source.id]);
  } else {
    clearSelection();
  }

  scheduleAutoSave();
  showToast("已還原原始圖層。");
}

export function groupSelected() {
  const selectedItems = getSelectedItems();
  if (selectedItems.length < 2) return;
  const groupId = uid("group");
  for (const item of selectedItems) item.groupId = groupId;
  updateControls();
  scheduleAutoSave();
  showToast(`已群組 ${selectedItems.length} 個物件。`);
}

export function ungroupSelected() {
  const selectedItems = getSelectedItems();
  for (const item of selectedItems) item.groupId = null;
  updateControls();
  scheduleAutoSave();
  showToast("已解散群組。");
}

export function mergeSelected() {
  const selectedItems = getSelectedItems()
    .filter((item) => ["image", "layer"].includes(item.type) && item.src)
    .sort((a, b) => a.z - b.z);
  if (selectedItems.length < 2) return;

  const minX = Math.min(...selectedItems.map((i) => i.x));
  const minY = Math.min(...selectedItems.map((i) => i.y));
  const maxX = Math.max(...selectedItems.map((i) => i.x + i.width));
  const maxY = Math.max(...selectedItems.map((i) => i.y + i.height));
  const w = Math.round(maxX - minX);
  const h = Math.round(maxY - minY);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  let loaded = 0;
  for (const item of selectedItems) {
    const img = new Image();
    img.onload = () => {
      ctx.globalAlpha = item.opacity ?? 1;
      ctx.drawImage(img, Math.round(item.x - minX), Math.round(item.y - minY), item.width, item.height);
      loaded += 1;
      if (loaded === selectedItems.length) {
        const merged = createItem({
          type: "image",
          src: canvas.toDataURL("image/png"),
          fit: "contain",
          x: minX,
          y: minY,
          width: w,
          height: h,
          select: false
        });
        for (const s of selectedItems) {
          s.el.remove();
          const idx = state.items.indexOf(s);
          if (idx !== -1) state.items.splice(idx, 1);
        }
        selectItems([merged.id]);
        scheduleAutoSave();
        showToast("已合併為一個圖層。");
      }
    };
    img.src = item.src;
  }
}

export function deleteSelected() {
  const selectedItems = getSelectedItems();
  if (!selectedItems.length) return;
  for (const s of selectedItems) s.el.remove();
  const deletedIds = new Set(selectedItems.map((s) => s.id));
  state.items = state.items.filter((item) => !deletedIds.has(item.id));
  clearSelection();
  scheduleAutoSave();
}

// ---------- Add note / upload ----------
export function addNote() {
  createItem({
    type: "note",
    text: "New note",
    x: 150 + Math.random() * 260,
    y: 150 + Math.random() * 220,
    width: 260,
    height: 190
  });
}

export function uploadImage(file, x, y) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const src = String(reader.result);
    const img = new Image();
    img.onload = () => {
      const maxW = 420;
      const scale = Math.min(1, maxW / img.naturalWidth);
      createItem({
        type: "image",
        src,
        fit: "contain",
        x: x ?? 180 + Math.random() * 260,
        y: y ?? 140 + Math.random() * 220,
        width: Math.round(img.naturalWidth * scale),
        height: Math.round(img.naturalHeight * scale),
        source: "upload"
      });
    };
    img.src = src;
  };
  reader.onerror = () => showToast("讀取圖片失敗。");
  reader.readAsDataURL(file);
}

// ---------- Board fit ----------
export function fitBoard(silent = false) {
  const frame = document.querySelector(".board-frame");
  if (!frame) return;
  const fitScale = Math.min(
    (frame.clientWidth - 44) / dom.board.offsetWidth,
    (frame.clientHeight - 44) / dom.board.offsetHeight,
    1
  );
  // 初始最低 50%，讓格線清晰可見
  const scale = Math.max(fitScale, 0.5);
  state.boardScale = scale;
  state.boardPanX = 0;
  state.boardPanY = 0;
  applyBoardTransform();
  if (!silent) showToast(`Board scale ${Math.round(scale * 100)}%。`);
}
