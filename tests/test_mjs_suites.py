"""把 `tests/*.mjs` 纳入 pytest（CI 里没有单独的 node 步骤）。

插件仓的 CI 只跑 ruff + node --check + pytest；行为级 mjs 测试若没有这个包装，
就只能靠人手动 `node tests/...` 跑 —— 等于没有。node 是本插件的硬依赖（插件本体
就是 JS），缺了就该红而不是跳过。

新增 mjs 测试**不需要改这里**：自动发现 `tests/*.mjs`。此前每个 mjs 都要配一份
几乎相同的包装（见 `test_plugin_rolling_window_mjs.py` 的旧形态），代价是最新加的
`test_xhs_challenge_classify.mjs` 一直没进 CI。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MJS_FILES = sorted((PLUGIN_DIR / "tests").glob("*.mjs"))


def test_mjs_suites_discovered():
    """兜底：mjs 测试被整体删掉时，参数化后的空集合会让 pytest 静默跳过。"""
    assert MJS_FILES, "tests/ 下一个 .mjs 行为测试都没有 —— 被删了？"


@pytest.mark.parametrize("mjs", MJS_FILES, ids=lambda p: p.stem)
def test_mjs_suite(mjs: Path):
    result = subprocess.run(
        ["node", str(mjs)],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=PLUGIN_DIR,
    )
    assert result.returncode == 0, (
        f"{mjs.name} 失败：\n{result.stdout}\n{result.stderr}"
    )
    # 各测试的结束标记文案不统一（"all assertions passed" / "✅ 7/7 条通过"），
    # 所以只要求「有输出」—— 完全没有输出通常意味着脚本提前静默退出。
    assert result.stdout.strip(), (
        f"{mjs.name} 没有任何输出，可能在断言之前就静默退出了：\n{result.stderr}"
    )
