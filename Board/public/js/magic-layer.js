/**
 * magic-layer.js — perceptual image segmentation.
 *
 * Two modes:
 *   - "subject": frequency-tuned saliency in LAB space → Otsu threshold →
 *                morphological cleanup → largest connected region
 *                Output: subject layer (alpha-cut) + background layer (subject removed)
 *
 *   - "palette": stratified-sample → k-means in LAB color space (k-means++ seed) →
 *                assign every pixel to nearest centroid → emit k color layers
 *                Output: k alpha-cut layers, ordered by area, named by hex
 *
 * Both modes produce clean alpha-cut layers (no jagged bounding boxes),
 * dramatically better than the previous threshold-based implementation.
 */

import { state, dom, bumpZ, showToast } from "./state.js";
import {
  uid,
  loadImage,
  rgbToLab,
  labDistanceSq,
  rgbToHex,
  otsuThreshold,
  boxBlur
} from "./utils.js";
import {
  createItem,
  getSelectedItem,
  getSelectedItems,
  selectItem,
  selectItems,
  syncItemElement,
  updateControls
} from "./items.js";

const MAX_PROCESS_SIDE = 720;
const KMEANS_SAMPLE_SIZE = 8000;
const KMEANS_MAX_ITER = 14;

// ====================================================================
// Shared helpers
// ====================================================================

function drawToCanvas(image) {
  const scale = Math.min(
    1,
    MAX_PROCESS_SIDE / Math.max(image.naturalWidth, image.naturalHeight)
  );
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  return { ctx, width, height, data: ctx.getImageData(0, 0, width, height).data };
}

/**
 * Build an RGBA layer canvas from a binary mask.
 * Crops to the mask's bounding box and feathers edges by 1px alpha.
 */
function maskToLayer(data, srcWidth, srcHeight, mask) {
  let minX = srcWidth;
  let minY = srcHeight;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < srcHeight; y += 1) {
    for (let x = 0; x < srcWidth; x += 1) {
      if (mask[y * srcWidth + x]) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const padding = 2;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(srcWidth - 1, maxX + padding);
  maxY = Math.min(srcHeight - 1, maxY + padding);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(width, height);

  let area = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = x + minX;
      const sy = y + minY;
      const mIdx = sy * srcWidth + sx;
      if (!mask[mIdx]) continue;
      area += 1;
      const sIdx = mIdx * 4;
      const dIdx = (y * width + x) * 4;
      out.data[dIdx] = data[sIdx];
      out.data[dIdx + 1] = data[sIdx + 1];
      out.data[dIdx + 2] = data[sIdx + 2];
      // 1-px alpha feather: edge pixels (no neighbour) → 200, interior → 255
      const interior =
        sx > 0 &&
        sy > 0 &&
        sx < srcWidth - 1 &&
        sy < srcHeight - 1 &&
        mask[(sy - 1) * srcWidth + sx] &&
        mask[(sy + 1) * srcWidth + sx] &&
        mask[sy * srcWidth + sx - 1] &&
        mask[sy * srcWidth + sx + 1];
      out.data[dIdx + 3] = interior ? 255 : 220;
    }
  }
  ctx.putImageData(out, 0, 0);

  return {
    src: canvas.toDataURL("image/png"),
    x: minX,
    y: minY,
    width,
    height,
    area
  };
}

/** Morphological dilation (radius 1, 4-connected). */
function dilate(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (
        mask[i] ||
        (x > 0 && mask[i - 1]) ||
        (x < width - 1 && mask[i + 1]) ||
        (y > 0 && mask[i - width]) ||
        (y < height - 1 && mask[i + width])
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

/** Morphological erosion (radius 1, 4-connected). */
function erode(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
      if (
        mask[i - 1] &&
        mask[i + 1] &&
        mask[i - width] &&
        mask[i + width]
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

/** Keep only the largest connected component above minArea. */
function largestComponent(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let bestMask = null;
  let bestArea = 0;

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = Math.floor(idx / width);
      const neighbours = [];
      if (x > 0) neighbours.push(idx - 1);
      if (x < width - 1) neighbours.push(idx + 1);
      if (y > 0) neighbours.push(idx - width);
      if (y < height - 1) neighbours.push(idx + width);
      for (const n of neighbours) {
        if (visited[n] || !mask[n]) continue;
        visited[n] = 1;
        queue[tail++] = n;
      }
    }

    if (tail > bestArea) {
      bestArea = tail;
      bestMask = new Uint8Array(mask.length);
      for (let i = 0; i < tail; i += 1) bestMask[queue[i]] = 1;
    }
  }

  return bestMask || new Uint8Array(mask.length);
}

// ====================================================================
// Mode 1: Subject (saliency-based foreground / background split)
// ====================================================================

function buildSaliencyMask(data, width, height, sensitivity) {
  // Build per-channel float images in LAB.
  const total = width * height;
  const labL = new Float32Array(total);
  const labA = new Float32Array(total);
  const labB = new Float32Array(total);
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;

  for (let i = 0; i < total; i += 1) {
    const px = i * 4;
    const lab = rgbToLab(data[px], data[px + 1], data[px + 2]);
    labL[i] = lab[0];
    labA[i] = lab[1];
    labB[i] = lab[2];
    sumL += lab[0];
    sumA += lab[1];
    sumB += lab[2];
  }
  const meanL = sumL / total;
  const meanA = sumA / total;
  const meanB = sumB / total;

  // Gaussian-ish smoothing via two box blurs.
  const radius = Math.max(2, Math.round(Math.min(width, height) / 80));
  const blurL = boxBlur(boxBlur(labL, width, height, radius), width, height, radius);
  const blurA = boxBlur(boxBlur(labA, width, height, radius), width, height, radius);
  const blurB = boxBlur(boxBlur(labB, width, height, radius), width, height, radius);

  // Saliency = distance between blurred LAB and global mean LAB.
  const saliency = new Float32Array(total);
  let maxSal = 0;
  for (let i = 0; i < total; i += 1) {
    const dl = blurL[i] - meanL;
    const da = blurA[i] - meanA;
    const db = blurB[i] - meanB;
    const v = Math.sqrt(dl * dl + da * da + db * db);
    saliency[i] = v;
    if (v > maxSal) maxSal = v;
  }

  // Normalise to 0..255 then Otsu threshold.
  const norm = new Uint8Array(total);
  if (maxSal > 0) {
    for (let i = 0; i < total; i += 1) {
      norm[i] = Math.min(255, Math.round((saliency[i] / maxSal) * 255));
    }
  }
  const auto = otsuThreshold(norm);
  // Sensitivity 0..1 nudges the threshold ±35 levels.
  const threshold = Math.max(8, Math.min(248, Math.round(auto + (sensitivity - 0.5) * 70)));

  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (norm[i] >= threshold) mask[i] = 1;
  }

  // Open then close: removes speckles + fills holes.
  let cleaned = erode(mask, width, height);
  cleaned = dilate(cleaned, width, height);
  cleaned = dilate(cleaned, width, height);
  cleaned = erode(cleaned, width, height);

  return largestComponent(cleaned, width, height);
}

async function runSubjectMode(selected) {
  const image = await loadImage(selected.src);
  const { data, width, height } = drawToCanvas(image);
  const sensitivity = Number(dom.sensitivityInput?.value ?? 50) / 100;
  const subjectMask = buildSaliencyMask(data, width, height, sensitivity);

  let subjectArea = 0;
  for (let i = 0; i < subjectMask.length; i += 1) subjectArea += subjectMask[i];
  if (subjectArea / subjectMask.length < 0.005) return [];

  const backgroundMask = new Uint8Array(subjectMask.length);
  for (let i = 0; i < subjectMask.length; i += 1) {
    backgroundMask[i] = subjectMask[i] ? 0 : 1;
  }

  const layers = [];
  const subjectLayer = maskToLayer(data, width, height, subjectMask);
  if (subjectLayer) layers.push({ ...subjectLayer, kind: "subject" });
  const backgroundLayer = maskToLayer(data, width, height, backgroundMask);
  if (backgroundLayer) layers.push({ ...backgroundLayer, kind: "background" });
  return layers.map((layer) => ({ ...layer, sourceWidth: width, sourceHeight: height }));
}

// ====================================================================
// Mode 2: Palette (k-means in LAB)
// ====================================================================

function kmeansPlusPlusSeed(samples, k) {
  if (samples.length <= k) return samples.slice();
  const centroids = [];
  const firstIdx = Math.floor(Math.random() * samples.length);
  centroids.push(samples[firstIdx]);

  while (centroids.length < k) {
    let totalDist = 0;
    const dists = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      let best = Infinity;
      for (const c of centroids) {
        const d = labDistanceSq(samples[i], c);
        if (d < best) best = d;
      }
      dists[i] = best;
      totalDist += best;
    }
    if (!totalDist) break;
    let pick = Math.random() * totalDist;
    let chosen = 0;
    for (let i = 0; i < samples.length; i += 1) {
      pick -= dists[i];
      if (pick <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push(samples[chosen]);
  }

  return centroids;
}

function kmeans(samples, k) {
  let centroids = kmeansPlusPlusSeed(samples, k);
  const assignments = new Int32Array(samples.length);

  for (let iter = 0; iter < KMEANS_MAX_ITER; iter += 1) {
    let changed = 0;
    for (let i = 0; i < samples.length; i += 1) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const d = labDistanceSq(samples[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed += 1;
      }
    }

    const sums = centroids.map(() => [0, 0, 0]);
    const counts = new Int32Array(centroids.length);
    for (let i = 0; i < samples.length; i += 1) {
      const c = assignments[i];
      sums[c][0] += samples[i][0];
      sums[c][1] += samples[i][1];
      sums[c][2] += samples[i][2];
      counts[c] += 1;
    }
    centroids = sums.map((s, c) =>
      counts[c] ? [s[0] / counts[c], s[1] / counts[c], s[2] / counts[c]] : centroids[c]
    );

    if (!changed) break;
  }

  return centroids;
}

function pickK() {
  // Slider value 18..96 → k = 3..8
  const v = Number(dom.sensitivityInput?.value ?? 60);
  const ratio = (v - 18) / 78;
  return Math.min(8, Math.max(3, 3 + Math.round(ratio * 5)));
}

function labCentroidToHex(centroid) {
  // Inverse LAB → sRGB (approximate; fine for swatch labels).
  const fy = (centroid[0] + 16) / 116;
  const fx = centroid[1] / 500 + fy;
  const fz = fy - centroid[2] / 200;
  const finv = (t) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = 0.95047 * finv(fx);
  const y = 1.0 * finv(fy);
  const z = 1.08883 * finv(fz);
  const r = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const g = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const b = x * 0.0557 + y * -0.204 + z * 1.057;
  const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  return rgbToHex(toSrgb(r) * 255, toSrgb(g) * 255, toSrgb(b) * 255);
}

async function runPaletteMode(selected) {
  const image = await loadImage(selected.src);
  const { data, width, height } = drawToCanvas(image);
  const total = width * height;
  const k = pickK();

  // Stratified random sample for centroid seeding.
  const stride = Math.max(1, Math.floor(total / KMEANS_SAMPLE_SIZE));
  const samples = [];
  const sampleIndices = [];
  for (let i = 0; i < total; i += stride) {
    const px = i * 4;
    if (data[px + 3] < 24) continue;
    samples.push(rgbToLab(data[px], data[px + 1], data[px + 2]));
    sampleIndices.push(i);
  }
  if (samples.length < k) return [];

  const centroids = kmeans(samples, k);

  // Assign every pixel to nearest centroid.
  const masks = Array.from({ length: k }, () => new Uint8Array(total));
  const counts = new Int32Array(k);
  for (let i = 0; i < total; i += 1) {
    const px = i * 4;
    if (data[px + 3] < 24) continue;
    const lab = rgbToLab(data[px], data[px + 1], data[px + 2]);
    let best = 0;
    let bestDist = Infinity;
    for (let c = 0; c < k; c += 1) {
      const d = labDistanceSq(lab, centroids[c]);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    masks[best][i] = 1;
    counts[best] += 1;
  }

  // Build layer images, sorted by area desc.
  const layers = [];
  for (let c = 0; c < k; c += 1) {
    if (counts[c] / total < 0.012) continue; // skip dust clusters
    const layer = maskToLayer(data, width, height, masks[c]);
    if (!layer) continue;
    layers.push({
      ...layer,
      kind: "palette",
      hex: labCentroidToHex(centroids[c]),
      sourceWidth: width,
      sourceHeight: height
    });
  }
  layers.sort((a, b) => b.area - a.area);
  return layers;
}

// ====================================================================
// Public: split selected items
// ====================================================================

// ====================================================================
// Mode 3: Text/Graph split — Sobel edge density → dilate → separate
// ====================================================================

async function runTextGraphMode(selected) {
  const image = await loadImage(selected.src);
  const { data, width, height } = drawToCanvas(image);
  const total = width * height;

  // Grayscale
  const gray = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const px = i * 4;
    gray[i] = 0.299 * data[px] + 0.587 * data[px + 1] + 0.114 * data[px + 2];
  }

  // Sobel edge magnitude
  const edgeMap = new Float32Array(total);
  let maxEdge = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx =
        -gray[(y - 1) * width + (x - 1)] + gray[(y - 1) * width + (x + 1)]
        - 2 * gray[y * width + (x - 1)] + 2 * gray[y * width + (x + 1)]
        - gray[(y + 1) * width + (x - 1)] + gray[(y + 1) * width + (x + 1)];
      const gy =
        -gray[(y - 1) * width + (x - 1)] - 2 * gray[(y - 1) * width + x] - gray[(y - 1) * width + (x + 1)]
        + gray[(y + 1) * width + (x - 1)] + 2 * gray[(y + 1) * width + x] + gray[(y + 1) * width + (x + 1)];
      const mag = Math.sqrt(gx * gx + gy * gy);
      edgeMap[y * width + x] = mag;
      if (mag > maxEdge) maxEdge = mag;
    }
  }

  // Normalise → Otsu threshold
  const edgeNorm = new Uint8Array(total);
  if (maxEdge > 0) {
    for (let i = 0; i < total; i += 1) {
      edgeNorm[i] = Math.min(255, Math.round((edgeMap[i] / maxEdge) * 255));
    }
  }
  const edgeThresh = otsuThreshold(edgeNorm);
  let textMask = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (edgeNorm[i] >= edgeThresh) textMask[i] = 1;
  }

  // Dilate to fill character interiors
  const dilateR = Math.max(2, Math.round(Math.min(width, height) / 55));
  for (let r = 0; r < dilateR; r += 1) textMask = dilate(textMask, width, height);

  const graphMask = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) graphMask[i] = textMask[i] ? 0 : 1;

  const layers = [];
  const textLayer = maskToLayer(data, width, height, textMask);
  if (textLayer) layers.push({ ...textLayer, kind: "text" });
  const graphLayer = maskToLayer(data, width, height, graphMask);
  if (graphLayer) layers.push({ ...graphLayer, kind: "graph" });

  return layers.map((l) => ({ ...l, sourceWidth: width, sourceHeight: height }));
}

function captionFor(layer, base, index, total) {
  if (layer.kind === "text") return "文字";
  if (layer.kind === "graph") return "圖形";
  if (layer.kind === "subject") return `${base || "主體"}`;
  if (layer.kind === "background") return `${base || "主體"} · 背景`;
  if (layer.kind === "palette") return `${layer.hex || `色彩 ${index + 1}`}`;
  return `${base || "圖層"} ${index + 1}/${total}`;
}

async function splitItemIntoLayers(selected) {
  const layers = await runTextGraphMode(selected);

  if (!layers.length) return { group: null, layers: [] };

  const group = uid("layer-group");
  const scaleX = selected.width / layers[0].sourceWidth;
  const scaleY = selected.height / layers[0].sourceHeight;

  const created = layers.map((layer, index) =>
    createItem({
      type: "layer",
      src: layer.src,
      caption: captionFor(layer, selected.caption, index, layers.length),
      x: Math.round(selected.x + layer.x * scaleX),
      y: Math.round(selected.y + layer.y * scaleY),
      width: Math.max(34, Math.round(layer.width * scaleX)),
      height: Math.max(34, Math.round(layer.height * scaleY)),
      fit: "contain",
      layerGroup: group,
      sourceId: selected.id,
      select: false
    })
  );

  selected.visible = false;
  syncItemElement(selected);
  return { group, layers: created };
}

export async function magicLayerSelected() {
  const targets = getSelectedItems().filter(
    (item) => ["image", "layer"].includes(item.type) && item.src
  );
  if (!targets.length) return;

  if (dom.magicBtn) {
    dom.magicBtn.disabled = true;
    dom.magicBtn.classList.add("is-busy");
    dom.magicBtn.textContent = "拆解中…";
  }

  try {
    const createdLayers = [];
    let lastGroup = null;
    for (const target of targets) {
      const result = await splitItemIntoLayers(target);
      createdLayers.push(...result.layers);
      lastGroup = result.group || lastGroup;
    }

    if (!createdLayers.length) {
      showToast("沒有分出可用的圖層。試試另一個模式或調整 sensitivity。");
      return;
    }

    selectItems(createdLayers.map((layer) => layer.id));
    renderLayerPanel(targets.length === 1 ? lastGroup : null);
    showToast(`已從 ${targets.length} 張圖拆出 ${createdLayers.length} 個圖層。`);
  } catch (error) {
    showToast(error.message);
  } finally {
    if (dom.magicBtn) dom.magicBtn.classList.remove("is-busy");
    updateControls();
  }
}

// ====================================================================
// Layer panel render
// ====================================================================

export function renderLayerPanel(_group = null) {
  // Panel removed — no-op.
}
