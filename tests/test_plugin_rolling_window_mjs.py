"""把 tests/test_rolling_window_quota.mjs 纳入 pytest（CI 里没有单独的 node 步骤）.

插件仓的 CI 只跑 ruff + node --check + pytest；行为级 mjs 测试若没有这个包装，
就只能靠人手动 `node tests/...` 跑 —— 等于没有。node 是本插件的硬依赖（插件本体
就是 JS），缺了就该红而不是跳过。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MJS = PLUGIN_DIR / "tests" / "test_rolling_window_quota.mjs"


def test_rolling_window_quota_mjs():
    assert MJS.exists(), f"{MJS} 不见了 —— 行为测试被删了？"
    result = subprocess.run(
        ["node", str(MJS)],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=PLUGIN_DIR,
    )
    assert result.returncode == 0, (
        f"滚动小时额度行为测试失败：\n{result.stdout}\n{result.stderr}"
    )
    assert "all assertions passed" in result.stdout
