#!/usr/bin/env python3
"""同步 xueqiu_analyzer.waf 的内容模式到插件 BLOCK_GUARD。"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from xueqiu_analyzer.waf import CONTENT_PATTERNS, block_guard_js

ADAPTERS_DIR = Path(__file__).resolve().parent.parent
ADAPTER_FILES = ("news.js", "replies.js", "user-articles.js", "article.js")

# // 定界符被 block_guard_js() 拒绝，因此 [^/]* 安全。
_GUARD_RE = re.compile(r"(return /)([^/]*)(/\.test\(t\))")


def rewrite_line(line: str, patterns: str) -> str:
    """只替换 BLOCK_GUARD 中的模式，其余内容保持原样。"""
    return _GUARD_RE.sub(
        lambda match: match.group(1) + patterns + match.group(3), line, count=1
    )


def sync_file(path: Path, patterns: str) -> bool:
    """就地同步一个适配器文件，返回是否发生改动。"""
    original = path.read_text(encoding="utf-8")
    output = []
    touched = False
    for line in original.splitlines(keepends=True):
        if "const BLOCK_GUARD" in line:
            updated = rewrite_line(line, patterns)
            touched = touched or updated != line
            output.append(updated)
        else:
            output.append(line)
    if touched:
        path.write_text("".join(output), encoding="utf-8")
    return touched


def check_file(path: Path, patterns: str) -> list[str]:
    """返回漂移说明；一致时返回空列表。"""
    problems = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if "const BLOCK_GUARD" in line and rewrite_line(line, patterns) != line:
            problems.append(
                f"{path.name}:{lineno} BLOCK_GUARD 与 waf.CONTENT_PATTERNS 不一致"
            )
    return problems


def main(argv: list[str]) -> int:
    patterns = block_guard_js()
    if "--check" in argv:
        problems = []
        for name in ADAPTER_FILES:
            path = ADAPTERS_DIR / name
            if not path.exists():
                problems.append(f"{name} 不存在")
            else:
                problems.extend(check_file(path, patterns))
        if problems:
            print("检测到漂移 —— 运行 python3 scripts/sync_waf_patterns.py 修复:")
            for problem in problems:
                print("  " + problem)
            return 1
        print(
            f"BLOCK_GUARD 与 waf.CONTENT_PATTERNS 一致（{len(CONTENT_PATTERNS)} 个模式，"
            f"{len(ADAPTER_FILES)} 个文件）"
        )
        return 0

    changed = [
        name
        for name in ADAPTER_FILES
        if (ADAPTERS_DIR / name).exists() and sync_file(ADAPTERS_DIR / name, patterns)
    ]
    print("已更新: " + ", ".join(changed) if changed else "无需改动，已是最新")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
