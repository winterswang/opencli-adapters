# opencli-adapters 接口契约

> **这份文件是契约，不是介绍。** 消费者（三个仓里的 Python 代码、以及 agent 会话）依赖下面写的
> **每一个字段名、错误码与数值**。改插件前先看 [§6 改动检查表](#6-改动检查表)。

## 1. 它是什么，装在哪，谁在调

**机器级插件**，不是某个仓的内部模块：

```
~/.opencli/plugins/opencli-adapters  →  符号链接  →  <repo>/opencli-adapters/
```

本仓已独立提取并把插件 ID 改为 `opencli-adapters`，且已于 2026-10-12 完成安装切换：运行中的
插件现在就是本仓（锁在 commit `a5fecba`）。消费者仓与用户级 Skill 的引用仍在旧名称/旧路径，
属后续迁移阶段。

改工作区源码**立即生效**（符号链接），所以「改完要跑一遍测试」不是可选项。

**它只覆盖走 opencli registry 的命令**（`cli({...})` 注册的那些）。以下**不经任何钩子**、也不受本插件的限频/并发/台账管辖：`opencli browser …`、`opencli doctor`、`opencli list`、`--help` 探测。
详见 [README 的覆盖面表](./README.md)。

| 消费者 | 入口 | 经哪条命令 |
|---|---|---|
| `xueqiu-crawler` | `scripts/opencli_extractor.py` → `scripts/crawler_nodriver.py`、`crawl_gateway/adapters/opencli_client.py` | `xueqiu user-articles`、`web article` |
| `xueqiu-analyzer-skill`（**共享封装**） | `src/xueqiu_analyzer/fetcher_opencli.py` | `xueqiu stock/comments/news/replies/stock-notices` |
| `xueqiu-monitor` | 经上面那个共享封装（`src/crawler.py`、`src/cli.py`）；另有 `scripts/backfill_*.py` 直连 | 同上 |
| `xueqiu-analyzer-skill`（旧） | `scripts/stock_fetcher_opencli.py`（`scripts/` 已标注 DEPRECATED） | `xueqiu stock`、`xueqiu comments` |
| **agent 会话 / 手敲** | 直接敲 `opencli …` | 任意命令 |

⚠️ **改 `fetcher_opencli.py` 会同时打到 monitor 与 analyzer 两个仓**——它是共享封装。

## 2. 命令契约

约定：`-f json` 输出的是一个 **JSON 数组**（`web article` 也是数组，取首元素）。下表 `字段` 指的是**数组元素**的键。

### 2.1 `opencli xueqiu user-articles`

| | |
|---|---|
| 入参 | `--user_id <value>`（**命名选项，不是位置参数**，必填，纯数字）、`--count`（int，默认 20，期望条数）、`--page`（int，默认 1）。⚠️ 本插件里**唯一**不用位置参数的命令 —— 别照 `comments` / `news` 的样子敲 |
| 输出字段 | `article_id`、`title`、`author`、`time`、`created_at`、`likes`、`replies`、`forwards`、`text`、`is_column`（bool）、`url` |
| 错误 | `ArgumentError`（user_id 非法）、`CommandExecutionError`（含风控页） |
| 消费者依赖 | `opencli_extractor.get_user_articles` 取 `article_id/title/author/time/likes/replies/url/text`；`crawler_nodriver` 另用 **`is_column`** 判断是否专栏（跳过非专栏是有意设计） |
| 备注 | `--count` 是**期望**值，实际返回可能更少（上游按屏返回） |

### 2.2 `opencli web article <url>`

| | |
|---|---|
| 入参 | `url`（位置参数，必填，**绝对 http(s) URL**）、`min-chars`（int，默认 300，容器命中阈值）、`selector`（可选，调试用） |
| 输出字段 | `url`、`title`、**`content`（markdown 全文）**、`selector`、`chars` |
| 错误 | `ArgumentError`（非绝对 URL）、`CliError('BLOCKED_WAF', …)`（**风控页，确定性信号，不要重试**） |
| 消费者依赖 | `opencli_extractor._attempt_via_adapter`、`monitor/src/detail_fetcher._opencli_article`：取 `title/content/selector` |
| 备注 | `content` **不在** `columns` 里（表格视图只显示 url/title/chars/selector），别拿 `columns` 当输出契约 |

### 2.3 `opencli xueqiu comments <symbol>`

| | |
|---|---|
| 入参 | `symbol`（位置参数，必填）、`limit`（int，默认 20，**上限 100**，超出抛 `ArgumentError`） |
| 输出字段 | `author`、`text`、`likes`、`replies`、`retweets`、`created_at`、`url` |
| 错误 | `AuthRequiredError`（`AUTH_REQUIRED`，需登录/过滑块）、`ArgumentError`（symbol 非法 / limit 非法）、`EmptyResultError`（`EMPTY_RESULT`）、`CommandExecutionError`（响应异常） |
| 消费者依赖 | `fetcher_opencli.fetch_discussions`：认 `EMPTY_RESULT` / `no data` 为**安静失败**（不记 source_failure） |

### 2.4 `opencli xueqiu stock-notices <symbol>`

| | |
|---|---|
| 入参 | `symbol`（位置参数，必填，**不接受 URL**）、`limit`（int，默认 20，上限 100） |
| 输出字段 | `title`、`type`、`created_at`、`url` |
| 错误 | `ArgumentError`、`EmptyResultError`（**未登录时该接口不可用**——提示先 `opencli auth login xueqiu`） |
| 备注 | symbol 归一化：6 位数字补 `SH/SZ/BJ` 前缀（`lib/xueqiu-symbol.js`），4–5 位补零 |

### 2.5 `opencli xueqiu news <symbol>`

| | |
|---|---|
| 入参 | `symbol`（位置参数，必填）、`limit`（int，默认 20） |
| 输出字段 | `id`、`title`、`text`、`source`、`created_at`、`link` |
| 错误 | `ArgumentError`、`CommandExecutionError`（风控页） |
| 消费者依赖 | `fetcher_opencli.fetch_news_with_status`：**显式判 list 类型** |

### 2.6 `opencli xueqiu replies <post_url>`

| | |
|---|---|
| 入参 | `post`（位置参数，必填，`https://xueqiu.com/<uid>/<status_id>`）、`limit`（int，默认 20） |
| 输出字段 | `id`、`author`、`text`、`likes`、`created_at`、`reply_to` |
| 错误 | `ArgumentError`（URL 形态不对）、`CommandExecutionError` |

### 2.7 ~~`opencli xiaohongshu search <query>`~~ —— **覆盖已移除（2026-10-13），改用官方基线**

| | |
|---|---|
| 现状 | 本插件**不再提供** `search.js`。命令仍然存在，由 opencli 官方基线提供 |
| 为什么移除 | 实测对比（同一关键词、同一账号、相隔 12 秒）：**官方基线正确识别风控并抛 `SECURITY_BLOCK`；我们的覆盖静默返回 `[]`（exit=0、stderr 空、台账记 `ok=True`）** —— 正是 `b9a3196` 声称修好、却在我们自己身上复现的那个坑。官方还多支持 `--sort`/`--note-type`/`--publish-time`/`--scope`/`--location` 五个筛选（靠筛选面板 UI 自动化实现，非 URL 参数），并带 MutationObserver 稳健性 |
| 治理不受影响 | 限频与台账由 `rate-limit.js` 的钩子按 **registry** 生效，与命令由谁实现无关。实测官方那次调用台账里 `throttled=True`，被正常记录 |
| 调用方 | **无仓库代码调用**；实际调用者是 agent 会话/手敲（见 §7） |
| 命令契约 | 以官方基线为准：`opencli xiaohongshu search --help`。⚠️ 输出列仍是 `rank,title,author,likes,published_at,url`，但 **`published_at` 语义变了** —— 官方是从 note-id 推出的日期（如 `2025-12-06`），我们那份是 DOM 卡片文本（如 `3天前`） |

> **不要再把它加回来**：唯一曾经占优的维度是"风控提示语认得多"，而实测证明那个优势不存在（我们反而漏了真实发生的一种）。若将来需要更宽的检测，正确做法是把模式**提给上游**，不是在本地重新长一份覆盖。

## 3. 错误码契约

opencli 的错误类带 `code`（插件台账的 `error_code`、Python 台账的 `error.code` 都是它）：

| 类 | `code` | 退出码 | 消费者该怎么处理 |
|---|---|---|---|
| `CliError(code, …)` | 自定义：**`BLOCKED_WAF`**（雪球 `web article` 命中风控页）、**`SECURITY_BLOCK`**（小红书 `search` 命中「安全限制 / 账号异常」页） | 由插件指定 | **确定性信号，不要重试**（重试只会对着刚被拦的页面再打）；它也是 `lib/cooldown.js` 的熔断触发码之一 |
| `BROWSER_CONNECT` | `BROWSER_CONNECT` | 69（SERVICE_UNAVAIL） | ⚠️ **可能是熔断器刻意拦下的**（它把 `OPENCLI_PROFILE` 指向不存在的 profile 让 routing 硬失败），**不是** daemon 挂了 —— 别重试、别当故障排查；先看 `~/.opencli/<域名键>-cooldown.json`。代价：这条路径约 45 秒才失败 |
| `CommandExecutionError` | `COMMAND_EXEC` | GENERIC_ERROR | 可重试 |
| `ArgumentError` | `ARGUMENT` | USAGE_ERROR | 别重试——参数错了，重试也一样 |
| `EmptyResultError` | `EMPTY_RESULT` | EMPTY_RESULT | 「成功但为空」，**不是故障**（health 判定要能区分） |
| `AuthRequiredError` | `AUTH_REQUIRED` | NOPERM | 需人工登录/过滑块 |
| `TimeoutError` | `TIMEOUT` | TEMPFAIL | 可重试 |

**stdout/stderr 契约**：调用方把 stdout 当 JSON 解析（`_clean_output` / `_clean_json` / `_strip_opencli_notice` 就是为此存在）。因此插件**绝不能往 stdout/stderr 写日志**——日志一律落文件（见 §4）。
> 例外：opencli 自己的升级提示由退出钩子打印在输出之后，消费者的三个清洗函数就是剥它的。

## 4. 行为契约（不是命令，但消费者依赖）

| 约定 | 内容 | 谁依赖 / 谁守着 |
|---|---|---|
| **超时预算** | 限速器的等待发生在 **opencli 子进程内部**，会被调用方 `subprocess.run(timeout=…)` 一并计时。最坏 = 取锁 2s + 长停 75s + 执行 ≈ **87s** | 调用方超时统一 120s：`opencli_extractor.py`、`fetcher_opencli.py`、`detail_fetcher.py`。crawler 侧有解析插件源码的双向守卫测试；monitor 侧见 §6 |
| **6 秒下限** | **内置站点策略**（尤其 `web`）的 `min_delay_s` 不得低于 6。⚠️ 这不是全站硬下限：`DEFAULT_POLICY` 兜底是 **3**，用户 `rate-limits.json` 也不受它约束 | `scripts/schedule-checks/peak.mjs` 用「6 秒下限 ⇒ 一分钟不可能超过 10 次」判定「限速器被绕过」；守护测试 `test_builtin_sites_declare_web_with_pacing` **只断言 `web`**（`xueqiu`/`xiaohongshu` 是恰好达标，不在该不变量覆盖内） |
| **并发闸** | 默认 `concurrency` 缺省 = **观测模式**（只记录不拦）。启用（`concurrency: 1/2/3`）前**必须**把调用方超时抬到 ~150s | `lib/concurrency.js` 文件头 + README；`test_concurrency_gate_defaults_to_observe_only` |
| **两份台账** | 插件台账 `~/.opencli/adapter-calls.jsonl` = 传输层真相；Python 台账 `~/.opencli/xueqiu-calls.jsonl` = 调用方意图与结局。用 `ppid` 或 `XUEQIU_OPENCLI_CALL_ID` join | `lib/requestlog.js` 文件头 |
| **hook 注册** | `rate-limit.js` 必须保留 `onBeforeExecute(` 字样，否则 discovery 不加载它 → **整套限速与台账静默消失** | `tests/test_opencli_adapter_plugin_integrity.py` |
| **调用方标识** | 插件读继承来的 `XUEQIU_CALL_SOURCE` 归因；不设则记 `manual` | 各仓入口（见 §7） |

## 5. 数据与文件

| 路径 | 内容 | 谁写 |
|---|---|---|
| `~/.opencli/<域名键>-throttle.json` | 限频排期 `{next_at, calls, last_source}` | 插件 |
| `~/.opencli/inflight/<域名键>/*.slot` | 在飞槽位（观测模式下也占位） | 插件 |
| `~/.opencli/<域名键>-cooldown.json` | **风控熔断**状态 `{until_ms, level, reason, last_trip_ms, trips}`（`lib/cooldown.js`）：命中 `RISK_CODES` 后该站点在冷却期内发不出请求，指数退避 1h→2h→…→24h，距上次命中超 `decay_s` 则 level 归零 | 插件 |
| `~/.opencli/adapter-calls.jsonl` | 插件台账（schema 2）。被熔断拦下的调用记 `cooldown_active` / `skip_reason: cooldown_active` —— **它没发出任何请求**，统计站请求量时要剔除 | 插件 |
| `~/.opencli/rate-limits.json` | 用户策略覆盖（`sites` / `domains` / `defaults`；`cooldown` 可每键覆盖，未声明键走默认：开、1h 起、24h 封顶） | 用户 |

⚠️ **冷却只对「有限速策略的键」真正生效**：`cooldownRemainingMs` 的检查点在该键的
`policyForCall` 返回**之后**，所以**未声明**的键会写出一份
`<域名键>-cooldown.json`（台账也记 `cooldown_tripped_until_ms`），但下一次调用照打
不误 —— 那些站点本就不限速。`~/.opencli/rate-limits.json` 注记里的「所有站点默认开启」
指**冷却的默认参数**，不是「所有站点都会被拦」。

⚠️ **哪些命令会武装熔断**：只有抛出 `RISK_CODES`（`RATE_LIMITED` / `SECURITY_BLOCK` /
`BLOCKED_WAF`）的命令。目前雪球侧**只有 `web article`**（`article.js` 抛 `BLOCKED_WAF`）；
`news` / `replies` / `user-articles` 命中挑战页抛的是 `COMMAND_EXEC`、`comments` 抛的是
`AUTH_REQUIRED`，**都不在 `RISK_CODES` 里**。这是**已知的不对称**：列表类命令撞上挑战页
时熔断不会武装（`comments.js` 的检测器是自写正则、未并入同源同步，拿它去开域级开关的
风险大于收益 —— 见该文件里的注释）。

## 6. 改动检查表

**改任何东西之前先读这张表；改完必须让 §8 的验证全绿。**

| 你要做的改动 | 必须一起改 | 会被哪条测试拦住 |
|---|---|---|
| 改**输出字段名** | 所有消费方解析处（§2 各命令的「消费者依赖」行）+ `CONTRACT.md` 本节 | ⚠️ **没有自动检查**（见 §7 盲区） |
| 改**命令名** | `scripts/analyze_opencli_usage.py` 的 `SITE_OPERATIONS`（**有测试守**）+ `install.sh` 的校验清单 + README 文件表（**无自动检查，靠人**） | `tests/test_opencli_command_names.py`（只覆盖 `SITE_OPERATIONS` 那半边；漏改 `install.sh` 它不会红，要到执行 `install.sh` 时才退出 1） |
| 改**错误码/错误类** | 消费方的 `BLOCKED_WAF` / `EMPTY_RESULT` / `风控验证页` 判定 | ⚠️ 无自动检查 |
| 改**节流参数**（`min/max/long_pause`） | 三个仓的调用方超时（`opencli_extractor.py` / `fetcher_opencli.py` / `detail_fetcher.py`） | 本仓 `test_plugin_policy.py` + 后续消费方契约测试 |
| 改**`min_delay_s`** 低于 6 | `peak.mjs` 的 `PEAK_IMPOSSIBLE` 判据 | `test_builtin_sites_declare_web_with_pacing` |
| 启用**并发闸** | 调用方超时 120 → ~150s（两个仓） | `test_concurrency_gate_defaults_to_observe_only` |
| 改**域名别名表** | 已有键必须映射回自己（换名 = 排期清零） | `test_known_domains_alias_back_to_their_existing_keys` |
| 改**符号归一化** | `news.js` / `stock-notices.js` 共用 `lib/xueqiu-symbol.js` | `test_opencli_adapter_symbols.py` |
| 加/删 `lib/` 模块 | 入口 import + README 文件表 + `CONTRACT.md` §5 | `test_opencli_adapter_plugin_integrity.py` |
| 改**上游副本**（`utils.js`、`article.js` 去噪段） | 与 `@jackwener/opencli` 对照 | `check-drift.sh`（**不在 CI**，要手动跑） |

## 7. 已知盲区（诚实清单）

1. **`browser …` 子命令不经钩子** → 不受限频/并发/台账管辖。它占实际调用量的 **~54%**（monitor 抓正文的一条主路）。上游 [jackwener/opencli#2606](https://github.com/jackwener/OpenCLI/issues/2606)。
2. **输出字段改名没有自动检查** → 会静默让消费方拿到空值。这是本文件存在的首要原因。
3. **不设 `XUEQIU_CALL_SOURCE` 的调用** → 台账里记 `manual`，与实际手敲无法区分。已知有两个来源：**agent 会话**（批量抓取）与**不在册的脚本**。`analyze_opencli_usage.py` 把它们聚合成「管理外流量」，靠两条腿：**长驻进程按 `ppid` 聚簇**，**每次调用各起一个 shell** 的散点再**按「域名/命令」聚合**一次。两条腿都不完美——前者看不见逐条敲的会话（ppid 每次不同），后者认不出「是不是同一轮任务」，只说明「同一拨目标被打了 N 次」。
4. **`XUEQIU_OPENCLI_CALL_ID` 目前无人设置** → 两账 1:1 join 的机制空转，实际靠 `ppid` + 时间窗。
5. **`check-drift.sh` 不在 CI** → 升级 `@jackwener/opencli` 后要人记得手动跑。
6. **`xiaohongshu search` 在仓库里没有调用方** → 它唯一的真实消费者是 agent 会话/手敲，属于「在用但不在册」。（2026-10-13 起该命令由**官方基线**提供，本插件不再覆盖 —— 见 §2.7。这条盲区因此更隐蔽：它的实现根本不在我们仓里。）

## 8. 改完之后怎么验证

```bash
ruff check . && ruff format --check . && python3 -m pytest tests/ -q
python3 scripts/sync_waf_patterns.py --check
./check-drift.sh  # 要本机安装 opencli
```

消费者仓和运行中插件的切换验证，等后续迁移阶段执行；本仓 CI 不会触碰消费者工作区或用户安装。
