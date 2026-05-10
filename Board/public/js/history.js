/**
 * history.js — undo / redo via snapshots of item data.
 */

import { state, dom } from "./state.js";
import { createItem, clearSelection } from "./items.js";

const MAX = 60;
let stack = [];
let cursor = -1;

// ---------- Serialise ----------
function snap() {
  return state.items.map((item) => ({
    id: item.id,
    type: item.type,
    x: item.x, y: item.y,
    width: item.width, height: item.height,
    src: item.src, text: item.text,
    caption: item.caption, fit: item.fit,
    visible: item.visible, opacity: item.opacity,
    z: item.z,
    layerGroup: item.layerGroup || null,
    groupId: item.groupId || null
  }));
}

// ---------- Restore ----------
function restore(snapshot) {
  for (const item of state.items) item.el.remove();
  state.items = [];
  state.zCounter = 10;
  clearSelection();

  for (const data of snapshot) {
    createItem({ ...data, select: false });
    if (data.z > state.zCounter) state.zCounter = data.z;
  }
  updateButtons();
}

// ---------- Buttons ----------
function updateButtons() {
  if (dom.undoBtn) dom.undoBtn.disabled = cursor <= 0;
  if (dom.redoBtn) dom.redoBtn.disabled = cursor >= stack.length - 1;
}

// ---------- Public ----------
export function pushHistory() {
  stack = stack.slice(0, cursor + 1);
  stack.push(snap());
  if (stack.length > MAX) { stack.shift(); } else { cursor++; }
  updateButtons();
}

export function undo() {
  if (cursor <= 0) return;
  cursor--;
  restore(stack[cursor]);
}

export function redo() {
  if (cursor >= stack.length - 1) return;
  cursor++;
  restore(stack[cursor]);
}
