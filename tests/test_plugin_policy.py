"""Plugin-owned pacing and domain policy invariants."""

from __future__ import annotations

import re
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def plugin_source() -> str:
    """把插件所有 .js 拼成一份可搜索的语料（入口 + lib/）."""
    files = sorted(PLUGIN_DIR.glob("*.js")) + sorted((PLUGIN_DIR / "lib").glob("*.js"))
    assert files, f"{PLUGIN_DIR} 下没有 .js"
    return "\n".join(p.read_text(encoding="utf-8") for p in files)


def _plugin_policy_js(site: str) -> str:
    """取出 BUILTIN_SITES 里某个站点的策略源码片段（内联对象或它引用的常量）."""
    src = plugin_source()
    table = re.search(r"const BUILTIN_SITES = \{(.*?)\n\};", src, re.S)
    assert table, "找不到 BUILTIN_SITES —— 插件结构变了，请同步这个测试"
    entry = re.search(
        rf"^\s*{re.escape(site)}\s*:\s*(\{{.*?\}}|[A-Za-z_$][\w$]*)\s*,?\s*$",
        table.group(1),
        re.M | re.S,
    )
    assert entry, f"BUILTIN_SITES 没有声明 `{site}` —— 该站点的调用将完全不限速"
    value = entry.group(1)
    if value.startswith("{"):
        return value
    const = re.search(rf"const {re.escape(value)} = \{{(.*?)\n\}};", src, re.S)
    assert const, f"`{value}` 的定义找不到，无法解析 {site} 的策略"
    return const.group(1)


def _plugin_number(site: str, key: str) -> float:
    policy = _plugin_policy_js(site)
    found = re.search(rf"\b{re.escape(key)}\s*:\s*([0-9.]+)", policy)
    assert found, f"{site} 的策略里没有 `{key}`：{policy[:80]}"
    return float(found.group(1))


def _plugin_const_ms(name: str) -> float:
    """读模块级毫秒常量（如 LOCK_WAIT_MS），换成秒."""
    src = plugin_source()
    found = re.search(rf"const {re.escape(name)} = ([\d_]+)", src)
    assert found, f"找不到常量 {name}"
    return float(found.group(1).replace("_", "")) / 1000.0


def _plugin_worst_wait_seconds(site: str) -> float:
    """单次调用在插件层可能被等待的最长时间 = 取锁轮询上限 + 预留等待上限.

    取锁那一段与预留等待是**相加**的（先拿到锁才预留、才 sleep），所以不能漏 ——
    漏了会给出「120 够用」的虚假保证。
    """
    return (
        _plugin_const_ms("LOCK_WAIT_MS")
        + _plugin_number(site, "max_delay_s")
        + _plugin_number(site, "long_pause_max_s")
    )


def test_builtin_sites_declare_web_with_pacing():
    """通用站 `web` 必须被声明，带正的基础间隔，且**下限不低于 6 秒**.

    回归（2026-10-12）：雪球生产链路的**详情页**走的是 `opencli web article`，
    站点键是 `web`。内置表原先只声明了 xiaohongshu / xueqiu，`policyFor('web')`
    返回 null —— 详情页**连基础的间隔都没有**，而它正是被风控墙拦掉的那类请求。

    下限 6 秒不是审美问题：`scripts/schedule-checks/peak.mjs` 用
    「6 秒下限 ⇒ 一分钟不可能超过 10 次」（PEAK_IMPOSSIBLE=10）判定「限速器被绕过」。
    把 `web` 调到 6 秒以下，合法的公告批量下载会被误报成绕过 —— 2026-10-12 差点
    就这么发了（当时写的是 3–8s）。
    """
    assert _plugin_number("web", "max_delay_s") > 0, "web 的策略没有正的基础间隔"
    assert _plugin_number("web", "min_delay_s") >= 6, (
        "web 的下限低于 6 秒 —— 会让 peak.mjs 的「6 秒下限」不变量失效、误报限速器被绕过"
    )


def test_known_domains_alias_back_to_their_existing_keys():
    """`xueqiu.com` 必须映射回**现有的键** `xueqiu`，不能是字符串 `'xueqiu.com'`.

    状态文件名由域名键直接决定 —— 映射成一个新名字会让状态文件换名、**限速排期清零**，
    下一次调用就以零间隔打出去（这正是按域名重构时最危险的一处）。同时
    `web/article` 打 xueqiu.com 时靠这条别名与 `xueqiu/` 的列表调用共用同一份额度，
    否则两者各算各的窗口、实际请求密度翻倍。
    """
    src = plugin_source()
    table = re.search(r"CANONICAL_DOMAIN_KEY = \{(.*?)\n\};", src, re.S)
    assert table, "找不到 CANONICAL_DOMAIN_KEY —— 插件结构变了，请同步这个测试"
    pairs = dict(re.findall(r"'([^']+)'\s*:\s*'([^']+)'", table.group(1)))
    assert pairs.get("xueqiu.com") == "xueqiu", (
        f"xueqiu.com 的别名必须是 xueqiu（状态文件才不换名），实际：{pairs.get('xueqiu.com')!r}"
    )
    assert pairs.get("www.xueqiu.com") == "xueqiu"
    assert pairs.get("xiaohongshu.com") == "xiaohongshu", (
        "小红书同理：换名会清零它的限速排期"
    )


def test_concurrency_gate_defaults_to_observe_only():
    """内置策略里**不得**预设 `concurrency` —— 默认必须是「只记录不拦」.

    启用闸门会让排队等待发生在 opencli 子进程内、被调用方 `subprocess.run` 一并计时，
    最坏墙钟 ≈ 限速 87s + 取锁 2s + 排队预算 20s + 执行 10s ≈ 119s。调用方现在是
    120s 超时，**必须先把它抬到 ~150s**（`scripts/opencli_extractor.py`、
    `xueqiu-monitor/src/detail_fetcher.py`）才能开闸。

    这条断言就是防止有人「顺手把 concurrency 调成 1/2」—— 那会把 119s 顶破 120s，
    表现为调用方超时、账号记失败，而根因藏在插件层。
    """
    src = plugin_source()
    table = re.search(r"const BUILTIN_SITES = \{(.*?)\n\};", src, re.S)
    assert table, "找不到 BUILTIN_SITES —— 插件结构变了，请同步这个测试"
    body = table.group(1)
    # 策略可以内联、也可以引用常量（XUEQIU_PACE），所以两边都查。
    pace = re.search(r"const XUEQIU_PACE = \{(.*?)\n\};", src, re.S)
    for label, chunk in (
        ("BUILTIN_SITES", body),
        ("XUEQIU_PACE", pace.group(1) if pace else ""),
    ):
        assert not re.search(r"\bconcurrency\w*\s*:", chunk), (
            f"{label} 预设了 concurrency —— 开闸前必须先把调用方超时抬到 ~150s "
            "（见本测试 docstring），否则排队等待会顶破 120s"
        )
