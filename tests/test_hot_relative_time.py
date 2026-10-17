"""hot 的相对时间解析必须与实测形态对齐（裸 node 探测 lib/relative-time.js）。

为什么值得单独一个文件：hot.js 会把「解析失败的条目」整条丢弃——解析器一旦
漏形态（如 2026-10-17 实测的 `修改于6小时前`），结果只会**悄悄变少**，不报错。
这里的用例全部来自实测，新增形态时先在这里补用例。

与 test_opencli_adapter_domains.py 同款探测模式：lib/ 不 import opencli 包，
裸 node 就能跑，CI 没有 node_modules 也不受影响。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]

_PROBE = """
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.argv[1]).href);
const cases = JSON.parse(process.argv[2]);
const now = Date.UTC(2026, 9, 17, 8, 30, 0); // 2026-10-17 16:30 北京时间
const out = cases.map(([raw]) => mod.parseRelativeTimeToIso(raw, now));
process.stdout.write(JSON.stringify(out));
"""

# (输入, 期望)。now 固定为 2026-10-17 16:30（北京时间）。
CASES: list[tuple[str, str]] = [
    ("刚刚", "2026-10-17T16:30:00+08:00"),
    ("3分钟前", "2026-10-17T16:27:00+08:00"),
    ("2小时前", "2026-10-17T14:30:00+08:00"),
    ("1天前", "2026-10-16T16:30:00+08:00"),
    ("修改于6小时前", "2026-10-17T10:30:00+08:00"),
    ("修改于昨天 16:38", "2026-10-16T16:38:00+08:00"),
    ("今天 09:05", "2026-10-17T09:05:00+08:00"),
    ("昨天 08:30", "2026-10-16T08:30:00+08:00"),
    ("16:05", "2026-10-17T16:05:00+08:00"),
    ("23:50", "2026-10-16T23:50:00+08:00"),
    ("10-16", "2026-10-16T00:00:00+08:00"),
    ("10-16 21:30", "2026-10-16T21:30:00+08:00"),
    ("12-31", "2025-12-31T00:00:00+08:00"),
    ("2026-10-15", "2026-10-15T00:00:00+08:00"),
    ("2026-10-15 21:30", "2026-10-15T21:30:00+08:00"),
    ("", ""),
    ("woo", ""),
    ("置顶", ""),
]


def _run_probe(cases: list[tuple[str, str]]) -> list[str]:
    node = shutil.which("node")
    if not node:
        pytest.skip("环境里没有 node，跳过（CI 的 ubuntu-latest 自带）")
    proc = subprocess.run(
        [
            node,
            "--input-type=module",
            "-e",
            _PROBE,
            str(PLUGIN_DIR / "lib" / "relative-time.js"),
            json.dumps([[raw] for raw, _ in cases]),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, f"node 跑失败：{proc.stderr[:400]}"
    return json.loads(proc.stdout)


def test_parse_relative_time_matches_the_live_shapes():
    got = _run_probe(CASES)
    problems = [
        f"  {raw!r} → {actual!r}，期望 {expected!r}"
        for (raw, expected), actual in zip(CASES, got)
        if actual != expected
    ]
    assert not problems, "相对时间解析与预期不符：\n" + "\n".join(problems)
