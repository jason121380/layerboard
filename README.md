# Layerboard

本地端可跑的 AI moodboard 工作台。整合 OpenAI 圖像生成 API，並內建純前端的 Magic Layer 影像分割演算法。

## 主要功能

- **AI 生成**：`POST /api/generate` 透過 OpenAI Images API 產出畫布素材
- **Magic Layer**：把任一張圖片拆成 ① OCR 出來的「真正的可編輯文字」（系統預設字型）+ ② Subject layer + ③ Background layer。也可切換 palette / 純文字-圖形模式
- **多選操作**：框選、Shift / ⌘ 加選；多選後可一起移動、縮放、Duplicate、Delete、Magic Layer
- **拖放上傳**：把任何圖片從桌面拖進畫布即可加入
- **匯出 PNG**：把整張 board 拼合輸出
- **生成相似**：基於目前選取的素材延伸新的方向

## 啟動

```bash
export OPENAI_API_KEY="你的 key"
npm run dev
```

打開 <http://localhost:3000>。

## 環境變數

| 名稱 | 預設值 | 說明 |
|---|---|---|
| `OPENAI_API_KEY` | _(選填)_ | OpenAI 金鑰；未設定時前端可由右上角 chip 自行輸入並存到 localStorage（透過 `X-OpenAI-Key` 標頭傳給伺服器）|
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | 影像模型名稱（2026/04 起官方推薦）；要降級到 `gpt-image-1` / `gpt-image-1-mini` / `gpt-image-1.5` 改這個變數即可 |
| `PORT` | `3000` | 伺服器埠號（Zeabur 等平台會自動注入）|
| `HOST` | `0.0.0.0` | 監聽位址；容器/PaaS 部署需保持 `0.0.0.0` |

## 部署到 Zeabur

倉庫已備好 `zeabur.json` 與 `package.json` 的 `engines.node ≥ 20`，Zeabur 會自動偵測為 Node.js 專案。

1. 在 Zeabur 建立服務 → 連結 GitHub repo
2. 設定環境變數：
   - `OPENAI_API_KEY`（選填；不放也能用，由前端輸入）
   - `OPENAI_IMAGE_MODEL`（選填）
3. 開啟 HTTP Domain，Zeabur 會把外部流量導到容器的 `PORT`（自動注入）
4. Healthcheck 使用 `/api/health`（已在 `zeabur.json` 內設定）

部署相關優化（已實裝）：

- 監聽 `0.0.0.0`，相容 Zeabur / Docker / Cloud Run
- 收到 `SIGTERM` / `SIGINT` 時優雅關閉，避免重新部署時流量被 reset
- 靜態檔加 `Cache-Control: public, max-age=300, must-revalidate`，HTML 用 `no-cache`
- `/api/health` 回傳模型與是否設定 key，可直接用在 healthcheck
- 零外部相依套件，冷啟動 < 1 秒，記憶體 < 50 MB

## 專案結構

```
.
├── server.js              純 Node HTTP 伺服器（無外部相依）
├── package.json
├── README.md
└── public/
    ├── index.html         單頁應用骨架
    ├── styles.css         全部樣式（含響應式）
    ├── logo.png
    └── js/
        ├── main.js        進入點與事件綁定
        ├── state.js       狀態與 DOM 引用
        ├── utils.js       輔助工具（uid、toast、loadImage…）
        ├── items.js       Item 生命週期（建立/拖曳/縮放/選取）
        ├── magic-layer.js Magic Layer 影像分割演算法
        └── api.js         生成、相似生成、PNG 匯出
```

## API

### `POST /api/generate`

```json
{
  "prompt": "...",
  "context": "(選填)",
  "style": "(選填，預設 editorial product moodboard)",
  "aspectRatio": "square | portrait | landscape",
  "count": 1
}
```

回應：

```json
{
  "images": ["data:image/png;base64,..." | "https://..."],
  "model": "gpt-image-1",
  "revisedPrompt": "..."
}
```

### `GET /api/health`

回傳目前伺服器狀態與是否已設定金鑰。

## 開發備註

- 沒有 npm 相依套件——可直接 `node server.js` 啟動
- 前端使用 ES Modules（`<script type="module">`），需要現代瀏覽器
- 主體分割使用 frequency-tuned saliency + Otsu 自動閾值 + 形態學開閉 + 最大連通元件；色彩分割使用 LAB k-means++（純前端 Canvas）
- **OCR 文字成為真文字**：點擊 Magic Layer 時動態載入 [Tesseract.js](https://tesseract.projectnaptha.com/)（CDN，~3 MB script + 首次下載 ~10 MB 中英文字典，瀏覽器會 cache）。每行 OCR 結果自動成為一個 `type: "text"` item，採用系統預設字型；文字顏色由 bbox 內 Otsu 取樣推得。**雙擊**進入編輯、單擊則拖曳
- 分層模式由 `state.layerMode` 控制（`auto` / `subject` / `palette` / `text`），預設 `auto`（OCR + 主體 + 背景）
- 想升級成 Canva Magic Layer 等級的物件分割精度，可在 `runForMode` 加一個 case 串 Replicate SAM2 / fal.ai BiRefNet 等外部模型
