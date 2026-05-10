# Layerboard

本地端可跑的 AI moodboard 工作台。整合 OpenAI 圖像生成 API，並內建純前端的 Magic Layer 影像分割演算法。

## 主要功能

- **AI 生成**：`POST /api/generate` 透過 OpenAI Images API 產出畫布素材
- **Magic Layer**：把任一張圖片拆成可獨立操作的 Object Layers 或 Color Layers
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
| `OPENAI_IMAGE_MODEL` | `gpt-image-1` | 影像模型名稱；OpenAI 推出新版本時只改這個變數 |
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

- 沒有外部相依套件——可直接 `node server.js` 啟動
- 前端使用 ES Modules（`<script type="module">`），需要現代瀏覽器
- Magic Layer 的主體分割使用 frequency-tuned saliency + Otsu 自動閾值 + 形態學開閉 + 最大連通元件；色彩分割使用 LAB k-means++（純前端 Canvas，無 ML 依賴）
- 分層模式由 `state.layerMode` 控制（`subject` / `palette` / `text`），預設 `subject`；想要 Canva Magic Layer 等級的精度，可自行接 Replicate SAM / fal.ai BiRefNet 等外部模型作為 `runForMode` 的新 case
