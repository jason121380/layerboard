/**
 * api.js — server calls and PNG export.
 */

import { state, dom, showToast, showLoadingProgress } from "./state.js";
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

const PROMPT_SUFFIX =
  "Visual direction: editorial product moodboard.\n" +
  "Create a polished visual asset suitable for a design moodboard. " +
  "Avoid text, watermarks, logos, and UI chrome unless explicitly requested.";

function buildFinalPrompt(prompt) {
  return `${prompt}\n${PROMPT_SUFFIX}`;
}

/** Call our own /api/generate proxy (Node host: Zeabur / Render / Vercel functions). */
async function generateViaBackend(prompt, key) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-OpenAI-Key"] = key;
  const response = await fetch("/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      context: "",
      style: "editorial product moodboard",
      aspectRatio: "square",
      count: 1
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Image generation failed.");
  return payload;
}

/** Call OpenAI Images API directly from the browser. Used in static deploy. */
async function generateDirect(prompt, key) {
  const model = (dom.modelLabel?.textContent || "gpt-image-2").replace(/\s·.+$/, "").trim();
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      prompt: buildFinalPrompt(prompt),
      size: "1024x1024",
      n: 1
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || "OpenAI image generation failed.");
  }
  const images = (payload.data || [])
    .map((item) => (item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url))
    .filter(Boolean);
  return {
    images,
    model,
    revisedPrompt: payload.data?.[0]?.revised_prompt
  };
}

// User can dismiss the confirm dialog for the rest of the session.
let skipConfirmThisSession = false;

function confirmGenerate(prompt) {
  return new Promise((resolve) => {
    const modal = document.querySelector("#generateConfirmModal");
    const okBtn = document.querySelector("#confirmGenerateOk");
    const cancelBtn = document.querySelector("#confirmGenerateCancel");
    const skipBox = document.querySelector("#confirmSkipNext");
    const promptText = document.querySelector("#confirmPromptText");
    const modelText = document.querySelector("#confirmModelText");
    if (!modal || !okBtn || !cancelBtn) return resolve(true);

    if (promptText) promptText.textContent = prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt;
    if (modelText) modelText.textContent = (dom.modelLabel?.textContent || "gpt-image-2").replace(/\s·.+$/, "");
    if (skipBox) skipBox.checked = false;
    modal.hidden = false;

    function cleanup() {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
    }
    function onOk() {
      if (skipBox?.checked) skipConfirmThisSession = true;
      cleanup();
      resolve(true);
    }
    function onCancel() { cleanup(); resolve(false); }
    function onBackdrop(e) { if (e.target === modal) onCancel(); }
    function onKey(e) {
      if (e.key === "Enter") onOk();
      else if (e.key === "Escape") onCancel();
    }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    okBtn.focus();
  });
}

export async function generateImages() {
  const prompt = dom.promptInput?.value.trim() || "";
  if (!prompt) {
    showToast("先寫一段 prompt。");
    dom.promptInput?.focus();
    return;
  }

  const key = getApiKey();
  // Static deploy needs the user's key to call OpenAI directly.
  if (state.hasBackend === false && !key) {
    showToast("靜態模式：請先點左下角輸入 OpenAI Key。");
    return;
  }

  if (!skipConfirmThisSession) {
    const ok = await confirmGenerate(prompt);
    if (!ok) return;
  }

  setLoading(true);
  const start = Date.now();
  const progress = showLoadingProgress("生成中… 0 秒");
  const tick = window.setInterval(() => {
    const sec = Math.floor((Date.now() - start) / 1000);
    const label =
      sec < 8 ? `生成中… ${sec} 秒` :
      sec < 20 ? `生成中… ${sec} 秒（OpenAI 通常 15–25 秒）` :
      sec < 40 ? `仍在等 OpenAI 回應… ${sec} 秒` :
      `${sec} 秒，OpenAI 可能塞車中，請耐心等`;
    progress.update(label);
  }, 500);

  try {
    const payload =
      state.hasBackend === false
        ? await generateDirect(prompt, key)
        : await generateViaBackend(prompt, key);

    if (payload.model && dom.modelLabel) {
      const suffix = state.hasBackend === false ? " · Static" : "";
      dom.modelLabel.textContent = `${payload.model}${suffix}`;
    }

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
    const sec = Math.max(1, Math.round((Date.now() - start) / 1000));
    progress.end(`已生成（${sec} 秒）。`);
  } catch (error) {
    progress.end(`生成失敗：${error.message}`);
  } finally {
    window.clearInterval(tick);
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
