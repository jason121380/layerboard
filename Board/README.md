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
| `OPENAI_API_KEY` | _(必填)_ | OpenAI 金鑰；缺少時 `/api/generate` 會回 400 |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1` | 影像模型名稱；模型替換時只改這個變數 |
| `PORT` | `3000` | 伺服器埠號 |

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
- Magic Layer 的物件分割使用邊緣顏色取樣 + 形態學閉運算 + 連通元件分析；色彩分割使用色彩量化 + 距離分群（純前端 Canvas，無 ML 依賴）
