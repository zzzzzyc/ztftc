# TFTC.top API MVP

一个基于 [tftc.top](https://tftc.top) 第三方聚合数据的中国 Geocaching 可视化 / 查询 MVP，**仅供技术学习**。

> ⚠️ **免责声明**：tftc.top 是非官方第三方数据聚合服务，与 Geocaching HQ 无关。本仓库通过其公开接口和 CDN 下载数据，请勿用于商业用途或大规模爬取。

## 包含三个组件

```
┌──────────────────────────────────────────────────────────┐
│                    Web 地图 (index.html)                  │
└────────────────┬───────────────────┬─────────────────────┘
                 │ 直连模式            │ 后端代理模式
                 ▼                   ▼
       ┌────────────────────┐  ┌──────────────────────┐
       │ tftc.top + 搜狐 CDN  │  │ FastAPI 后端 server.py │
       └────────────────────┘  └──────┬───────────────┘
                                       │
                          ┌────────────┼─────────────┐
                          ▼            ▼             ▼
                       TFTC      Opencaching.de    其它 OC
                                  (OCAPI)         站点
```



### 1. Web 地图 (`index.html` + `app.js`)

零依赖（仅 CDN 引入 Leaflet），双击 `index.html` 即可在浏览器中运行。

**特性**：
- **Material Design 3 视觉语言** — Roboto 字体、Material Symbols 图标、token 化的色彩系统、Surface elevation、状态层、Snackbar 通知
- **亮/暗主题切换** — 完整的 light/dark token 集，跟随 `prefers-color-scheme` 默认，localStorage 持久化，切换时自动联动 Carto 底图明暗
- 在地图上展示中国境内所有藏点（带聚类）
- **两种显示模式**：聚类图标（带类型字母）/ 固定大小小点（canvas 渲染，10k+ 点流畅）
- **8 种底图任意切换**：
  - WGS-84：Carto 暗色/亮色、OSM、Esri 卫星、Esri 地形
  - GCJ-02（国内）：高德矢量、高德卫星、腾讯
  - 切到 GCJ-02 底图时自动对 marker 做火星坐标加偏（**修正 50~500m 偏移**）
- 切换不同 API 端点：最新发布 / 今日找到 / 活动 / FTF / 全量
- 按类型筛选、按 GC 编号搜索
- 浏览器原生 `DecompressionStream` 解压 gzip 数据包
- **IndexedDB 智能缓存**：全量数据 1 小时 TTL、其它端点 5 分钟，省流量也提速
- 切换端点/筛选/视图模式/底图 → **自动应用**，无需手动点加载
- "🔄 刷新" 强制跳缓存重拉，"🗑️ 清缓存" 一键清空
- 一键导出 JSON

**运行方式**：
```bash
# 方式一：直接打开（部分浏览器对 file:// + fetch CORS 有限制）
start index.html

# 方式二：本地起一个静态服务器（推荐）
python -m http.server 8000
# 然后访问 http://localhost:8000/
```

### 2. FastAPI 后端 (`server.py`) — 可选但强烈推荐

解决 `file://`、隐私模式、IndexedDB 配额等场景下浏览器端缓存失效的问题，并集成 **OCAPI 多站点**。

需要 Python 3.9+。**一站式启动**（后端同时托管前端静态文件）：

```bash
pip install -r requirements.txt
python server.py
# 直接访问 http://localhost:8000/  ← 前端 + 后端都跑起来了
# 顶栏 UNOFFICIAL 徽章会自动变成橙色的 BACKEND
```

配 OCAPI key 后启动（Windows PowerShell）：
```bash
$env:OCAPI_OCDE_KEY = "your_consumer_key"
python server.py
```

> **如果在国内 / 使用代理** —— 浏览器能访问 ≠ Python 也能访问。Python httpx **不读 Windows 系统代理**，需要通过环境变量传：
> ```powershell
> $env:HTTPS_PROXY = "http://127.0.0.1:7890"   # 改成你 Clash/v2ray 的端口
> $env:HTTP_PROXY  = "http://127.0.0.1:7890"
> python server.py
> ```
> 启动横幅里会回显当前的 `HTTP 代理` 状态。如果显示"未设置"且 `/api/tftc/dump` 报 `ConnectError`，就是这个原因。

也可以把前端单独部署到任意 host，再通过 URL 参数指向后端：
```
http://localhost:8080/index.html?api=http://localhost:8000
```

**后端 API**：

| URL | 功能 | 缓存 |
|-----|------|------|
| `GET /api/tftc/dump` | 全量数据 (JSON, 已解压) | 1h |
| `GET /api/tftc/by-{published\|found\|event\|today\|ftf}` | TFTC 各端点透传 | 5min |
| `GET /api/oc/bbox?site=ocde&bbox=lat1,lng1,lat2,lng2&limit=500` | OCAPI bbox 搜索 | 10min |
| `GET /api/oc/code?site=ocde&code=OCXXXX` | OCAPI 单点查询 | — |
| `GET /api/all?bbox=...` | TFTC + 所有已配 OCAPI 站点聚合 | — |
| `GET /api/cache/info` | 查看服务端缓存状态 | — |
| `DELETE /api/cache` | 清空服务端缓存 | — |

**关于 OCAPI**：

OC 系列（[opencaching.de](https://www.opencaching.de) / [.us](https://www.opencaching.us) / [.pl](https://opencaching.pl) / [.nl](https://www.opencaching.nl) / [.ro](https://www.opencaching.ro)）有公开的 [OKAPI 协议](https://www.opencaching.de/okapi/)。

申请流程（免费、人工审核 1~2 天）：
1. 注册账号
2. 提交 [signup 表单](https://www.opencaching.de/okapi/signup.html) 描述用途
3. 拿到 `consumer_key`，写入对应环境变量：`OCAPI_OCDE_KEY` / `OCAPI_OCUS_KEY` / ...

> 关于北京 OC 藏点：opencaching 系列在中国境内的藏点确实极少（DE 站搜北京只有几个），可以试试 `bbox=39.7,116.0,40.2,116.7`。OC 和 GC.com 是**完全独立**的两套发布平台，藏点不会互通。

### 3. Python CLI (`tftc_cli.py`)

无第三方依赖，**仅使用标准库**（`urllib` + `gzip` + `json`）。需要 Python 3.10+。

```bash
python tftc_cli.py recent              # 最近发布
python tftc_cli.py ftf                 # FTF 机会
python tftc_cli.py event               # 当前活动
python tftc_cli.py code GC12345        # 按编号查询
python tftc_cli.py dump -o caches.json # 下载全量数据并保存
python tftc_cli.py stats               # 全量数据统计 (类型分布 / 顶级 owner / 高收藏)
```

示例输出：
```
$ python tftc_cli.py stats

  尝试 https://kevinaudio.bjcnc.scs.sohucs.com/geocaches_2026-04-25_15.gz ...

全量数据: 12,345 条藏点

=== 类型分布 ===
  Traditional    8,543  ████████████████████████████████████████
  Mystery        1,892  ████████
  Multi-Cache      876  ████
  Earthcache       234  █
  ...

=== Top 10 Owner ===
   234  some_geocacher
   189  another_one
  ...
```

## API 端点速查

| URL | 用途 |
|-----|------|
| `GET https://tftc.top/apiv2/caches/by-published` | 最近发布 |
| `GET https://tftc.top/apiv2/caches/by-found` | 今日找到 |
| `GET https://tftc.top/apiv2/caches/by-event` | 活动 |
| `GET https://tftc.top/apiv2/caches/by-today` | 历史上的今天 |
| `GET https://tftc.top/apiv2/caches/by-ftf` | 还没人 FTF 的 |
| `GET https://tftc.top/apiv2/caches/all?code=GCxxxx` | 按编号查询 |
| `GET https://kevinaudio.bjcnc.scs.sohucs.com/geocaches_YYYY-MM-DD_HH.gz` | 按小时切片的全量 gzip 数据 |

## 数据结构

```jsonc
{
  "code": "GC12345",
  "name": "某藏点",
  "latitude": 31.23,
  "longitude": 121.47,
  "geocacheType": 2,        // 见 CACHE_TYPES 映射
  "containerType": 3,
  "difficulty": 2.0,
  "terrain": 1.5,
  "placedDate": "2024-...",
  "lastFoundDate": "2026-...",
  "ownerUsername": "...",
  "favoritePoints": 123,
  "h3": "8a2a..."           // H3 索引（服务端预计算，分辨率 9 左右）
}
```

## 文件结构

```
tftc-mvp/
├── index.html         # Web 地图入口
├── app.js             # 前端逻辑（Leaflet + Cluster + DecompressionStream + IDB cache）
├── server.py          # FastAPI 后端（TFTC 代理 + OCAPI 集成 + 多源聚合）
├── requirements.txt   # 后端依赖
├── tftc_cli.py        # Python CLI
└── README.md
```

## 技术要点

- **gzip 解压**：浏览器端使用原生 [`DecompressionStream("gzip")`](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream)（Chrome 80+ / FF 113+ / Safari 16.4+），无需 pako。
- **失败回退**：CDN 文件按当前 UTC 小时命名，刚到整点时可能还没生成新包，所以代码会自动回退最近 6 小时。
- **聚类**：使用 Leaflet.markercluster 处理上万个点，渲染流畅。
- **canvas 渲染**：`L.canvas()` + `circleMarker` 让 10k+ 点的"小点模式"也能流畅平移。
- **WGS-84 → GCJ-02 加偏**：内置火星坐标转换算法。WGS-84 是 GPS/Geocaching 的真实坐标；国内（高德、腾讯、百度）的电子地图依法律要求使用 GCJ-02 加密坐标，两者直接叠加偏移 **50~500 米不等**。本项目把数据保留为 WGS-84，仅在渲染到 GCJ-02 底图时做一次性投影，popup 里仍显示原始 WGS-84 供 GPS 设备使用。
- **IndexedDB 缓存**：键值存储，简单的 `{ ts, data }` 结构，不同 endpoint 不同 TTL。
- **Python CLI 零依赖**：故意只用标准库，方便复制即用。

## 扩展想法

- [x] ~~OCAPI 适配~~ ✅ 已在后端 `server.py` 实现，需要自己申请 consumer key
- [ ] 前端 UI 加一个 OCAPI bbox 触发按钮（"在当前视野查 OC 藏点"）
- [ ] 在地图上叠加 H3 网格，点击显示该格子内所有 cache
- [ ] FTF 监控 daemon (CLI `--watch` 模式)
- [ ] 导出 GPX 格式
- [ ] 按省/市切片下载（结合 H3 父级）
- [ ] 用 SQLite 本地缓存，做增量同步
- [ ] PWA / Service Worker，断网也能查

## License

MIT — 但请尊重 tftc.top 的服务，不要刷接口。
