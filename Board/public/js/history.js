/**
 * history.js — undo / redo via snapshots of item data.
 */

import { state } from "./state.js";
import { createItem, clearSelection } from "./items.js";

const MAX = 60;
let stack = [];
let cursor = -1;

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
    groupId: item.groupId || null,
    sourceId: item.sourceId || null
  }));
}

function restore(snapshot) {
  for (const item of state.items) item.el.remove();
  state.items = [];
  state.zCounter = 10;
  clearSelection();

  for (const data of snapshot) {
    createItem({ ...data, select: false });
    if (data.z > state.zCounter) state.zCounter = data.z;
  }
}

export function pushHistory() {
  stack = stack.slice(0, cursor + 1);
  stack.push(snap());
  if (stack.length > MAX) stack.shift();
  else cursor++;
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
