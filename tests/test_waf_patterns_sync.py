"""插件内生成的 WAF 正则必须与 analyzer 唯一源保持一致。"""

from __future__ import annotations

from sync_waf_patterns import ADAPTERS_DIR, ADAPTER_FILES, check_file
from xueqiu_analyzer.waf import block_guard_js


def test_block_guard_matches_analyzer_patterns():
    patterns = block_guard_js()
    problems = []
    for name in ADAPTER_FILES:
        path = ADAPTERS_DIR / name
        assert path.exists(), f"opencli 适配器缺失: {name}"
        problems.extend(check_file(path, patterns))
    assert not problems, (
        "BLOCK_GUARD 已漂移，运行 python3 scripts/sync_waf_patterns.py 修复:\n"
        + "\n".join(problems)
    )


def test_block_guard_covers_every_pattern():
    patterns = block_guard_js().split("|")
    for name in ADAPTER_FILES:
        text = (ADAPTERS_DIR / name).read_text(encoding="utf-8")
        for pattern in patterns:
            assert pattern in text, f"{name} 缺少模式 {pattern!r}"
