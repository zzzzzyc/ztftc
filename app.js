/* TFTC.top API MVP
 * 数据来源：https://tftc.top（非官方第三方聚合数据）
 * 仅供技术学习
 *
 * 模式:
 *   1) 直连模式 (默认): 浏览器直接 fetch tftc.top + 搜狐云 CDN
 *   2) 后端代理模式: 通过 ?api=http://localhost:8000 切换
 *      - 服务端缓存 (不再依赖 IndexedDB)
 *      - 支持 OCAPI 多站点 (需在后端配置 key)
 *      - 解决浏览器 file:// / 隐私模式 / 配额等场景下的缓存丢失
 */

const _params = new URLSearchParams(location.search);
// 优先级: ?api=... 参数 > server.py 注入的 window.__BACKEND__ > 直连模式
const BACKEND = _params.get("api") || window.__BACKEND__ || null;

const API_BASE = BACKEND ? `${BACKEND}/api/tftc` : "https://tftc.top/apiv2/caches";
const CDN_BASE = "https://kevinaudio.bjcnc.scs.sohucs.com";

const ENDPOINTS = {
  "by-published": `${API_BASE}/by-published`,
  "by-found":     `${API_BASE}/by-found`,
  "by-event":     `${API_BASE}/by-event`,
  "by-today":     `${API_BASE}/by-today`,
  "by-ftf":       `${API_BASE}/by-ftf`,
};

if (BACKEND) console.log(`[mode] backend proxy: ${BACKEND}`);

const CACHE_TYPES = {
  2:   { name: "Traditional", color: "#2db82d", letter: "T" },
  3:   { name: "Multi-Cache", color: "#f0a500", letter: "M" },
  4:   { name: "Virtual",     color: "#7c4dff", letter: "V" },
  5:   { name: "Letterbox",   color: "#1976d2", letter: "L" },
  6:   { name: "Event",       color: "#e91e63", letter: "E" },
  8:   { name: "Mystery",     color: "#3f51b5", letter: "?" },
  11:  { name: "Webcam",      color: "#00acc1", letter: "W" },
  13:  { name: "CITO",        color: "#558b2f", letter: "C" },
  137: { name: "Earthcache",  color: "#795548", letter: "Ⓔ" },
  453: { name: "Mega-Event",  color: "#d81b60", letter: "★" },
  3653:{ name: "Lab",         color: "#00bfa5", letter: "🧪"},
};

const cacheTypeInfo = (t) => CACHE_TYPES[t] || { name: `Type ${t}`, color: "#888", letter: "?" };

// dots 模式: 地图上固定「地面半径」（米）, 屏幕上的像素会随 zoom 变大变小。
// L.circleMarker 是屏幕像素半径; L.circle 才是米。
const DOT_RADIUS_METERS = 100;

/* ---------------- 坐标系转换 (WGS-84 → GCJ-02) ---------------- */
// Geocaching 数据是 WGS-84。叠加到国内 GCJ-02 底图（高德/腾讯）上时
// 必须做火星坐标加偏，否则 marker 会偏 50~500 米。
// 算法来自公开的 GCJ-02 加密论文，全网通用实现。

const GCJ_A  = 6378245.0;            // 长半轴
const GCJ_EE = 0.00669342162296594323; // 第一偏心率平方

function _transformLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return r;
}
function _transformLng(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return r;
}
function _outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

/** WGS-84 → GCJ-02 */
function wgs84ToGcj02(lat, lng) {
  if (_outOfChina(lng, lat)) return [lat, lng];
  let dLat = _transformLat(lng - 105.0, lat - 35.0);
  let dLng = _transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqMagic) * Math.PI);
  dLng = (dLng * 180.0) / (GCJ_A / sqMagic * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}

/* ---------------- 底图配置 ---------------- */

const BASEMAPS = {
  carto_dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    options: { subdomains: "abcd", maxZoom: 19, attribution: "&copy; OSM &copy; CARTO" },
    crs: "wgs84",
  },
  carto_light: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    options: { subdomains: "abcd", maxZoom: 19, attribution: "&copy; OSM &copy; CARTO" },
    crs: "wgs84",
  },
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: { subdomains: "abc", maxZoom: 19, attribution: "&copy; OpenStreetMap" },
    crs: "wgs84",
  },
  esri_sat: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: { maxZoom: 19, attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, etc." },
    crs: "wgs84",
  },
  esri_topo: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    options: { maxZoom: 19, attribution: "Tiles &copy; Esri" },
    crs: "wgs84",
  },
  amap: {
    url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
    options: { subdomains: "1234", maxZoom: 18, attribution: "&copy; 高德地图" },
    crs: "gcj02",
  },
  amap_sat: {
    url: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
    options: { subdomains: "1234", maxZoom: 18, attribution: "&copy; 高德地图" },
    crs: "gcj02",
  },
  tencent: {
    url: "https://rt{s}.map.gtimg.com/realtimerender?z={z}&x={x}&y={-y}&type=vector&style=0",
    options: { subdomains: "0123", maxZoom: 18, attribution: "&copy; 腾讯地图" },
    crs: "gcj02",
  },
};

// 缓存 TTL（毫秒）
const CACHE_TTL = {
  dump: 60 * 60 * 1000,   // 全量数据 1 小时（CDN 也是按小时刷的）
  default: 5 * 60 * 1000, // 其它端点 5 分钟
};
// true: 非 dump 端点优先由 dump 本地派生，减少额外网络请求
const PREFER_DERIVED_FROM_DUMP = true;

let allCaches = [];
let map, clusterGroup, dotsLayer, canvasRenderer;
let viewMode = "cluster";
let lastCacheMeta = null; // { key, ts, fromCache }
let currentBasemap = "carto_dark";
let currentTileLayer = null;

function setBasemap(key) {
  const def = BASEMAPS[key];
  if (!def) return;
  if (currentTileLayer) map.removeLayer(currentTileLayer);
  currentTileLayer = L.tileLayer(def.url, def.options).addTo(map);
  // 让底图始终在 marker 之下
  currentTileLayer.bringToBack?.();
  const prevCrs = BASEMAPS[currentBasemap]?.crs;
  currentBasemap = key;
  // 只有切换坐标系时才需要重渲染 marker
  if (prevCrs !== def.crs && allCaches.length) render(allCaches);
}

function currentCrs() {
  return BASEMAPS[currentBasemap]?.crs || "wgs84";
}

/** 把 WGS-84 数据点转换成当前底图坐标系下的 LatLng */
function projectToBasemap(c) {
  if (currentCrs() === "gcj02") return wgs84ToGcj02(c.latitude, c.longitude);
  return [c.latitude, c.longitude];
}

function initMap() {
  map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([35.0, 105.0], 4);

  setBasemap(currentBasemap);

  clusterGroup = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 50,
  });

  // Canvas renderer makes circleMarker very fast even with 10k+ points.
  canvasRenderer = L.canvas({ padding: 0.5 });
  dotsLayer = L.layerGroup();

  map.addLayer(clusterGroup);
}

function makeIcon(type) {
  const info = cacheTypeInfo(type);
  return L.divIcon({
    className: "cache-marker",
    html: `<div class="cache-icon" style="background:${info.color}">${info.letter}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

/* ---------------- Snackbar ---------------- */

function showSnackbar(message, { type = "info", duration = 4000, action } = {}) {
  const host = document.getElementById("snackbar-host");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `snackbar is-${type}`;

  const icon = type === "error" ? "error" : type === "success" ? "check_circle" : "info";
  el.innerHTML = `
    <span class="material-symbols-outlined icon-md">${icon}</span>
    <span style="flex:1">${message}</span>
  `;
  if (action) {
    const btn = document.createElement("button");
    btn.className = "md-btn md-btn--text";
    btn.style.cssText = "height:32px;padding:0 12px;color:inherit;";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      action.onClick?.();
      dismiss();
    });
    el.appendChild(btn);
  }
  host.appendChild(el);

  let timer;
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add("is-leaving");
    clearTimeout(timer);
    setTimeout(() => el.remove(), 220);
  };
  timer = setTimeout(dismiss, duration);
  el.addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") dismiss();
  });
}

function fmtDate(s) {
  if (!s) return "-";
  try { return new Date(s).toLocaleDateString("zh-CN"); }
  catch { return s; }
}

function makePopup(c) {
  const info = cacheTypeInfo(c.geocacheType);
  return `
    <div class="cache-popup">
      <div><span class="code">${c.code}</span></div>
      <div class="name">${c.name || "(no name)"}</div>
      <div class="meta">
        <b style="color:${info.color}">●</b> <b>${info.name}</b> · D${c.difficulty}/T${c.terrain}<br>
        Owner: <b>${c.ownerUsername || "?"}</b><br>
        发布: ${fmtDate(c.placedDate)}<br>
        ${c.lastFoundDate ? `上次找到: ${fmtDate(c.lastFoundDate)}<br>` : ""}
        ${c.favoritePoints != null ? `❤ ${c.favoritePoints} 收藏<br>` : ""}
        WGS-84: ${c.latitude?.toFixed(5)}, ${c.longitude?.toFixed(5)}
      </div>
      <div class="links">
        <a href="https://www.geocaching.com/geocache/${c.code}" target="_blank" rel="noopener">
          <span class="material-symbols-outlined" style="font-size:14px">open_in_new</span>官方
        </a>
        <a href="https://coord.info/${c.code}" target="_blank" rel="noopener">
          <span class="material-symbols-outlined" style="font-size:14px">link</span>短链
        </a>
        <a href="https://www.geocaching.com/p/?u=${encodeURIComponent(c.ownerUsername || "")}" target="_blank" rel="noopener">
          <span class="material-symbols-outlined" style="font-size:14px">person</span>Owner
        </a>
      </div>
    </div>
  `;
}

function setLoading(on, text = "正在拉取数据...") {
  document.getElementById("loading-text").textContent = text;
  document.getElementById("loading").classList.toggle("active", on);
  const fab = document.getElementById("btn-load");
  if (fab) fab.classList.toggle("is-loading", on);
}

/* ---------------- IndexedDB 缓存层 ---------------- */

const CACHE_DB_NAME = "tftc-cache";
const CACHE_STORE = "kv";
let _dbPromise = null;

function openCacheDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(CACHE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function cacheGet(key) {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readonly");
      const req = tx.objectStore(CACHE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("cacheGet failed:", e);
    return null;
  }
}

async function cacheSet(key, value) {
  try {
    const db = await openCacheDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort  = () => reject(tx.error || new Error("transaction aborted"));
    });
  } catch (e) {
    console.warn("[cache] write failed for", key, e);
    // 配额超出 / 隐私模式等场景显式提示
    if (e?.name === "QuotaExceededError") {
      showSnackbar?.("浏览器存储配额不足，缓存写入失败", { type: "error" });
    }
  }
}

async function cacheClear() {
  try {
    const db = await openCacheDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("cacheClear failed:", e);
  }
}

async function withCache(key, ttl, fetcher, force = false) {
  if (!force) {
    const entry = await cacheGet(key);
    if (entry && Date.now() - entry.ts < ttl) {
      console.log(
        `[cache hit] ${key}  age=${Math.round((Date.now() - entry.ts) / 1000)}s  size=${entry.data?.length ?? "?"}`
      );
      return { data: entry.data, ts: entry.ts, fromCache: true };
    }
  }
  const data = await fetcher();
  const ts = Date.now();
  await cacheSet(key, { ts, data });
  return { data, ts, fromCache: false };
}

/* ---------------- API ---------------- */

async function fetchEndpoint(key) {
  const r = await fetch(ENDPOINTS[key]);
  if (!r.ok) throw new Error(`API ${r.status}: ${r.statusText}`);
  return r.json();
}

function toDateSafe(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function md(d) {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isEpoch1970Date(s) {
  if (!s) return false;
  const raw = String(s);
  if (raw.startsWith("1970-01-01")) return true;
  const d = toDateSafe(s);
  return !!(d && d.getUTCFullYear() === 1970 && d.getUTCMonth() === 0 && d.getUTCDate() === 1);
}

function deriveFromDump(dumpData, key) {
  const list = Array.isArray(dumpData) ? dumpData : [];
  const now = new Date();
  const todayYmd = ymd(now);
  const todayMd = md(now);
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 3600 * 1000);

  switch (key) {
    case "by-published":
      return [...list]
        .filter((c) => {
          const d = toDateSafe(c.placedDate);
          return d && d >= tenDaysAgo && d <= now;
        })
        .sort((a, b) => new Date(b.placedDate) - new Date(a.placedDate))
        .slice(0, 3000);
    case "by-event":
      // 即将举办活动：活动类 + lastFoundDate 为 1970-01-01（未开始）
      return list.filter((c) => [6, 13, 453].includes(Number(c.geocacheType)) && isEpoch1970Date(c.lastFoundDate));
    case "by-found":
      return list.filter((c) => {
        const d = toDateSafe(c.lastFoundDate);
        return d ? ymd(d) === todayYmd : false;
      });
    case "by-today":
      return list.filter((c) => {
        const d = toDateSafe(c.placedDate);
        return d ? md(d) === todayMd : false;
      });
    case "by-ftf":
      // FTF 机会：按你的数据特征，lastFoundDate=1970-01-01 视为尚未找到
      return list.filter((c) => isEpoch1970Date(c.lastFoundDate));
    default:
      return list;
  }
}

function pad(n) { return String(n).padStart(2, "0"); }

function gzUrlForOffset(offsetHours) {
  const t = new Date(Date.now() - offsetHours * 3600 * 1000);
  return `${CDN_BASE}/geocaches_${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}_${pad(t.getHours())}.gz`;
}

async function decompressGzipBytes(buf) {
  const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

/** 拉取最新可用 gzip 包，返回 { data, gzip, url } */
async function fetchFullDump() {
  for (let offset = 0; offset < 6; offset++) {
    const url = gzUrlForOffset(offset);
    setLoading(true, `尝试 ${offset === 0 ? "当前" : `${offset}h 前`} 的数据包...`);
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      setLoading(true, "下载中...");
      const gzip = await res.arrayBuffer();
      setLoading(true, "解压 gzip...");
      const data = await decompressGzipBytes(gzip);
      console.log(`[network] 从 ${url} 加载了 ${data.length} 条 (gzip ${(gzip.byteLength/1024).toFixed(1)}KB)`);
      return { data, gzip, url };
    } catch (e) {
      console.warn(`[FAIL] ${url}:`, e);
    }
  }
  throw new Error("所有最近 6 小时的数据包都拉取失败");
}

function applyFilters(data) {
  const typeFilter = document.getElementById("filter-type").value;
  const search = document.getElementById("search").value.trim().toUpperCase();

  return data.filter((c) => {
    if (typeFilter && String(c.geocacheType) !== typeFilter) return false;
    if (search && !(c.code || "").toUpperCase().includes(search)) return false;
    if (typeof c.latitude !== "number" || typeof c.longitude !== "number") return false;
    return true;
  });
}

function render(data) {
  clusterGroup.clearLayers();
  dotsLayer.clearLayers();

  const filtered = applyFilters(data);

  if (viewMode === "cluster") {
    if (!map.hasLayer(clusterGroup)) map.addLayer(clusterGroup);
    if (map.hasLayer(dotsLayer)) map.removeLayer(dotsLayer);

    const markers = filtered.map((c) => {
      const m = L.marker(projectToBasemap(c), { icon: makeIcon(c.geocacheType) });
      m.bindPopup(() => makePopup(c));
      m.on("click", () => highlightInList(c.code));
      return m;
    });
    clusterGroup.addLayers(markers);
  } else {
    if (map.hasLayer(clusterGroup)) map.removeLayer(clusterGroup);
    if (!map.hasLayer(dotsLayer)) map.addLayer(dotsLayer);

    for (const c of filtered) {
      const info = cacheTypeInfo(c.geocacheType);
      const dot = L.circle(projectToBasemap(c), {
        renderer: canvasRenderer,
        radius: DOT_RADIUS_METERS,
        color: info.color,
        weight: 1,
        fillColor: info.color,
        fillOpacity: 0.9,
      });
      dot.bindPopup(() => makePopup(c));
      dot.on("click", () => highlightInList(c.code));
      dotsLayer.addLayer(dot);
    }
  }

  document.getElementById("total").textContent = data.length.toLocaleString();
  document.getElementById("visible").textContent = filtered.length.toLocaleString();

  renderList(filtered.slice(0, 200));

  if (filtered.length > 0 && filtered.length < data.length) {
    const points = filtered.map(projectToBasemap);
    const lats = points.map(p => p[0]);
    const lngs = points.map(p => p[1]);
    map.fitBounds([
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)],
    ], { padding: [40, 40], maxZoom: 12 });
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderList(items) {
  const list = document.getElementById("panel-list");
  document.getElementById("panel-count").textContent =
    items.length >= 200 ? "前 200 条" : `${items.length} 条`;

  list.innerHTML = items.map((c) => {
    const info = cacheTypeInfo(c.geocacheType);
    return `
      <div class="cache-item" data-code="${c.code}" data-lat="${c.latitude}" data-lng="${c.longitude}">
        <div class="cache-item__avatar" style="background:${info.color}">${info.letter}</div>
        <div class="cache-item__body">
          <div class="cache-item__row1">
            <span class="cache-item__code">${escapeHtml(c.code)}</span>
            <span class="cache-item__date">${fmtDate(c.placedDate)}</span>
          </div>
          <div class="cache-item__name" title="${escapeHtml(c.name)}">${escapeHtml(c.name) || "(no name)"}</div>
          <div class="cache-item__meta">
            ${escapeHtml(info.name)} · D${c.difficulty}/T${c.terrain} · ${escapeHtml(c.ownerUsername || "?")}
          </div>
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".cache-item").forEach((el) => {
    el.addEventListener("click", () => {
      const lat = parseFloat(el.dataset.lat);
      const lng = parseFloat(el.dataset.lng);
      const target = currentCrs() === "gcj02" ? wgs84ToGcj02(lat, lng) : [lat, lng];
      map.setView(target, 14);
      highlightInList(el.dataset.code);
    });
  });
}

function highlightInList(code) {
  document.querySelectorAll(".cache-item").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.code === code);
  });
  // 自动滚动到激活项
  const active = document.querySelector(".cache-item.is-active");
  if (active) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return `${h} 小时前`;
}

function updateCacheBadge() {
  const el = document.getElementById("cache-badge");
  if (!el) return;
  if (!lastCacheMeta) {
    el.textContent = "";
    el.title = "";
    return;
  }
  const age = Date.now() - lastCacheMeta.ts;
  const tag = lastCacheMeta.fromCache ? "💾" : "🌐";
  el.textContent = `${tag} ${fmtAge(age)}`;
  el.title = lastCacheMeta.fromCache
    ? `命中本地缓存 (${new Date(lastCacheMeta.ts).toLocaleTimeString()})\n点击「刷新」强制重新拉取`
    : `刚从网络拉取 (${new Date(lastCacheMeta.ts).toLocaleTimeString()})`;
}

// 每秒刷新一下"几秒/分钟前"
setInterval(updateCacheBadge, 1000);

/**
 * 统一加载入口。
 * - dump 端点：缓存原始 gzip ArrayBuffer (~1-3 MB)，命中后浏览器端解压
 *   比缓存解析后的 JSON (~10-30 MB) 节省 5~10 倍空间，IndexedDB 写入也快很多
 * - 其它端点：直接缓存 JSON 数组（很小）
 */
async function loadEndpoint(key, force) {
  if (key === "dump") {
    // 后端代理模式: 直接拿 JSON, 服务端已经做过缓存了
    if (BACKEND) {
      return withCache(
        "endpoint:dump-backend",
        CACHE_TTL.dump,
        async () => {
          setLoading(true, "从后端拉取 dump...");
          const r = await fetch(`${BACKEND}/api/tftc/dump`);
          if (!r.ok) throw new Error(`后端 ${r.status}: ${r.statusText}`);
          return r.json();
        },
        force
      );
    }
    // 直连模式: 缓存 gzip 字节, 浏览器解压
    const CACHE_KEY = "dump:gzip";
    if (!force) {
      const entry = await cacheGet(CACHE_KEY);
      if (entry && Date.now() - entry.ts < CACHE_TTL.dump) {
        try {
          setLoading(true, "解压本地缓存...");
          const data = await decompressGzipBytes(entry.data);
          const sizeKB = (entry.data.byteLength / 1024).toFixed(0);
          console.log(`[cache hit] dump  age=${Math.round((Date.now()-entry.ts)/1000)}s  gzip=${sizeKB}KB`);
          return { data, ts: entry.ts, fromCache: true };
        } catch (e) {
          console.warn("[cache] decompression failed, falling back to network:", e);
        }
      }
    }
    const { data, gzip } = await fetchFullDump();
    const ts = Date.now();
    await cacheSet(CACHE_KEY, { ts, data: gzip });
    return { data, ts, fromCache: false };
  }
  // 非 dump 端点：优先由 dump 派生，避免每次都请求 TFTC 各子端点
  if (PREFER_DERIVED_FROM_DUMP) {
    try {
      const dumpResult = await loadEndpoint("dump", force);
      const derived = deriveFromDump(dumpResult.data, key);
      return { data: derived, ts: dumpResult.ts, fromCache: dumpResult.fromCache, source: "derived" };
    } catch (e) {
      console.warn(`[derive] ${key} 派生失败，回退网络端点:`, e);
    }
  }

  const net = await withCache(`endpoint:${key}`, CACHE_TTL.default, () => fetchEndpoint(key), force);
  return { ...net, source: "network" };
}

async function load(force = false) {
  const key = document.getElementById("endpoint").value;
  const btn = document.getElementById("btn-load");
  btn.disabled = true;
  setLoading(true, force ? "强制刷新中..." : "加载中...");

  try {
    const result = await loadEndpoint(key, force);
    allCaches = result.data;
    lastCacheMeta = { key, ts: result.ts, fromCache: result.fromCache };
    updateCacheBadge();
    render(allCaches);

    const n = result.data.length.toLocaleString();
    if (result.source === "derived") {
      showSnackbar(`🧮 已由全量数据本地派生：${n} 条`, { type: "info", duration: 2500 });
    } else if (force) {
      showSnackbar(`已强制刷新：${n} 条藏点`, { type: "success" });
    } else if (result.fromCache) {
      showSnackbar(
        `💾 命中缓存（${fmtAge(Date.now() - result.ts)}）：${n} 条藏点`,
        { type: "info", duration: 2500 }
      );
    } else {
      showSnackbar(`🌐 已从网络加载：${n} 条藏点`, { type: "info", duration: 2500 });
    }
  } catch (e) {
    showSnackbar(`加载失败：${e.message}`, { type: "error", duration: 6000 });
    console.error(e);
  } finally {
    btn.disabled = false;
    setLoading(false);
  }
}

function exportJson() {
  if (!allCaches.length) {
    showSnackbar("先加载数据再导出", { type: "error" });
    return;
  }
  const blob = new Blob([JSON.stringify(allCaches, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tftc-caches-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- Theme ---------------- */

const THEME_KEY = "tftc-theme";

function getCurrentTheme() {
  return document.documentElement.dataset.theme || "dark";
}

function applyTheme(theme, { autoSwitchBasemap = true } = {}) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const icon = document.getElementById("theme-icon");
  if (icon) icon.textContent = theme === "light" ? "dark_mode" : "light_mode";

  // 主题切换时联动底图：只在使用 Carto 暗/亮时自动切到对应款
  if (autoSwitchBasemap) {
    const sel = document.getElementById("basemap");
    if (theme === "light" && currentBasemap === "carto_dark") {
      sel.value = "carto_light";
      setBasemap("carto_light");
    } else if (theme === "dark" && currentBasemap === "carto_light") {
      sel.value = "carto_dark";
      setBasemap("carto_dark");
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // theme 已在 head 内联脚本里设了，这里只同步图标
  applyTheme(getCurrentTheme(), { autoSwitchBasemap: false });

  // 如果初始为亮色主题，默认底图改为 carto_light
  if (getCurrentTheme() === "light" && currentBasemap === "carto_dark") {
    currentBasemap = "carto_light";
    const sel = document.getElementById("basemap");
    if (sel) sel.value = "carto_light";
  }

  // 后端模式标识
  if (BACKEND) {
    const badge = document.querySelector(".app-bar__brand .badge");
    if (badge) {
      badge.textContent = "BACKEND";
      badge.style.background = "var(--md-tertiary)";
      badge.style.color = "var(--md-on-tertiary)";
      badge.title = `代理: ${BACKEND}`;
    }
  }

  initMap();

  // 端点切换 → 自动加载（用缓存）
  document.getElementById("endpoint").addEventListener("change", () => load(false));

  // 视图模式切换 → 仅重渲染（数据不变）
  document.getElementById("view-mode").addEventListener("change", (e) => {
    viewMode = e.target.value;
    if (allCaches.length) render(allCaches);
  });

  // 底图切换 → 换 tile, 必要时重投影 marker
  document.getElementById("basemap").addEventListener("change", (e) => {
    setBasemap(e.target.value);
  });

  // 类型筛选 / 搜索 → 仅重渲染
  document.getElementById("filter-type").addEventListener("change", () => render(allCaches));
  document.getElementById("search").addEventListener("input", () => {
    if (allCaches.length) render(allCaches);
  });

  // 「刷新」按钮 → 强制跳缓存
  document.getElementById("btn-load").addEventListener("click", () => load(true));

  // 「导出」按钮
  document.getElementById("btn-export").addEventListener("click", exportJson);

  // 「主题切换」按钮
  document.getElementById("btn-theme").addEventListener("click", () => {
    applyTheme(getCurrentTheme() === "light" ? "dark" : "light");
  });

  // 「清缓存」按钮
  const clearBtn = document.getElementById("btn-clear-cache");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      await cacheClear();
      lastCacheMeta = null;
      updateCacheBadge();
      showSnackbar("本地缓存已清空", { type: "success" });
    });
  }

  // 首次加载
  load(false);
});
