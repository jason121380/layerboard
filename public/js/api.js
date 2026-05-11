/**
 * api.js — server calls and PNG export.
 */

import { state, dom, showToast } from "./state.js";
import { loadImage, wrapText } from "./utils.js";
import { createItem, getSelectedItems } from "./items.js";
import { scheduleAutoSave } from "./persist.js";
import { recordImages } from "./usage.js";

export async function exportSelectedItems() {
  const items = getSelectedItems().filter((i) => i.visible !== false);
  if (!items.length) {
    showToast("請先選取要匯出的物件。");
    return;
  }
  const minX = Math.min(...items.map((i) => i.x)) - 20;
  const minY = Math.min(...items.map((i) => i.y)) - 20;
  const maxX = Math.max(...items.map((i) => i.x + i.width)) + 20;
  const maxY = Math.max(...items.map((i) => i.y + i.height)) + 20;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(maxX - minX);
  canvas.height = Math.ceil(maxY - minY);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const item of [...items].sort((a, b) => a.z - b.z)) {
    ctx.globalAlpha = item.opacity ?? 1;
    try {
      const img = await loadImage(item.src);
      ctx.drawImage(img, item.x - minX, item.y - minY, item.width, item.height);
    } catch {
      ctx.fillStyle = "#ddd6c7";
      ctx.fillRect(item.x - minX, item.y - minY, item.width, item.height);
    }
  }
  ctx.globalAlpha = 1;
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `export-${new Date().toISOString().slice(0, 10)}.png`;
  link.click();
  showToast("已匯出選取項目。");
}

export const seedPrompts = [
  "半透明玻璃香氛瓶、銀色金屬托盤、苔蘚綠背景、早晨斜射光",
  "模組化工作桌、黑色碳纖維、青綠色細節、安靜高效的創作者工具",
  "夏季飲料包裝、番茄紅和奶油白、手工紙材質、陽光下的桌面",
  "未來感運動鞋、紫色 TPU 透明片、濕潤柏油路、低角度攝影",
  "咖啡館品牌情緒板、黃銅招牌、深綠瓷磚、柔和自然光"
];

function setLoading(isLoading) {
  if (!dom.generateBtn) return;
  dom.generateBtn.disabled = isLoading;
  dom.generateBtn.classList.toggle("is-loading", isLoading);
  dom.generateBtn.setAttribute("aria-label", isLoading ? "Generating image" : "Generate image");
  const span = dom.generateBtn.querySelector("span");
  if (span) span.textContent = isLoading ? "…" : "→";

  if (dom.promptInput) {
    dom.promptInput.disabled = isLoading;
    dom.promptInput.style.opacity = isLoading ? "0.5" : "";
  }
  if (dom.uploadBtn) dom.uploadBtn.disabled = isLoading;

  const row = document.querySelector(".mixer-input-row");
  row?.classList.toggle("is-generating", isLoading);
}

function getApiKey() {
  return localStorage.getItem("openai_api_key") || "";
}

export function saveApiKey(key) {
  if (key) localStorage.setItem("openai_api_key", key.trim());
  else localStorage.removeItem("openai_api_key");
}

export async function generateImages() {
  const prompt = dom.promptInput?.value.trim() || "";
  if (!prompt) {
    showToast("先寫一段 prompt。");
    dom.promptInput?.focus();
    return;
  }

  const key = getApiKey();
  setLoading(true);
  try {
    const headers = { "Content-Type": "application/json" };
    if (key) headers["X-OpenAI-Key"] = key;
    const aspectRatio = "square";
    const response = await fetch("/api/generate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt,
        context: "",
        style: "editorial product moodboard",
        aspectRatio,
        count: 1
      })
    });
    const payload = await response.json();
    if (payload.model && dom.modelLabel) dom.modelLabel.textContent = payload.model;
    if (!response.ok) throw new Error(payload.error || "Image generation failed.");

    const baseX = 1720 + Math.random() * 420;
    const baseY = 690 + Math.random() * 360;

    for (const src of payload.images || []) {
      createItem({
        type: "image",
        src,
        fit: "contain",
        x: Math.round(baseX + Math.random() * 360),
        y: Math.round(baseY + Math.random() * 280),
        width: 330,
        height: 330
      });
    }
    recordImages(payload.images?.length || 1);
    scheduleAutoSave();
    showToast("已生成並放到 board。");
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
}

export async function generateSimilar() {
  const selectedImages = getSelectedItems().filter((item) =>
    ["image", "layer"].includes(item.type)
  );
  if (!selectedImages.length) return;
  const seed = selectedImages
    .map((item, index) => item.caption || `selected visual ${index + 1}`)
    .join(", ");
  if (dom.promptInput) {
    dom.promptInput.value = `Create a fresh variation inspired by these selected board items: ${seed}. Keep the moodboard direction but change composition, materials, and lighting.`;
  }
  await generateImages();
}

export async function exportBoard() {
  const visibleItems = state.items.filter((item) => item.visible !== false);
  if (!visibleItems.length) {
    showToast("Board 上還沒有可匯出的內容。");
    return;
  }

  const minX = Math.max(0, Math.min(...visibleItems.map((it) => it.x)) - 40);
  const minY = Math.max(0, Math.min(...visibleItems.map((it) => it.y)) - 40);
  const maxX = Math.max(...visibleItems.map((it) => it.x + it.width)) + 40;
  const maxY = Math.max(...visibleItems.map((it) => it.y + it.height)) + 40;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(3200, Math.ceil(maxX - minX));
  canvas.height = Math.min(2400, Math.ceil(maxY - minY));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fbfaf5";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const item of [...visibleItems].sort((a, b) => a.z - b.z)) {
    const x = item.x - minX;
    const y = item.y - minY;
    ctx.globalAlpha = item.opacity ?? 1;
    if (item.type === "note") {
      ctx.fillStyle = "#fff8c9";
      ctx.fillRect(x, y, item.width, item.height);
      ctx.fillStyle = "#262016";
      ctx.font = "20px system-ui, sans-serif";
      wrapText(ctx, item.text || "", x + 18, y + 36, item.width - 36, 26);
    } else {
      try {
        const image = await loadImage(item.src);
        ctx.drawImage(image, x, y, item.width, item.height);
      } catch {
        ctx.fillStyle = "#ddd6c7";
        ctx.fillRect(x, y, item.width, item.height);
      }
    }
  }
  ctx.globalAlpha = 1;

  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `layerboard-${new Date().toISOString().slice(0, 10)}.png`;
  link.click();
  showToast("已匯出 PNG。");
}

export function pickRandomSeedPrompt() {
  return seedPrompts[Math.floor(Math.random() * seedPrompts.length)];
}
