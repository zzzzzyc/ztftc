"""
TFTC.top API 命令行客户端 - MVP 示例

用法：
    python tftc_cli.py recent              # 最近发布
    python tftc_cli.py ftf                 # FTF 机会
    python tftc_cli.py event               # 当前活动
    python tftc_cli.py code GC12345        # 按编号查询
    python tftc_cli.py dump                # 下载全量数据 (gzip)
    python tftc_cli.py stats               # 全量数据统计

数据来源: tftc.top (非官方第三方聚合)
仅供技术学习使用
"""

import sys
import gzip
import json
import argparse
from datetime import datetime, timedelta, timezone
from collections import Counter
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

API_BASE = "https://tftc.top/apiv2"
CDN_BASE = "https://kevinaudio.bjcnc.scs.sohucs.com"

CACHE_TYPES = {
    2: "Traditional",
    3: "Multi-Cache",
    4: "Virtual",
    5: "Letterbox",
    6: "Event",
    8: "Mystery",
    11: "Webcam",
    13: "CITO",
    137: "Earthcache",
    453: "Mega-Event",
    3653: "Lab",
}

ENDPOINTS = {
    "recent":    "by-published",
    "found":     "by-found",
    "event":     "by-event",
    "today":     "by-today",
    "ftf":       "by-ftf",
    "all":       "all",
}


def http_get(url: str, timeout: int = 30) -> bytes:
    """简单的带 UA 的 HTTP GET。"""
    req = Request(url, headers={
        "User-Agent": "tftc-mvp/0.1 (+learning purpose)",
        "Accept": "application/json, */*",
    })
    with urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_endpoint(key: str) -> list[dict]:
    url = f"{API_BASE}/caches/{ENDPOINTS[key]}"
    return json.loads(http_get(url))


def fetch_by_code(code: str) -> list[dict]:
    url = f"{API_BASE}/caches/all?code={code}"
    return json.loads(http_get(url))


def fetch_dump() -> list[dict]:
    """从 CDN 下载最近的小时级 gzip 全量数据（带回退）。"""
    now = datetime.now(timezone.utc)
    last_err = None
    for offset in range(6):
        t = now - timedelta(hours=offset)
        url = f"{CDN_BASE}/geocaches_{t:%Y-%m-%d_%H}.gz"
        try:
            print(f"  尝试 {url} ...", file=sys.stderr)
            data = gzip.decompress(http_get(url, timeout=60))
            return json.loads(data)
        except (HTTPError, URLError, OSError) as e:
            last_err = e
            print(f"    失败: {e}", file=sys.stderr)
    raise RuntimeError(f"所有数据包都不可用: {last_err}")


def print_table(caches: list[dict], limit: int = 20):
    """简单的表格打印。"""
    headers = ["Code", "D/T", "Type", "Owner", "Name"]
    widths = [10, 6, 14, 20, 40]
    print()
    print(" | ".join(h.ljust(w) for h, w in zip(headers, widths)))
    print("-+-".join("-" * w for w in widths))
    for c in caches[:limit]:
        row = [
            c.get("code", "")[:widths[0]],
            f"{c.get('difficulty')}/{c.get('terrain')}",
            CACHE_TYPES.get(c.get("geocacheType"), str(c.get("geocacheType")))[:widths[2]],
            (c.get("ownerUsername") or "")[:widths[3]],
            (c.get("name") or "")[:widths[4]],
        ]
        print(" | ".join(str(v).ljust(w) for v, w in zip(row, widths)))
    if len(caches) > limit:
        print(f"\n  ... 还有 {len(caches) - limit} 条未显示")


def cmd_simple(key: str):
    caches = fetch_endpoint(key)
    print(f"获取到 {len(caches)} 条数据")
    print_table(caches)


def cmd_code(code: str):
    caches = fetch_by_code(code)
    if not caches:
        print(f"未找到 {code}")
        return
    c = caches[0]
    print(f"\n=== {c.get('code')} ===")
    print(f"名称:     {c.get('name')}")
    print(f"类型:     {CACHE_TYPES.get(c.get('geocacheType'), c.get('geocacheType'))}")
    print(f"难度地形: D{c.get('difficulty')} / T{c.get('terrain')}")
    print(f"Owner:    {c.get('ownerUsername')}")
    print(f"坐标:     {c.get('latitude')}, {c.get('longitude')}")
    print(f"发布日期: {c.get('placedDate')}")
    if c.get("lastFoundDate"):
        print(f"上次找到: {c.get('lastFoundDate')}")
    if c.get("favoritePoints") is not None:
        print(f"收藏数:   {c.get('favoritePoints')}")
    print(f"\n官方链接: https://www.geocaching.com/geocache/{c.get('code')}")


def cmd_dump(out_path: str | None):
    caches = fetch_dump()
    print(f"\n✓ 下载并解压了 {len(caches):,} 条藏点数据")
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(caches, f, ensure_ascii=False, indent=2)
        print(f"✓ 已保存到 {out_path}")
    print_table(caches)


def cmd_stats():
    caches = fetch_dump()
    print(f"\n全量数据: {len(caches):,} 条藏点\n")

    type_counter = Counter(CACHE_TYPES.get(c.get("geocacheType"), "Unknown") for c in caches)
    print("=== 类型分布 ===")
    for t, n in type_counter.most_common():
        bar = "█" * int(40 * n / type_counter.most_common(1)[0][1])
        print(f"  {t:14} {n:6,}  {bar}")

    owner_counter = Counter(c.get("ownerUsername") for c in caches if c.get("ownerUsername"))
    print(f"\n=== Top 10 Owner ===")
    for owner, n in owner_counter.most_common(10):
        print(f"  {n:5,}  {owner}")

    fav_top = sorted(
        (c for c in caches if c.get("favoritePoints")),
        key=lambda c: c.get("favoritePoints", 0),
        reverse=True,
    )[:10]
    if fav_top:
        print(f"\n=== Top 10 收藏数 ===")
        for c in fav_top:
            print(f"  ❤ {c['favoritePoints']:5,}  {c['code']:10} {c.get('name', '')}")


def main():
    parser = argparse.ArgumentParser(description="TFTC.top API CLI MVP")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("recent", help="最近发布的藏点")
    sub.add_parser("found",  help="今日被找到的")
    sub.add_parser("event",  help="活动")
    sub.add_parser("today",  help="历史上的今天")
    sub.add_parser("ftf",    help="FTF 机会")

    p_code = sub.add_parser("code", help="按 GC 编号查询")
    p_code.add_argument("code", help="例如 GC12345")

    p_dump = sub.add_parser("dump", help="下载全量数据")
    p_dump.add_argument("-o", "--out", help="保存到 JSON 文件")

    sub.add_parser("stats", help="全量数据统计")

    args = parser.parse_args()

    try:
        if args.cmd in ("recent", "found", "event", "today", "ftf"):
            cmd_simple(args.cmd)
        elif args.cmd == "code":
            cmd_code(args.code)
        elif args.cmd == "dump":
            cmd_dump(args.out)
        elif args.cmd == "stats":
            cmd_stats()
    except KeyboardInterrupt:
        print("\n中断")
        sys.exit(1)
    except Exception as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
