#!/usr/bin/env python3
"""风控台账审计：从 opencli 插件台账算「真实请求量」与「分钟级频次」。

为什么有这个工具
----------------
2026-10-14 排查小红书 `search` 被封时，两个最基本的问题竟然答不上来：
「到底一共打了多少次」「一分钟内最多打了多少次」。台账里其实全都有
（`~/.opencli/adapter-calls.jsonl`，schema 2），但每次都临时手写一次性脚本，
口径各不相同 —— 同一天里我用「按日历分钟分桶」和「滑动窗口」量出过 4-7 次/分
和 3.7 次/分两个数，差了近一倍，直接导致一个错误结论。本工具把口径**固定在代码里**。

用法
----
    python3 risk_audit.py                            # 全站点总览
    python3 risk_audit.py --site xiaohongshu         # 只看小红书
    python3 risk_audit.py --site xiaohongshu --html /tmp/xhs-risk.html
    python3 risk_audit.py --json                     # 机器可读（可喂给定时巡检）

口径定义（重要，别再各写各的）
------------------------------
* **一次请求 = 台账一行**。台账由插件层 `onAfterExecute` 写，一个 opencli 进程一行，
  与站点实际收到的请求一一对应。可用 `--check-dupes` 复核有无双跑（同词极短间隔成对）。
* 计时锚点用 `finished_at`：真实发请求的时刻落在 `[started_at, finished_at]` 之间，
  而 `started_at` 之前可能还有限速等待，故用 `finished_at` 更接近站点侧时间。
* **封禁** = `error_code` 属于 BLOCK_CODES。**注意 `EMPTY_RESULT` / `AUTH_REQUIRED`
  不算封禁** —— 前者是"真没结果"，后者是"没登录"，都不是风控。
* **封禁段** = 连续被拦的行，相邻间隔超过 `--block-gap`（默认 60 分钟）则切开。
* **会话** = 相邻两行间隔不超过 `--gap`（默认 30 分钟）的连续段。
* **分钟内频次**一律用**滑动窗口**，不用按日历分钟分桶（后者会系统性高估峰值）。
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_LEDGER = Path.home() / ".opencli" / "adapter-calls.jsonl"
TZ = timezone(timedelta(hours=8))  # 报表一律按本地时区（+08:00）显示

# 真正的风控拦截码。加新码时**必须**同时更新 tests/test_opencli_live_chain.py 的 _SITE_SIDE
# 与 ~/.claude/skills/frontier-agent/SKILL.md 的错误码表，否则下游会把它当成普通失败。
BLOCK_CODES = frozenset({"RATE_LIMITED", "SECURITY_BLOCK", "BLOCKED_WAF"})


# --------------------------------------------------------------------------- 载入

def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load(ledger: Path, site: str | None) -> list[dict]:
    """读台账并按时间排序。坏行跳过而不是崩 —— 台账是 append-only 的，可能被截断。"""
    rows: list[dict] = []
    with ledger.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if site and record.get("site") != site:
                continue
            stamp = record.get("finished_at") or record.get("ts")
            if not stamp:
                continue
            try:
                record["_at"] = parse_ts(stamp)
            except ValueError:
                continue
            args = record.get("args")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            record["_args"] = args if isinstance(args, dict) else {}
            rows.append(record)
    rows.sort(key=lambda r: r["_at"])
    return rows


# --------------------------------------------------------------------------- 分析

def is_blocked(row: dict) -> bool:
    return row.get("error_code") in BLOCK_CODES


def split_site_requests(rows: list[dict]) -> tuple[list[dict], int]:
    """把「被熔断器挡下的调用」从台账里剔出去，返回 (真实请求行, 被剔掉几条)。

    熔断器生效时命令会在 routing 阶段硬失败，**一个站点请求都没发出去**
    （见 opencli-adapters/lib/cooldown.js）。把这种行算进请求量会同时污染两处：
    总量被虚高，且它们的 `error_code` 是 BROWSER_CONNECT —— 于是熔断器一上线，
    「拦截率」看起来就自己降下去了，把工具自己的功劳误读成「风控变好了」。
    """
    real = [row for row in rows if not row.get("cooldown_active")]
    return real, len(rows) - len(real)


def session_starts(rows: list[dict], gap_min: float) -> list[int]:
    """返回每个"会话"起始行的下标。会话 = 相邻间隔不超过 gap 的连续段。"""
    starts = []
    previous: datetime | None = None
    for index, row in enumerate(rows):
        if previous is None or (row["_at"] - previous) > timedelta(minutes=gap_min):
            starts.append(index)
        previous = row["_at"]
    return starts


def block_segments(rows: list[dict], gap_min: float) -> list[dict]:
    """把被拦的行聚成连续的封禁段。

    下标用 enumerate 取，**不能**用 rows.index(row) —— 台账里相同内容的行很多
    （同一关键词被拦多次时字段几乎一样），list.index 会返回第一个匹配项的下标，
    于是「本会话至此」这类统计会指向完全错误的位置。
    """
    segments: list[dict] = []
    for index, row in enumerate(rows):
        if not is_blocked(row):
            continue
        if segments and (row["_at"] - segments[-1]["last"]) <= timedelta(minutes=gap_min):
            segment = segments[-1]
            segment["last"] = row["_at"]
            segment["count"] += 1
            segment["codes"].update([row.get("error_code")])
            segment["indices"].append(index)
        else:
            segments.append({
                "start": row["_at"],
                "last": row["_at"],
                "count": 1,
                "codes": Counter([row.get("error_code")]),
                "indices": [index],
            })
    for segment in segments:
        segment["span_min"] = (segment["last"] - segment["start"]).total_seconds() / 60
    return segments


def peak_in_window(rows: list[dict], minutes: float) -> dict:
    """滑动窗口内的最大请求数（双指针，O(n)）。"""
    if not rows:
        return {"count": 0, "at": None, "rate_per_min": 0.0}
    span = timedelta(minutes=minutes)
    best, best_end, left = 0, 0, 0
    for right in range(len(rows)):
        while rows[right]["_at"] - rows[left]["_at"] > span:
            left += 1
        if right - left + 1 > best:
            best, best_end = right - left + 1, right
    return {
        "count": best,
        "at": rows[best_end]["_at"],
        "rate_per_min": round(best / minutes, 2) if minutes else 0.0,
    }


def load_before(rows: list[dict], moment: datetime, minutes: float) -> int:
    window = timedelta(minutes=minutes)
    return sum(1 for row in rows if moment - window <= row["_at"] < moment)


def runs_since_last_success(rows: list[dict], index: int) -> int:
    """自上一次成功起，连续被拦了多少次（不含本次）。"""
    count = 0
    for position in range(index - 1, -1, -1):
        if rows[position].get("ok"):
            break
        if is_blocked(rows[position]):
            count += 1
        else:
            break
    return count


def recovery_gaps(rows: list[dict]) -> list[dict]:
    """每个封禁段之后，隔多久才出现第一次成功。"""
    results = []
    for segment in block_segments(rows, 60.0):
        after = [row for row in rows if row["_at"] > segment["last"] and row.get("ok")]
        results.append({
            "block_start": segment["start"],
            "block_last": segment["last"],
            "span_min": segment["span_min"],
            "first_ok_after": after[0]["_at"] if after else None,
            "cooldown_min": (
                (after[0]["_at"] - segment["last"]).total_seconds() / 60 if after else None
            ),
        })
    return results


def call_identity(row: dict) -> str | None:
    """一次调用的「业务身份」，用于双跑检测。

    **不能直接用 `args.query`**：`note` / `comments` / `feed` / `liked` 这些命令的
    args 里根本没有 `query`，它们会全部得到 `None`，`None == None` 于是把**任意两行
    相邻调用**判成「同词双跑」—— 2026-10-14 实测这样报出 2 对假阳性。
    身份字段有则取用，一个都没有就返回 None 并跳过比较（宁可不查，不可乱报）。
    """
    args = row.get("_args") or {}
    for key in ("query", "url", "note-id", "user-id", "user_id", "keyword"):
        value = args.get(key)
        if value:
            return f"{key}={value}"
    return None


def check_dupes(rows: list[dict], threshold_s: float = 3.0) -> list[tuple[dict, dict]]:
    """双跑检测：同一业务身份在极短间隔内出现两次。返回成对的行，供人工核对。

    2026-10-14 双跑 bug 修复后实测为 0 对；本函数留作回归哨兵 —— 一旦非 0，
    说明「一次逻辑调用打两次站点请求」的形态又回来了，那会直接让实际请求密度翻倍。
    """
    pairs: list[tuple[dict, dict]] = []
    for previous, current in zip(rows, rows[1:]):
        identity = call_identity(previous)
        if identity is None or identity != call_identity(current):
            continue
        if (current["_at"] - previous["_at"]).total_seconds() < threshold_s:
            pairs.append((previous, current))
    return pairs


# --------------------------------------------------------------------------- 输出

def fmt(moment: datetime | None) -> str:
    return moment.astimezone(TZ).strftime("%m-%d %H:%M:%S") if moment else "—"


def pad(text: str, width: int, align: str = "<") -> str:
    """按**显示宽度**补齐（CJK 算 2 列）。

    f-string 的 `<10` 数的是码点，中文一个字只算 1，于是中文表格必然错位。
    这份报表是给人看的（还经常是在手机上用等宽字体看），值得修。
    """
    shown = sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)
    fill = " " * max(width - shown, 0)
    return fill + text if align == ">" else text + fill


def duration(minutes: float | None) -> str:
    if minutes is None:
        return "—"
    if minutes < 1:
        return "不足1分"
    if minutes < 60:
        return f"{minutes:.0f} 分"
    if minutes < 60 * 48:
        return f"{minutes / 60:.1f} 小时"
    return f"{minutes / 1440:.1f} 天"


def report_text(rows: list[dict], ledger: Path, site: str | None, gap_min: float,
                block_gap: float, show_dupes: bool) -> str:
    out: list[str] = []
    label = site or "全部站点"
    out.append(f"# 风控台账审计 · {label}")
    out.append(f"台账: {ledger}")
    if not rows:
        out.append("\n（该站点在台账里没有任何记录）")
        return "\n".join(out)

    rows, cooldown_blocked = split_site_requests(rows)
    out.append(f"跨度: {fmt(rows[0]['_at'])} → {fmt(rows[-1]['_at'])}"
               f"  （共 {(rows[-1]['_at'] - rows[0]['_at']).total_seconds() / 3600:.1f} 小时）")
    out.append(f"总请求数: {len(rows)}")
    if cooldown_blocked:
        out.append(f"（另有 {cooldown_blocked} 次被熔断器拦下、**未发出请求**，已从以上统计中剔除 —— "
                   f"它们若算进来会让'拦截率'看起来自己降下去）")

    # ① 总量：按命令
    out.append("\n## ① 总量（按命令）")
    by_command: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_command[row.get("command") or "?"].append(row)
    out.append(pad("命令", 28) + pad("总次数", 8, ">") + pad("成功", 7, ">")
               + pad("被拦", 7, ">") + pad("被拦率", 9, ">") + "  最后成功")
    for command, group in sorted(by_command.items(), key=lambda kv: -len(kv[1])):
        blocked = sum(1 for row in group if is_blocked(row))
        ok = sum(1 for row in group if row.get("ok"))
        last_ok = next((row["_at"] for row in reversed(group) if row.get("ok")), None)
        rate = f"{blocked / len(group) * 100:.0f}%" if group else "—"
        out.append(pad(command, 28) + pad(str(len(group)), 8, ">") + pad(str(ok), 7, ">")
                   + pad(str(blocked), 7, ">") + pad(rate, 9, ">") + "  " + fmt(last_ok))

    # ② 总量：按天 + 会话
    out.append("\n## ② 总量（按天 / 按会话）")
    by_day: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_day[row["_at"].astimezone(TZ).strftime("%m-%d")].append(row)
    out.append(pad("日期", 10) + pad("请求", 8, ">") + pad("被拦", 7, ">") + "  首次 → 末次")
    for day, group in sorted(by_day.items()):
        blocked = sum(1 for row in group if is_blocked(row))
        out.append(pad(day, 10) + pad(str(len(group)), 8, ">") + pad(str(blocked), 7, ">")
                   + f"  {fmt(group[0]['_at'])[:11]} → {fmt(group[-1]['_at'])[:11]}")

    starts = session_starts(rows, gap_min)
    out.append(f"\n会话（间隔 ≤ {gap_min:.0f} 分钟算同一场，共 {len(starts)} 场）:")
    out.append(pad("开始", 17) + pad("时长", 9, ">") + pad("请求数", 8, ">")
               + pad("均速/分", 9, ">") + pad("峰值/分", 9, ">") + "  被拦")
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(rows)
        group = rows[start:end]
        span = max((group[-1]["_at"] - group[0]["_at"]).total_seconds() / 60, 0.01)
        blocked = sum(1 for row in group if is_blocked(row))
        # 峰值用 1 分钟滑动窗口，和"分钟内频次"同一口径
        peak = peak_in_window(group, 1.0)["count"]
        out.append(pad(fmt(group[0]["_at"])[:14], 17) + pad(duration(span), 9, ">")
                   + pad(str(len(group)), 8, ">") + pad(f"{len(group) / span:.1f}", 9, ">")
                   + pad(str(peak), 9, ">") + f"  {blocked}")
        if len(starts) > 40 and position >= 39:
            out.append(f"  … 其余 {len(starts) - 40} 场略（用 --json 取全量）")
            break

    # ③ 分钟频次
    out.append("\n## ③ 分钟内频次（滑动窗口；这是唯一正确的口径）")
    out.append("⚠️ 不要用「按日历分钟分桶」——那测的是某分钟的峰值，比窗口均速高得多，")
    out.append("   2026-10-14 我正是拿它得出了错误结论。")
    out.append(pad("窗口", 12) + pad("峰值请求数", 12, ">") + pad("折算/分", 10, ">")
               + "  峰值出现于")
    for minutes in (1, 5, 15, 60):
        peak = peak_in_window(rows, minutes)
        out.append(pad(f"{minutes} 分钟", 12) + pad(str(peak["count"]), 12, ">")
                   + pad(f"{peak['rate_per_min']:.2f}", 10, ">") + "  " + fmt(peak["at"]))

    # ④ 封禁段
    segments = block_segments(rows, block_gap)
    out.append(f"\n## ④ 封禁段（共 {len(segments)} 段）")
    if not segments:
        out.append("（无）")
    else:
        out.append(pad("#", 4) + pad("开始", 17) + pad("末次", 17) + pad("持续", 9, ">")
                   + pad("被拦次数", 9, ">") + "  错误码")
        for number, segment in enumerate(segments, 1):
            codes = ", ".join(f"{code}×{n}" for code, n in segment["codes"].most_common())
            out.append(pad(str(number), 4) + pad(fmt(segment["start"])[:14], 17)
                       + pad(fmt(segment["last"])[:14], 17)
                       + pad(duration(segment["span_min"]), 9, ">")
                       + pad(str(segment["count"]), 9, ">") + f"  {codes}")

    # ⑤ 触发前的负荷 —— 找阈值的关键
    out.append("\n## ⑤ 每次封禁「触发前」的负荷")
    out.append("对照着看：能站住的说法是「连续多久 / 累计多少次之后触发」，而不是某个瞬时速率。")
    out.append(pad("#", 4) + pad("触发时刻", 17) + pad("前1分", 7, ">") + pad("前5分", 7, ">")
               + pad("前15分", 8, ">") + pad("前60分", 8, ">")
               + pad("本会话至此", 11, ">") + pad("连续被拦", 9, ">"))
    for number, segment in enumerate(segments, 1):
        onset = segment["start"]
        index = segment["indices"][0]
        # 本会话（最近一次大间隔之后的全部请求）
        session_start = 0
        for position in range(index, -1, -1):
            if position == 0 or (rows[position]["_at"] - rows[position - 1]["_at"]) > timedelta(minutes=gap_min):
                session_start = position
                break
        out.append(pad(str(number), 4) + pad(fmt(onset)[:14], 17)
                   + pad(str(load_before(rows, onset, 1)), 7, ">")
                   + pad(str(load_before(rows, onset, 5)), 7, ">")
                   + pad(str(load_before(rows, onset, 15)), 8, ">")
                   + pad(str(load_before(rows, onset, 60)), 8, ">")
                   + pad(str(index - session_start), 11, ">")
                   + pad(str(runs_since_last_success(rows, index)), 9, ">"))

    # ⑥ 恢复
    gaps = [item for item in recovery_gaps(rows) if item["cooldown_min"] is not None]
    out.append("\n## ⑥ 封禁后的恢复")
    if not gaps:
        out.append("（台账内尚无「封禁后又成功」的记录 —— 说明封禁至今未解，或还没等到恢复）")
    else:
        out.append(pad("封禁开始", 17) + pad("封禁持续", 10, ">") + pad("首次成功", 17)
                   + pad("末次拦截→恢复", 14, ">"))
        for item in gaps:
            out.append(pad(fmt(item["block_start"])[:14], 17)
                       + pad(duration(item["span_min"]), 10, ">")
                       + pad(fmt(item["first_ok_after"])[:14], 17)
                       + pad(duration(item["cooldown_min"]), 14, ">"))
        cool = [item["cooldown_min"] for item in gaps]
        out.append(f"\n恢复耗时: 最短 {duration(min(cool))} / 最长 {duration(max(cool))} / "
                   f"中位 {duration(sorted(cool)[len(cool) // 2])}")

    # ⑦ 安全边界估计 —— 这才是能用来调参的那个数
    out.append("\n## ⑦ 安全边界估计（能用来调参的只有这里的数）")
    starts = session_starts(rows, gap_min)
    sessions = []
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(rows)
        group = rows[start:end]
        sessions.append((group, sum(1 for row in group if is_blocked(row))))
    # 只看"真的在干活"的会话；1–2 次的探针会话对估计边界没有信息量
    real = [(group, blocked) for group, blocked in sessions if len(group) >= 10]
    hit = [(group, blocked) for group, blocked in real if blocked > 0]
    clean = [(group, blocked) for group, blocked in real if blocked == 0]

    if hit:
        sizes = sorted(len(group) for group, _ in hit)
        out.append(f"- **踩雷的长会话（≥10 次）：{len(hit)} 场**，累计请求 "
                   f"{sizes[0]}–{sizes[-1]} 次/场（中位 {sizes[len(sizes) // 2]}）")
    else:
        out.append("- 尚无 ≥10 次且踩雷的长会话")
    if clean:
        sizes = sorted(len(group) for group, _ in clean)
        out.append(f"- **干净的长会话：{len(clean)} 场**，累计请求 "
                   f"{sizes[0]}–{sizes[-1]} 次/场")
    else:
        out.append("- ❌ **干净的长会话：0 场** —— 也就是说，"
                   "我们**从来没有跑完过一场不被封的长会话**，"
                   "所以「单场累计多少次是安全的」这个数**目前根本不存在**，"
                   "任何写出来的数字都是编的。")
    if hit and not clean:
        lowest = min(len(group) for group, _ in hit)
        out.append(f"- 可下的最强结论：**安全上界低于 {lowest} 次/场**（已知最少的踩雷场就是 "
                   f"{lowest} 次）。要把它变成确切的数，只能主动做一次受控实验："
                   f"固定间隔、单场 {lowest // 2} 次、跑完不封再翻倍。")
        out.append("- ⚠️ 别再用「空闲后单发一枪探一下」的办法猜 —— 那既测不出边界，"
                   "又会给已建立的封禁续命（见 ⑤ 中前 60 分负荷为 0 的那几段）。")

    if show_dupes:
        out.append("\n## ⑧ 双跑哨兵")
        pairs = check_dupes(rows)
        if not pairs:
            out.append("同身份 <3 秒成对出现: 0 对  ✅ 正常（一次逻辑调用 = 一次站点请求）")
        else:
            out.append(f"同身份 <3 秒成对出现: {len(pairs)} 对  ❌ **双跑回归** —— "
                       f"实际请求密度翻倍，此时任何限速结论都不可信！")
            for previous, current in pairs[:10]:
                out.append(f"  {fmt(current['_at'])}  {call_identity(current)}  "
                           f"相隔 {(current['_at'] - previous['_at']).total_seconds():.2f}s  "
                           f"pid {previous.get('pid')} → {current.get('pid')}")
    return "\n".join(out)


def report_html(rows: list[dict], ledger: Path, site: str | None, gap_min: float,
                block_gap: float) -> str:
    """自包含单文件 HTML —— 手机上直接看，不依赖任何外部资源。"""
    label = site or "全部站点"
    if not rows:
        return f"<html><body><h1>{label}</h1><p>无记录</p></body></html>"

    rows, cooldown_blocked = split_site_requests(rows)
    first, last = rows[0]["_at"], rows[-1]["_at"]
    total_seconds = max((last - first).total_seconds(), 1)
    segments = block_segments(rows, block_gap)

    # 时间轴：按 5 分钟分桶
    bucket_s = 300
    buckets = (int(total_seconds // bucket_s) + 1) * [0]
    blocks = (int(total_seconds // bucket_s) + 1) * [0]
    for row in rows:
        slot = int((row["_at"] - first).total_seconds() // bucket_s)
        buckets[slot] += 1
        if is_blocked(row):
            blocks[slot] += 1

    width, height, pad = 1100, 220, 40
    inner_w, inner_h = width - 2 * pad, height - 2 * pad
    peak = max(buckets) or 1
    bars, marks = [], []
    step = inner_w / max(len(buckets), 1)
    for index, value in enumerate(buckets):
        if value == 0 and blocks[index] == 0:
            continue
        bar_h = value / peak * inner_h
        x = pad + index * step
        colour = "#c0392b" if blocks[index] else "#2e86de"
        bars.append(f'<rect x="{x:.2f}" y="{pad + inner_h - bar_h:.2f}" '
                    f'width="{max(step - 0.6, 0.6):.2f}" height="{bar_h:.2f}" fill="{colour}" '
                    f'opacity="{0.5 if blocks[index] else 0.9}"><title>'
                    f'{fmt(first + timedelta(seconds=index * bucket_s))} · {value} 次'
                    f'{"（含被拦 %d）" % blocks[index] if blocks[index] else ""}</title></rect>')
    for segment in segments:
        x = pad + (segment["start"] - first).total_seconds() / total_seconds * inner_w
        marks.append(f'<line x1="{x:.2f}" y1="{pad}" x2="{x:.2f}" y2="{pad + inner_h}" '
                     f'stroke="#c0392b" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.8"/>')

    table_rows = []
    for number, segment in enumerate(segments, 1):
        onset = segment["start"]
        codes = ", ".join(f"{c}×{n}" for c, n in segment["codes"].most_common())
        table_rows.append(
            f"<tr><td>{number}</td><td>{fmt(onset)}</td><td>{duration(segment['span_min'])}</td>"
            f"<td>{segment['count']}</td><td>{load_before(rows, onset, 1)}</td>"
            f"<td>{load_before(rows, onset, 5)}</td><td>{load_before(rows, onset, 15)}</td>"
            f"<td>{load_before(rows, onset, 60)}</td><td>{codes}</td></tr>")

    cooldown_card = (
        f'<div class="metric"><div class="value">{cooldown_blocked}</div>'
        f'<div class="label">熔断拦下</div><div class="sub">未发出请求，已剔除</div></div>'
        if cooldown_blocked else ""
    )
    peaks = "".join(
        f"<div class='metric'><div class='value'>{peak_in_window(rows, m)['count']}</div>"
        f"<div class='label'>{m} 分钟窗口峰值</div>"
        f"<div class='sub'>{peak_in_window(rows, m)['rate_per_min']} 次/分</div></div>"
        for m in (1, 5, 15, 60)
    )
    blocked_total = sum(1 for row in rows if is_blocked(row))

    # 安全边界 —— 全篇最有信息量的一个结论，必须出现在报表正文里，不能只留在终端
    starts = session_starts(rows, gap_min)
    sizes: list[tuple[int, int]] = []
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(rows)
        group = rows[start:end]
        sizes.append((len(group), sum(1 for row in group if is_blocked(row))))
    real = [item for item in sizes if item[0] >= 10]
    hit = sorted(size for size, blocked in real if blocked > 0)
    clean = sorted(size for size, blocked in real if blocked == 0)
    if not hit:
        boundary = "尚无 ≥10 次的长会话，无法判断边界。"
    elif clean:
        boundary = (f"踩雷的长会话 {len(hit)} 场（累计 {hit[0]}–{hit[-1]} 次）；"
                    f"干净的长会话 {len(clean)} 场（累计 {clean[0]}–{clean[-1]} 次）。")
    else:
        boundary = (f"踩雷的长会话 {len(hit)} 场（累计 {hit[0]}–{hit[-1]} 次）；"
                    f"<b>干净的长会话 0 场</b> —— 从未跑完过一场不被封的长会话，"
                    f"所以「单场累计多少次安全」这个数目前根本不存在。"
                    f"可下的最强结论是：安全上界低于 <b>{hit[0]} 次/场</b>。")

    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>风控台账审计 · {label}</title>
<style>
 :root{{--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb;--bad:#c0392b}}
 *{{box-sizing:border-box}}
 body{{margin:0;padding:20px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:var(--fg);background:#fafafa}}
 h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:15px;margin:28px 0 8px;padding-bottom:6px;border-bottom:2px solid var(--line)}}
 .meta{{color:var(--muted);font-size:12px;word-break:break-all}}
 .cards{{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}}
 .metric{{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:120px}}
 .metric .value{{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}}
 .metric .label{{font-size:12px;color:var(--muted)}} .metric .sub{{font-size:12px;color:var(--muted)}}
 .chart{{background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px;overflow-x:auto}}
 table{{width:100%;border-collapse:collapse;background:#fff;font-size:12.5px;font-variant-numeric:tabular-nums}}
 th,td{{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}}
 th{{background:#f3f4f6;font-weight:600;position:sticky;top:0}}
 .scroll{{overflow-x:auto;border:1px solid var(--line);border-radius:10px}}
 .warn{{background:#fff5f5;border-left:3px solid var(--bad);padding:10px 14px;border-radius:6px;margin:12px 0}}
 .legend{{font-size:12px;color:var(--muted);margin-top:6px}}
 .dot{{display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:middle;margin:0 4px 0 12px}}
</style>
<h1>风控台账审计 · {label}</h1>
<div class="meta">台账 {ledger}<br>{fmt(first)} → {fmt(last)} · 跨度 {(last - first).total_seconds() / 3600:.1f} 小时</div>

<div class="cards">
  <div class="metric"><div class="value">{len(rows)}</div><div class="label">总请求数</div></div>
  <div class="metric"><div class="value">{blocked_total}</div><div class="label">被拦次数</div>
      <div class="sub">{blocked_total / len(rows) * 100:.1f}%</div></div>
  <div class="metric"><div class="value">{len(segments)}</div><div class="label">封禁段</div></div>
  {cooldown_card}
  {peaks}
</div>

<h2>请求时间轴（5 分钟分桶）</h2>
<div class="chart"><svg viewBox="0 0 {width} {height}" width="{width}" height="{height}"
 style="min-width:{width}px">{''.join(bars)}{''.join(marks)}</svg></div>
<div class="legend"><span class="dot" style="background:#2e86de"></span>正常
<span class="dot" style="background:#c0392b"></span>被拦<span class="dot" style="background:#c0392b;opacity:.5"></span>含被拦的桶
<span style="margin-left:12px">红色虚线 = 封禁段起点</span></div>

<h2>安全边界</h2>
<div class="warn">{boundary}
<div style="margin-top:8px;color:#6b7280;font-size:12.5px">
要把它变成确切的数，只能做一次<b>受控实验</b>：固定间隔、单场打一半的量、跑完不封再翻倍。
不要再用「空闲后单发一枪探一下」的办法猜 —— 它既测不出边界，又会给已建立的封禁续命。
</div></div>

<h2>封禁段与触发前负荷</h2>
<div class="warn">「触发前负荷」是找阈值的关键：能站住的说法是「连续多久 / 累计多少次之后触发」，
而不是某个瞬时速率。<b>注意本页所有频次都用滑动窗口</b>，不是按日历分钟分桶。</div>
<div class="scroll"><table>
<tr><th>#</th><th>触发时刻</th><th>持续</th><th>被拦次数</th><th>前 1 分</th><th>前 5 分</th>
<th>前 15 分</th><th>前 60 分</th><th>错误码</th></tr>
{''.join(table_rows) if table_rows else '<tr><td colspan="9">无封禁记录</td></tr>'}
</table></div>
</body></html>"""


# --------------------------------------------------------------------------- CLI

def main() -> int:
    parser = argparse.ArgumentParser(description="opencli 风控台账审计")
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument("--site", default=None, help="只统计该站点（如 xiaohongshu）")
    parser.add_argument("--gap", type=float, default=30.0, help="会话切分间隔（分钟），默认 30")
    parser.add_argument("--block-gap", type=float, default=60.0, help="封禁段切分间隔（分钟），默认 60")
    parser.add_argument("--check-dupes", action="store_true", help="额外跑双跑哨兵")
    parser.add_argument("--json", action="store_true", help="输出 JSON 而不是报表")
    parser.add_argument("--html", type=Path, default=None, help="另存自包含 HTML 报表")
    parser.add_argument("--quiet", action="store_true", help="配 --html 用时只打印一行摘要")
    options = parser.parse_args()

    if not options.ledger.exists():
        print(f"台账不存在: {options.ledger}", file=sys.stderr)
        return 2

    rows = load(options.ledger, options.site)
    if options.json:
        # peak_in_window 的 "at" 是 datetime，直接 json.dumps 会 TypeError，
        # 必须显式转 isoformat —— 这个坑第一次跑 --json 时踩到了。
        peaks = {}
        for minutes in (1, 5, 15, 60):
            peak = peak_in_window(rows, minutes)
            peaks[f"{minutes}m"] = {
                "count": peak["count"],
                "rate_per_min": peak["rate_per_min"],
                "at": peak["at"].isoformat() if peak["at"] else None,
            }
        # 与报表同一口径：熔断拦下的行不是站点请求，必须剔除 —— 两条路径口径不一致
        # 会让定时巡检的数字和报表对不上，那种"两张表谁对"的排查最耗人。
        rows, cooldown_blocked = split_site_requests(rows)
        payload = {
            "site": options.site,
            "total": len(rows),
            "cooldown_blocked": cooldown_blocked,
            "blocked": sum(1 for r in rows if is_blocked(r)),
            "range": [rows[0]["_at"].isoformat(), rows[-1]["_at"].isoformat()] if rows else None,
            "peaks": peaks,
            "block_segments": [
                {"start": s["start"].isoformat(), "last": s["last"].isoformat(),
                 "count": s["count"], "span_min": round(s["span_min"], 1),
                 "codes": dict(s["codes"]),
                 "load_before": {f"{m}m": load_before(rows, s["start"], m) for m in (1, 5, 15, 60)}}
                for s in block_segments(rows, options.block_gap)
            ],
            "dupes": (
                [{"identity": call_identity(current), "at": current["_at"].isoformat(),
                  "gap_s": round((current["_at"] - previous["_at"]).total_seconds(), 2)}
                 for previous, current in check_dupes(rows)]
                if options.check_dupes else None
            ),
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    elif not options.quiet:
        print(report_text(rows, options.ledger, options.site, options.gap,
                          options.block_gap, options.check_dupes))

    if options.html:
        options.html.parent.mkdir(parents=True, exist_ok=True)
        options.html.write_text(report_html(rows, options.ledger, options.site,
                                            options.gap, options.block_gap), encoding="utf-8")
        print(f"HTML 报表: {options.html}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
