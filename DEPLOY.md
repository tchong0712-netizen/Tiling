# 上线部署说明（全新开始版）

目标：把这个网页发布到网上，让**别的电脑也能打开**，并且让“Gemini 识别图纸”真正能用，同时**不把 API key 暴露在前端**。

本说明只走**一条路：Cloudflare Worker + Static Assets**。
不要再混用 Cloudflare Pages，两者设置不一样，混着用就是部署一直失败的主要原因。

---

## 0. 工作原理（先看懂再操作）

- 你的网页（`public/index.html`）由 Cloudflare Worker 当静态文件直接发出去。
- 网页里点“Gemini 识别图纸”时，会请求同一个 Worker 的 `/api/analyze`。
- Worker 在服务器端拿着你的 `GEMINI_API_KEY` 去调用 Gemini，再把结果返回网页。
- 所以 **API key 只存在 Cloudflare 后台**，前端代码里没有 key，安全。

一句话：**一个 Worker 同时负责“发网页”和“调 Gemini”**。

---

## 1. 先准备 3 个账号 / key

1. Cloudflare 账号（免费即可）。
2. GitHub 账号（用来放代码，让 Cloudflare 自动部署）。
3. 在 Google AI Studio 申请一个 **Gemini API key**，记下来备用。

---

## 2. 项目里的文件（哪些要上传）

**必须上传到 GitHub：**

| 文件 | 作用 |
|------|------|
| `wrangler.toml` | Cloudflare 部署配置（告诉它入口和静态目录） |
| `cloudflare-worker.js` | Worker 后端，提供 `/api/analyze` |
| `public/index.html` | **真正会被发布的网页**（线上看到的是这个） |
| `simulation.py` | 模拟脚本（论文用，可留） |
| `gemini_backend_plan.md` | 设计说明（可留） |
| `DEPLOY.md` | 本说明 |

**不要上传：**

- `2. Final Thesis Hardbound B5 - MSKK JKMP.docx`（论文，跟部署无关）
- `chrome-profile-final/`、`chrome-check-profile/`（浏览器缓存）
- 任何 `*.png` 测试截图

> ⚠️ 关于根目录的 `index.html`：
> 线上真正生效的是 **`public/index.html`**，不是根目录那个。
> 如果你平时在根目录的 `index.html` 改东西，改完一定要把它**复制覆盖到 `public/index.html`**，否则线上看到的还是旧版。
> （建议：以后只维护 `public/index.html` 这一份，免得两边不一致。）

---

## 3. 把项目上传到 GitHub

1. 新建一个 GitHub 仓库，例如 `tile-ai-estimator`。
2. 把上面“必须上传”的文件都 commit + push 进去。
3. **打开 GitHub 网页确认**：你能在仓库页面亲眼看到 `wrangler.toml` 和 `public/index.html` 这两个文件。
   - 看不到 = 没传成功，后面一定失败。这一步最关键。

---

## 4. 在 Cloudflare 建 Worker 并连接 GitHub

1. 打开 Cloudflare Dashboard → 左侧 **Workers & Pages**。
2. 点 **Create application**。
3. 选 **Workers**（**不要选 Pages**）。
4. 选择 **从 GitHub 导入 / Connect to Git**，连接你刚才的仓库。
5. 在构建设置里填：

   ```text
   Deploy command   : npx wrangler deploy
   Build command    : 留空
   Root directory   : 留空（因为 wrangler.toml 就在仓库根目录）
   Output directory : 留空（Worker 方案不需要它，这是 Pages 才用的）
   ```

6. 保存并部署。成功后会得到一个网址，例如：

   ```text
   https://tile-ai-estimator.<你的账号名>.workers.dev
   ```

   这个 `https://...workers.dev` 网址，**别的电脑就能打开了**。

---

## 5. 添加 Gemini API key（关键，否则 AI 不工作）

1. 进入这个 Worker 项目。
2. 打开 **Settings → Variables and Secrets**。
3. 添加一个 **Secret**（不是普通变量）：

   ```text
   名称: GEMINI_API_KEY
   值  : 你的 Gemini API key
   ```

4. （可选）再加一个普通变量指定模型：

   ```text
   名称: GEMINI_MODEL
   值  : gemini-3.5-flash
   ```

   不加也行，代码默认就是 `gemini-3.5-flash`。

5. 保存后重新部署一次（让 secret 生效）。

---

## 6. 测试 AI 是否真的能用

1. 用别的设备打开 `https://...workers.dev` 网址。
2. 进入 **AI 流程** 页面。
3. **后端 URL 留空**——因为同一个 Worker 已经自带 `/api/analyze`。
4. 上传一张图片或 PDF 图纸。
5. 点 **Gemini 识别图纸**。
6. 成功会看到房间、面积、置信度。
7. 点 **导入人工复核**，结果进入“房间”页面继续修改和计算。

---

## 7. 部署失败 / 报错对照表

| 报错或现象 | 原因 | 解决 |
|------------|------|------|
| `Could not detect a directory containing static files` | 项目被建成了 **Pages**，或 Root directory 填错，Wrangler 找不到 `public/` | 确认是 **Worker** 不是 Pages；Root directory 留空；确认 `public/index.html` 已推到 GitHub |
| 部署成功但点识别报 `Missing GEMINI_API_KEY` | 没加 secret 或加完没重新部署 | 按第 5 步加 `GEMINI_API_KEY` 并重新部署 |
| 报 `Gemini request failed` / 404 | 模型名不对，或 key 无效 | 确认 `GEMINI_MODEL` 是 AI Studio 里真实可用的名字（如 `gemini-3.5-flash`），确认 key 没填错 |
| 配置文件解析失败 / wrangler 报错 | `npx wrangler` 拉到的版本太旧，不认 `run_worker_first` 数组写法 | 用较新版 Wrangler；必要时加 `package.json` 钉住版本 |
| 线上网页是旧版 | 只改了根目录 `index.html`，没同步到 `public/index.html` | 把改动复制进 `public/index.html` 再 push |

---

## 8. 重要提醒

- **绝不**把 Gemini API key 写进 `index.html` 或任何前端代码。
- 网页地址如果还是 `file:///C:/...`，那只是你本地文件，别人打不开，AI 也不会真正工作——必须用 `https://...workers.dev`。
- 上传 DWG/DXF/IFC/RVT/SKP 这类 CAD/模型文件，Gemini 不能直接读，必须先转成 PDF 或 PNG。
- **PDF、PNG、JPG、WEBP、HEIC/HEIF** 最适合直接送 Gemini。
- AI 识别结果**必须人工复核**，尤其是：比例尺不清、尺寸模糊、户外/雨天、复杂铺法、柱位和湿区。

---

## 附：以后想做更专业的架构（不急，可跳过）

如果论文后期要做完整产品，可以演进成：

- 前端：Cloudflare Pages / Vercel / Netlify
- 后端：FastAPI 或 Node.js
- AI：Gemini API
- 文件转换：LibreOffice / CAD 转换器 / PDF 栅格化
- 数据库：Supabase / Firebase / PostgreSQL
- 存储：Cloudflare R2 / Google Cloud Storage

这样可以支持登录账号、保存多个项目、上传大图纸、CAD 转 PDF/PNG、真实用户测试记录、后台导出研究数据。
