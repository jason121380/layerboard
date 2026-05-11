# Layerboard

本地端可跑的 AI moodboard 工作台。整合 OpenAI 圖像生成 API、純前端 Magic Layer 影像分割演算法，並支援**雲端同步**讓 board、生成紀錄、用量跨裝置保留。

## 主要功能

- **AI 生成**：`POST /api/generate` 透過 OpenAI Images API 產出畫布素材
- **Magic Layer**：把任一張圖片拆成 ① OCR 出來的「真正的可編輯文字」（系統預設字型）+ ② Subject layer + ③ Background layer。也可切換 palette / 純文字-圖形模式
- **雲端同步**：board / 生成紀錄 / 用量自動存到伺服器，換裝置只要輸入同一把 OpenAI Key 就會回來
- **多選操作**：框選、Shift / ⌘ 加選；多選後可一起移動、縮放、Duplicate、Delete、Magic Layer
- **拖放上傳**：把任何圖片從桌面拖進畫布即可加入
- **匯出 PNG**：把整張 board 拼合輸出
- **生成相似**：基於目前選取的素材延伸新的方向

## 兩種運行模式

| 模式 | 適用場景 | AI 生成 | 雲端同步 | OCR Magic Layer |
|---|---|---|---|---|
| **後端代理**（推薦）| Zeabur / Render / 本機 | server 用 `OPENAI_API_KEY` 代打，key 不外露 | ✓ | ✓ |
| **靜態前端** | GitHub Pages / Netlify static / CDN | 瀏覽器直接打 `api.openai.com`，key 存在 localStorage | ✗（無伺服器） | ✓ |

前端會自動探測 `/api/health`：通則用後端模式，回 404 則切換靜態模式（status chip 顯示 `… · Static`）。**靜態模式無法做雲端同步**，當下工作階段的 board 不會被持久化。

## 雲端同步運作方式

- **識別**：以 OpenAI API Key 的 SHA-256 雜湊作為帳號 ID（沒有額外註冊／登入流程）。換 Key 等於換帳號，資料各自獨立。
- **儲存**：伺服器把每位使用者的資料寫到 `DATA_DIR/<hash>/board.json | log.json | usage.json`（Zeabur Persistent Volume）。
- **API**：見下方「API」段落的 `/api/board`、`/api/log`、`/api/usage` 端點。
- **同步時機**：board 改動 600ms 後自動 PUT；生成紀錄／用量在事件發生時 PUT。
- **安全提醒**：因為以 API Key 當識別，任何拿到 Key 的人都能讀寫對應的資料。請勿分享你的 Key。

## 啟動（本機 / 後端模式）

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
| `DATA_DIR` | `./data` | 雲端同步資料寫入位置；Zeabur 上應指向已掛載的 Persistent Volume（預設掛在 `/app/data`）|
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
5. Persistent Volume 已宣告於 `zeabur.json`（`/app/data`），Zeabur 會自動配置；雲端同步資料寫在此處，**重新部署不會遺失**

部署相關優化（已實裝）：

- 監聽 `0.0.0.0`，相容 Zeabur / Docker / Cloud Run
- 收到 `SIGTERM` / `SIGINT` 時優雅關閉，避免重新部署時流量被 reset
- 靜態檔加 `Cache-Control: public, max-age=300, must-revalidate`，HTML 用 `no-cache`
- `/api/health` 回傳模型與是否設定 key，可直接用在 healthcheck
- 零外部相依套件，冷啟動 < 1 秒，記憶體 < 50 MB

## 部署到 GitHub Pages（靜態模式）

倉庫已備好 `.github/workflows/pages.yml`，會自動把 `public/` 內容部署到 Pages。

1. Repo Settings → Pages → Source 選 **`GitHub Actions`**
2. push 到 `main` 會自動觸發 workflow（或在 Actions tab 手動 `Run workflow`）
3. Workflow 跑完後 Pages URL 形如 `https://<user>.github.io/layerboard/`
4. 第一次打開時點左下角 status chip → 貼自己的 OpenAI API Key → Save
5. 從此瀏覽器直接打 `api.openai.com`，key 只存在你的 localStorage

> ⚠ **安全提醒**：靜態模式下 OpenAI Key 暴露在瀏覽器執行階段，請只用個人帳號或 spending limit 受控的 key。要分享出去仍推薦走後端代理模式。

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
        ├── persist.js     Board 雲端同步（PUT/GET /api/board）
        ├── generation-log.js 生成紀錄雲端同步（in-memory cache + PUT /api/log）
        ├── usage.js       用量雲端同步（PUT /api/usage）
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

### 雲端同步（皆要求 `X-OpenAI-Key` header）

| 方法 | 路徑 | 用途 |
|---|---|---|
| GET | `/api/board` | 取得整盤 board items |
| PUT | `/api/board` | 覆寫整盤 board，body 為 `{ "items": [...] }` |
| GET | `/api/log` | 取得生成紀錄（最多 100 筆） |
| PUT | `/api/log` | 覆寫生成紀錄，body 為 `{ "entries": [...] }` |
| DELETE | `/api/log` | 清空生成紀錄 |
| GET | `/api/usage` | 取得 `{ count, usd }` |
| PUT | `/api/usage` | 寫入 `{ count, usd }` |

未帶 `X-OpenAI-Key` 一律回 401。資料以該 key 的 SHA-256 前 32 字元當資料夾名隔離。

## 開發備註

- 沒有 npm 相依套件——可直接 `node server.js` 啟動
- 前端使用 ES Modules（`<script type="module">`），需要現代瀏覽器
- 主體分割使用 frequency-tuned saliency + Otsu 自動閾值 + 形態學開閉 + 最大連通元件；色彩分割使用 LAB k-means++（純前端 Canvas）
- **OCR 文字成為真文字**：點擊 Magic Layer 時動態載入 [Tesseract.js](https://tesseract.projectnaptha.com/)（CDN，~3 MB script + 首次下載 ~10 MB 中英文字典，瀏覽器會 cache）。每行 OCR 結果自動成為一個 `type: "text"` item，採用系統預設字型；文字顏色由 bbox 內 Otsu 取樣推得。**雙擊**進入編輯、單擊則拖曳
- 分層模式由 `state.layerMode` 控制（`auto` / `subject` / `palette` / `text`），預設 `auto`（OCR + 主體 + 背景）
- 想升級成 Canva Magic Layer 等級的物件分割精度，可在 `runForMode` 加一個 case 串 Replicate SAM2 / fal.ai BiRefNet 等外部模型
