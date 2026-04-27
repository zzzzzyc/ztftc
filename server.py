"""
TFTC + OCAPI 统一后端代理
─────────────────────────

启动:
    pip install -r requirements.txt
    uvicorn server:app --reload --port 8000

或直接:
    python server.py

特性:
- 代理 TFTC.top API + 全量 gzip dump，**服务端内存缓存**（不依赖浏览器 IDB）
- OCAPI（Opencaching.de/.us/.pl/.nl）适配，统一归一化字段
- 启用 CORS，前端可直接 fetch
- 同一 bbox 多源聚合 (`/api/all?bbox=...`)

环境变量（可选）:
    OCAPI_OCDE_KEY=xxx  # opencaching.de consumer key
    OCAPI_OCUS_KEY=xxx  # opencaching.us
    OCAPI_OCPL_KEY=xxx  # opencaching.pl
    OCAPI_OCNL_KEY=xxx  # opencaching.nl

申请 OCAPI key:
    https://www.opencaching.de/okapi/signup.html
    https://www.opencaching.us/okapi/signup.html
    （免费、人工审核 1~2 天）
"""

import asyncio
import gzip
import json
import os
import pathlib
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

STATIC_DIR = pathlib.Path(__file__).parent


# ─────────────────────────────────────────────────────────────
# 配置
# ─────────────────────────────────────────────────────────────

TFTC_API = "https://tftc.top/apiv2"
TFTC_CDN = "https://kevinaudio.bjcnc.scs.sohucs.com"

TFTC_ENDPOINTS = {
    "by-published", "by-found", "by-event",
    "by-today", "by-ftf", "all",
}

OC_SITES = {
    "ocde": "https://www.opencaching.de/okapi/services",
    "ocus": "https://www.opencaching.us/okapi/services",
    "ocpl": "https://opencaching.pl/okapi/services",
    "ocnl": "https://www.opencaching.nl/okapi/services",
    "ocro": "https://www.opencaching.ro/okapi/services",
}
OC_FULL_CACHE_VERSION = "v3"

USER_AGENT = "tftc-mvp/0.3 (+https://github.com/tftc-mvp learning)"

# 按你的要求：直接硬编码 OC key（优先于环境变量回退）。
# 注：当前实现使用 Level 1 consumer_key；consumer_secret 暂未用到。
OC_HARDCODED_CREDENTIALS: Dict[str, Dict[str, str]] = {
    "ocde": {
        "consumer_key": "UZyAAMAbJ6Wzbu439ukK",
        "consumer_secret": "deQHZ5CdJCekE7z7vDxawReUvArtzLaZWrbWKrDy",
    },
    "ocpl": {
        "consumer_key": "xadenNBCVKVugTPr79Lw",
        "consumer_secret": "R9BwFQrNNjMn38uN245kS9VKMDMMwgBtSS3CaPrW",
    }
}


def _format_exc_chain(e: BaseException) -> str:
    """把 httpx 异常的链式根因展开, 比 str(e) 信息量大得多。"""
    parts: List[str] = []
    seen = set()
    cur: Optional[BaseException] = e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        msg = str(cur).strip() or repr(cur)
        parts.append(f"{type(cur).__name__}: {msg}")
        cur = cur.__cause__ or cur.__context__
    return "  ←  ".join(parts)


# ─────────────────────────────────────────────────────────────
# 简易内存缓存
# ─────────────────────────────────────────────────────────────

_cache: Dict[str, Tuple[float, Any]] = {}


def cache_get(key: str, ttl: float):
    item = _cache.get(key)
    if item and time.time() - item[0] < ttl:
        return item[1]
    return None


def cache_set(key: str, value: Any) -> None:
    _cache[key] = (time.time(), value)


# ─────────────────────────────────────────────────────────────
# FastAPI app
# ─────────────────────────────────────────────────────────────

app = FastAPI(
    title="TFTC + OCAPI Proxy",
    version="0.3.0",
    description="统一代理 TFTC.top + OCAPI 多站点 geocaching 数据",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def oc_key(site: str) -> Optional[str]:
    return (
        os.environ.get(f"OCAPI_{site.upper()}_KEY")
        or os.environ.get(f"OCAPI_{site.upper()}_CONSUMER_KEY")
        or (OC_HARDCODED_CREDENTIALS.get(site, {}).get("consumer_key"))
    )


# ─────────────────────────────────────────────────────────────
# Root / 静态文件 / 状态
# ─────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    """返回 index.html, 注入 window.__BACKEND__ 让前端自动走后端模式。"""
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    inject = '<script>window.__BACKEND__ = location.origin;</script>'
    if "</head>" in html:
        html = html.replace("</head>", inject + "</head>", 1)
    else:
        html = inject + html
    return HTMLResponse(html)


@app.get("/favicon.ico")
async def favicon():
    return Response(status_code=204)


@app.get("/api/info")
async def api_info():
    return {
        "name": "TFTC + OCAPI Proxy",
        "version": "0.3.0",
        "configured_oc_sites": [s for s in OC_SITES if oc_key(s)],
        "cache_size": len(_cache),
        "endpoints": {
            "TFTC": [f"/api/tftc/{e}" for e in TFTC_ENDPOINTS] + ["/api/tftc/dump"],
            "OCAPI": [
                "/api/oc/bbox?site=ocde&bbox=lat1,lng1,lat2,lng2",
                "/api/oc/full?site=ocde",
                "/api/oc/code?site=ocde&code=OCXXXX",
            ],
            "Aggregated": ["/api/all?bbox=lat1,lng1,lat2,lng2"],
        },
    }


# ─────────────────────────────────────────────────────────────
# TFTC 代理
# ─────────────────────────────────────────────────────────────

@app.get("/api/tftc/{endpoint}")
async def tftc_endpoint(endpoint: str):
    """代理 TFTC API endpoint, 服务端缓存 5 分钟。"""
    if endpoint == "dump":
        return await tftc_dump()
    if endpoint not in TFTC_ENDPOINTS:
        raise HTTPException(404, f"未知端点: {endpoint}")

    cached = cache_get(f"tftc:{endpoint}", ttl=300)
    if cached is not None:
        return cached

    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{TFTC_API}/caches/{endpoint}",
            headers={"User-Agent": USER_AGENT},
        )
        if r.status_code != 200:
            raise HTTPException(r.status_code, r.text)
        data = r.json()

    cache_set(f"tftc:{endpoint}", data)
    return data


@app.get("/api/tftc/dump")
async def tftc_dump():
    """全量 gzip dump, 服务端缓存 2 小时, 自动回退最近 6 小时。"""
    cached = cache_get("tftc:dump", ttl=7200)
    if cached is not None:
        return JSONResponse(cached, headers={"X-Cache": "HIT"})

    now = datetime.now(timezone.utc)
    attempts: List[str] = []

    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        for offset in range(6):
            t = now - timedelta(hours=offset)
            url = f"{TFTC_CDN}/geocaches_{t:%Y-%m-%d_%H}.gz"
            try:
                r = await client.get(url, headers={"User-Agent": USER_AGENT})
                if r.status_code == 200:
                    print(f"[dump] OK {url}  ({len(r.content)} bytes)")
                    data = json.loads(gzip.decompress(r.content))
                    cache_set("tftc:dump", data)
                    return JSONResponse(
                        data,
                        headers={"X-Cache": "MISS", "X-Source-Url": url},
                    )
                msg = f"  HTTP {r.status_code}  {url}"
                print(f"[dump] {msg.strip()}")
                attempts.append(msg)
            except Exception as e:
                msg = f"  {_format_exc_chain(e)}  ({url})"
                print(f"[dump] FAIL {msg.strip()}")
                attempts.append(msg)

    detail = (
        "全量 dump 不可用，所有 6 小时切片均失败:\n"
        + "\n".join(attempts)
        + "\n\n[hint] 大概率是代理问题。浏览器能访问 ≠ Python 也能访问。\n"
        + "  PowerShell 里设置代理后再启动 server.py:\n"
        + "      $env:HTTPS_PROXY = 'http://127.0.0.1:7890'   # 改成你的代理端口\n"
        + "      $env:HTTP_PROXY  = 'http://127.0.0.1:7890'\n"
        + "      python server.py"
    )
    print("[dump] 全部失败:\n" + detail)
    raise HTTPException(503, detail)


# ─────────────────────────────────────────────────────────────
# OCAPI 适配
# ─────────────────────────────────────────────────────────────

# OC 字符串类型 → 本项目内部 type id
# 兼容常见 OKAPI 类型 + 站点扩展类型（Drive-In / Own / Podcast）
OC_TYPE_MAP: Dict[str, int] = {
    "traditional": 2,
    "multi": 3,
    "virtual": 4,
    "event": 6,
    "other": 8,
    "quiz": 8,           # 对齐 Mystery
    "webcam": 11,
    "moving": 901,       # OC 特有
    "locationless": 902, # OC 特有
    "drivein": 903,      # OCDE 常见（car / park&grab）
    "own": 904,          # 部分站点
    "podcast": 905,      # 主要 OCUS
    "mathphysics": 8,
}


def _norm_type_key(v: Any) -> str:
    s = str(v or "").strip().lower()
    # 统一掉空格/连字符/斜杠，提升兼容性
    for ch in (" ", "-", "/", "_"):
        s = s.replace(ch, "")
    return s

# OC 容器枚举 → GC 数字（粗略对齐）
OC_CONTAINER_MAP: Dict[str, int] = {
    "Other": 1, "Micro": 2, "Small": 3,
    "Regular": 4, "Large": 5, "Very large": 6,
    "Nano": 2, "None": 1,
}


def _normalize_oc_cache(code: str, c: dict, site: str) -> Optional[dict]:
    """OCAPI 字段 → TFTC 兼容 schema。"""
    loc = c.get("location") or ""
    try:
        lat_s, lng_s = loc.split("|")
        lat, lng = float(lat_s), float(lng_s)
    except (ValueError, AttributeError):
        return None

    raw_type = c.get("type") or ""
    type_id = OC_TYPE_MAP.get(_norm_type_key(raw_type), 8)

    return {
        "code": code,
        "name": c.get("name") or "",
        "latitude": lat,
        "longitude": lng,
        "geocacheType": type_id,
        "containerType": OC_CONTAINER_MAP.get(c.get("size2") or "Other", 1),
        "difficulty": c.get("difficulty"),
        "terrain": c.get("terrain"),
        "ownerUsername": (c.get("owner") or {}).get("username"),
        "placedDate": c.get("date_hidden"),
        "lastFoundDate": c.get("last_found"),
        "favoritePoints": c.get("recommendations") or 0,
        "_source": site,           # 自定义字段, 前端可据此着色
        "_status": c.get("status"),
        "_url": c.get("url"),
        "_ocRawType": raw_type,
        "_ocTypeNorm": _norm_type_key(raw_type),
    }


@app.get("/api/oc/bbox")
async def oc_bbox(
    site: str = Query("ocde", description="ocde / ocus / ocpl / ocnl / ocro"),
    bbox: str = Query(..., description="south,west,north,east  例: 39.7,116.0,40.2,116.7"),
    limit: int = Query(500, ge=1, le=500),
):
    """OCAPI bbox 查询。返回归一化后的 cache 数组。"""
    if site not in OC_SITES:
        raise HTTPException(400, f"未知 OC 站: {site}")
    key = oc_key(site)
    if not key:
        raise HTTPException(
            503,
            f"未配置 {site} 的 consumer_key。请在 {OC_SITES[site].rsplit('/', 1)[0]}/okapi/signup.html "
            f"申请，并设置环境变量 OCAPI_{site.upper()}_KEY",
        )

    cache_key = f"oc:{site}:{bbox}:{limit}"
    cached = cache_get(cache_key, ttl=600)
    if cached is not None:
        return cached

    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": USER_AGENT}) as client:
        # Step 1: search by bbox
        r = await client.get(
            f"{OC_SITES[site]}/caches/search/bbox",
            params={"bbox": bbox, "limit": str(limit), "consumer_key": key},
        )
        if r.status_code != 200:
            raise HTTPException(r.status_code, f"OCAPI search 失败: {r.text[:300]}")
        codes = r.json().get("results", [])
        if not codes:
            return []

        # Step 2: 拉详情（批量）
        r = await client.get(
            f"{OC_SITES[site]}/caches/geocaches",
            params={
                "cache_codes": "|".join(codes),
                "fields": "code|name|location|type|status|size2|difficulty|terrain|"
                          "owner|date_hidden|last_found|recommendations|url",
                "consumer_key": key,
            },
        )
        if r.status_code != 200:
            raise HTTPException(r.status_code, f"OCAPI geocaches 失败: {r.text[:300]}")
        raw = r.json()

    results = [n for code, c in raw.items() if (n := _normalize_oc_cache(code, c, site))]
    cache_set(cache_key, results)
    return results


@app.get("/api/oc/full")
async def oc_full(
    site: str = Query("ocde", description="默认 ocde；可选 ocpl/ocus/ocnl/ocro"),
    page_size: int = Query(500, ge=50, le=500),
    max_pages: int = Query(120, ge=1, le=500),
):
    """
    拉取某 OC 站点在中国范围内的“全量”缓存（分页抓 search/bbox + 批量 geocaches 详情）。
    默认缓存 12 小时，适合当前“国内点很少、偶尔同步”的场景。
    """
    if site not in OC_SITES:
        raise HTTPException(400, f"未知 OC 站: {site}")
    key = oc_key(site)
    if not key:
        raise HTTPException(503, f"未配置 {site} 的 consumer_key")

    cache_key = f"oc:full:{OC_FULL_CACHE_VERSION}:{site}"
    cached = cache_get(cache_key, ttl=12 * 3600)
    if cached is not None:
        return JSONResponse(cached, headers={"X-Cache": "HIT", "X-Site": site})

    base = OC_SITES[site]
    china_bbox = "17|72|55|136"  # S|W|N|E
    all_codes: List[str] = []
    seen: set[str] = set()

    async with httpx.AsyncClient(timeout=25, headers={"User-Agent": USER_AGENT}) as client:
        # 1) 分页抓取中国范围内 code（避免 search/all 在部分站点返回 400）
        for page in range(max_pages):
            offset = page * page_size
            r = await client.get(
                f"{base}/caches/search/bbox",
                params={
                    "consumer_key": key,
                    "bbox": china_bbox,
                    "limit": str(page_size),
                    "offset": str(offset),
                },
            )
            if r.status_code != 200:
                raise HTTPException(r.status_code, f"OCAPI search/bbox 失败: {r.text[:500]}")
            payload = r.json()
            codes = payload.get("results", []) if isinstance(payload, dict) else []
            if not codes:
                break

            for code in codes:
                if code not in seen:
                    seen.add(code)
                    all_codes.append(code)

            if len(codes) < page_size:
                break

        # 2) 批量拉详情，避免 URL 过长，分块请求
        results: List[dict] = []
        chunk_size = 120
        fields = (
            "code|name|location|type|status|size2|difficulty|terrain|"
            "owner|date_hidden|last_found|recommendations|url"
        )
        for i in range(0, len(all_codes), chunk_size):
            chunk = all_codes[i:i + chunk_size]
            r = await client.get(
                f"{base}/caches/geocaches",
                params={
                    "consumer_key": key,
                    "cache_codes": "|".join(chunk),
                    "fields": fields,
                },
            )
            if r.status_code != 200:
                raise HTTPException(r.status_code, f"OCAPI geocaches 失败: {r.text[:300]}")
            raw = r.json()
            if isinstance(raw, dict):
                for code, c in raw.items():
                    n = _normalize_oc_cache(code, c, site)
                    if n:
                        results.append(n)

    cache_set(cache_key, results)
    return JSONResponse(
        results,
        headers={"X-Cache": "MISS", "X-Site": site, "X-Count": str(len(results))},
    )


@app.get("/api/oc/code")
async def oc_code(
    site: str = Query("ocde"),
    code: str = Query(..., description="OC 编号, 如 OC1A2B3"),
):
    """单点查询。"""
    if site not in OC_SITES:
        raise HTTPException(400, f"未知 OC 站: {site}")
    key = oc_key(site)
    if not key:
        raise HTTPException(503, f"未配置 {site} 的 OCAPI key")

    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": USER_AGENT}) as client:
        r = await client.get(
            f"{OC_SITES[site]}/caches/geocache",
            params={
                "cache_code": code,
                "fields": "code|name|location|type|status|size2|difficulty|terrain|"
                          "owner|date_hidden|last_found|recommendations|url|short_description",
                "consumer_key": key,
            },
        )
        if r.status_code != 200:
            raise HTTPException(r.status_code, r.text[:300])
        return _normalize_oc_cache(code, r.json(), site)


@app.get("/api/oc/debug/types")
async def oc_debug_types(
    site: str = Query("ocde"),
):
    """
    调试接口：统计当前 OC 全量结果中的原始类型与映射后类型。
    用于快速判断“是不是都被映射成 T”。
    """
    resp = await oc_full(site=site)
    data = json.loads(resp.body) if isinstance(resp, JSONResponse) else resp
    if not isinstance(data, list):
        raise HTTPException(500, "unexpected data shape")

    raw_counts: Dict[str, int] = {}
    mapped_counts: Dict[str, int] = {}
    examples: Dict[str, str] = {}

    for c in data:
        raw = str(c.get("_ocRawType") or "")
        mapped = str(c.get("geocacheType"))
        raw_counts[raw] = raw_counts.get(raw, 0) + 1
        mapped_counts[mapped] = mapped_counts.get(mapped, 0) + 1
        if raw and raw not in examples:
            examples[raw] = c.get("code", "")

    return {
        "site": site,
        "total": len(data),
        "raw_type_counts": dict(sorted(raw_counts.items(), key=lambda kv: kv[1], reverse=True)),
        "mapped_type_counts": dict(sorted(mapped_counts.items(), key=lambda kv: kv[1], reverse=True)),
        "sample_code_by_raw_type": examples,
    }


# ─────────────────────────────────────────────────────────────
# 多源聚合
# ─────────────────────────────────────────────────────────────

@app.get("/api/all")
async def all_sources(
    bbox: Optional[str] = Query(None, description="若提供, 同时查询所有已配置的 OC 站"),
):
    """聚合 TFTC dump + 所有配置了 key 的 OC 站。"""
    tasks: List[asyncio.Task] = [asyncio.create_task(tftc_dump())]
    sources_attempted = ["tftc"]

    if bbox:
        for site in OC_SITES:
            if oc_key(site):
                tasks.append(asyncio.create_task(oc_bbox(site=site, bbox=bbox)))
                sources_attempted.append(site)

    results = await asyncio.gather(*tasks, return_exceptions=True)
    merged: List[dict] = []
    errors: Dict[str, str] = {}
    for src, r in zip(sources_attempted, results):
        if isinstance(r, Exception):
            errors[src] = str(r)
            continue
        if isinstance(r, JSONResponse):
            r = json.loads(r.body)
        if isinstance(r, list):
            merged.extend(r)

    return JSONResponse(
        merged,
        headers={"X-Sources": ",".join(sources_attempted), "X-Errors": json.dumps(errors)},
    )


# ─────────────────────────────────────────────────────────────
# 调试
# ─────────────────────────────────────────────────────────────

@app.get("/api/cache/info")
async def cache_info():
    """查看服务端缓存状态。"""
    info = []
    now = time.time()
    for k, (ts, v) in _cache.items():
        size = len(v) if isinstance(v, list) else "?"
        info.append({
            "key": k,
            "age_seconds": int(now - ts),
            "size": size,
        })
    return {"entries": info, "total_keys": len(_cache)}


@app.delete("/api/cache")
async def cache_clear():
    n = len(_cache)
    _cache.clear()
    return {"cleared": n}


# ─────────────────────────────────────────────────────────────
# 静态文件托管 (必须在所有 API 路由之后挂载)
# ─────────────────────────────────────────────────────────────

app.mount("/", StaticFiles(directory=STATIC_DIR, html=False), name="static")


def _get_windows_system_proxy() -> Optional[str]:
    """读 Windows 注册表里的系统代理 (v2rayN/Clash 开"系统代理"时会写在这里)。"""
    if os.name != "nt":
        return None
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        )
        try:
            enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
            if not enabled:
                return None
            server, _ = winreg.QueryValueEx(key, "ProxyServer")
        finally:
            winreg.CloseKey(key)

        if not server:
            return None
        # server 可能是 "127.0.0.1:10809" 或 "http=127.0.0.1:10809;https=..."
        if "=" in server:
            for part in server.split(";"):
                if part.lower().startswith(("http=", "https=")):
                    return "http://" + part.split("=", 1)[1]
            return None
        return f"http://{server}"
    except Exception:
        return None


def _ensure_proxy_env() -> str:
    """优先级: 已设的 env > Windows 系统代理 > 无."""
    existing = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
    )
    if existing:
        return f"{existing}  (来自环境变量)"

    sysproxy = _get_windows_system_proxy()
    if sysproxy:
        os.environ["HTTPS_PROXY"] = sysproxy
        os.environ["HTTP_PROXY"] = sysproxy
        return f"{sysproxy}  (自动从 Windows 系统代理读取)"

    return "(未设置, 直连出网)"


if __name__ == "__main__":
    import uvicorn

    proxy = _ensure_proxy_env()
    oc_configured = [s for s in OC_SITES if oc_key(s)] or ["(无)"]
    print("\n  ┌─ TFTC + OCAPI Proxy ─────────────────────────────────")
    print("  │  Web UI    :  http://127.0.0.1:8000/")
    print("  │  API doc   :  http://127.0.0.1:8000/docs")
    print("  │  Status    :  http://127.0.0.1:8000/api/info")
    print(f"  │  HTTP 代理 :  {proxy}")
    print(f"  │  OCAPI keys:  {', '.join(oc_configured)}")
    print("  └───────────────────────────────────────────────────────")
    if "未设置" in proxy:
        print(
            "  提示: 如果之后 /api/tftc/dump 报 ConnectError, 多半是没走代理.\n"
            "        在 PowerShell 里设置后再启动:\n"
            "          $env:HTTPS_PROXY = 'http://127.0.0.1:7890'\n"
            "          $env:HTTP_PROXY  = 'http://127.0.0.1:7890'\n"
        )
    uvicorn.run(app, host="127.0.0.1", port=8000, reload=False)
