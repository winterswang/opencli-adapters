# xueqiu-analyzer-skill 解散方案（代码回归各自项目）

> **给新会话的用法**：这份文件是自包含的作业指导。开新对话后，把本文件路径交给它，
> 让它**先读 §1（现状尽调）与 §3（决策点）**，与你确认决策后再按 §5 逐步执行。
> 文中所有路径、行号、依赖关系、活跃度数据均于 **2026-10-12** 在本机核实过。
>
> 状态：**待评审，尚未执行。** 起草人：上一轮会话（已完成 `opencli-adapters` 独立建仓）。

---

## 0. 一句话

`xueqiu-analyzer-skill` 现在只剩 **5 个模块（1182 行）还有别的项目在依赖**，其余约
**6200 行**（整套"输入股票代码 → 出投资报告"的分析流水线）已经闲置 —— 把这 5 个模块送进新
归宿、把其余归档，然后**废掉这个仓**。

---

## 1. 现状尽调（已核实）

### 1.1 这个仓是什么

- 位置：`~/code/claude_code/xueqiu-analyzer-skill`（GitHub: `winterswang/xueqiu-analyzer-skill`，public）
- 内容：`src/xueqiu_analyzer/` 共 23 个模块 **8436 行**；`pyproject.toml` 名 `xueqiu-analyzer` v3.0.0；
  console script `xueqiu`；运行依赖只有 `playwright / pyyaml / click`
- 另有：`scripts/`（372K，V2 遗留，已由 `DEPRECATED.md` 声明废弃）、`prompts/`、`plans/`、
  `config/`、`data/`（2.4M，历次报告产出）

### 1.2 它现在是"死的"还是"活的"（关键判断）

| 用法 | 状况 | 证据 |
| --- | --- | --- |
| 当**分析工具**（`xueqiu analyze <symbol>` 出报告） | **已闲置 4 个月** | `data/` 里最后一份产出是 `PDD_report_20260610_015224.md`（2026-06-10）；之后无新产出；无任何定时任务（LaunchAgents / crontab 里都没有它） |
| 它**自己发起**的 opencli 调用 | 最后一次 2026-10-08 | 台账 `~/.opencli/xueqiu-calls.jsonl`，`source=xueqiu-analyzer:probe_volume.py`，累计仅 19 条 |
| 当**底层零件**被别的项目 import | **每天在用** | crawler 今天 08:14、monitor 今天 18:15 都还在经它发调用；插件仓的 WAF 正则也由它生成 |
| 代码是否还在改 | 是 | 今天（2026-10-12）还有 2 个提交（`#41`/`#42`，opencli 超时与调用方标识） |

**结论**：报告功能死了，但"风控判定 / 限速 / 台账 / opencli 调用封装 / IMA 上传"这五件事
是活的，且是别的项目的刚需。

### 1.3 谁在用它的哪些模块（全量，已 grep 核实）

| 模块 | 行数 | 谁在用（带位置） |
| --- | --- | --- |
| `waf.py` | 192 | **crawler**：`scripts/waf_bridge.py:46`（经它再被 `crawler_nodriver.py`、`generate_report.py`、`opencli_extractor.py` 使用）；**插件仓**：`scripts/sync_waf_patterns.py` 由它生成插件内的 `BLOCK_GUARD` |
| `opencli_rate_limiter.py` | 178 | **crawler**：`scripts/opencli_extractor.py:34`；**monitor**：`src/detail_fetcher.py:46`；另有 crawler 测试直接 import 私有 `_should_throttle`（`tests/test_analyze_opencli_usage.py:114`） |
| `opencli_call_logger.py` | 160 | **crawler**：`scripts/opencli_extractor.py:33` + 测试用私有 `_operation`（`tests/test_analyze_opencli_usage.py:113`）；**monitor**：`src/detail_fetcher.py:45` |
| `fetcher_opencli.py` | 326 | **monitor**：`src/cli.py:260,334`（`fetch_news_with_status` / `fetch_replies`）；5 个 monitor 测试以 `sys.modules` 打桩它 |
| `ima_kb_uploader.py` | 326 | **crawler**：`scripts/sync_raw_articles_to_ima.py:32`；**monitor**：`scripts/upload_announcement_sources_to_ima.py:39` |
| 其余 18 个模块（约 6200 行）<br>（`cli/stock_analyzer/crawler/crawler_nodriver/extractor/orchestrator/models/quality/evaluator/analyzer/llm_client/content_grader/csv_exporter/financial_fetcher/sec_fetcher/token_utils/ima_publisher/config`） | ~6200 | **零外部引用**（只有本仓自己的测试和彼此互相引用） |

**依赖闭合性（这是本次迁移能干净落地的关键）**：

- `waf.py`、`opencli_rate_limiter.py`、`opencli_call_logger.py`、`ima_kb_uploader.py`
  **只依赖标准库**，零内部依赖；
- `fetcher_opencli.py` 只 import 上面三个（`.waf` / `.opencli_call_logger` / `.opencli_rate_limiter`）。
- 即：**要搬的东西是闭包的，不会拖着分析流水线一起走**。

### 1.4 消费方现在的接线方式（搬完要一起拆掉）

| 消费方 | 接线 | 位置 |
| --- | --- | --- |
| crawler | `XUEQIU_ANALYZER_PATH` 环境变量 → 否则同级 checkout 的 `../xueqiu-analyzer-skill/src` | `scripts/waf_bridge.py:30-43` |
| crawler CI | checkout + `pip install -e _deps/xueqiu-analyzer-skill` | `.github/workflows/tests.yml:41-57` |
| monitor | `_ensure_xueqiu_analyzer_path()` + 配置项 `crawler.xueqiu_analyzer_path` + 环境变量 `XUEQIU_ANALYZER_PATH` | `src/crawler.py:22-38`、`src/config.py:33-34,115-116`、`src/cli.py:259,333` |
| monitor CI | checkout + install + 注入 `XUEQIU_ANALYZER_PATH` | `.github/workflows/tests.yml` |
| 插件仓 | `pyproject.toml` 的 `waf-pattern-source` + `scripts/sync_waf_patterns.py` 读它；CI checkout 它（ref 固定 `b9a3196`） | `opencli-adapters` |

### 1.5 ⚠️ 前置阻塞：这个仓的 git 是坏的

`xueqiu-analyzer-skill` 的 **index 指向对象库里不存在的 blob**：

```
$ git -C ~/code/claude_code/xueqiu-analyzer-skill diff
fatal: unable to read d961ce5507c6c3f71ec8ef0e6e2476e82db17763
```

该 blob 是 `src/xueqiu_analyzer/opencli_rate_limiter.py` 在 index 里的版本。后果：
**`git diff` / `git diff --cached` / `git stash` 全部失败**，无法生成迁移前的干净参考点。
另外该仓还带着**两个不是本次产生的已暂存改动**（`M PROJECT_LOG.md`、`MM opencli_rate_limiter.py`）
—— 说明之前有别的会话在那里暂存过东西，但暂存的内容已经取不出来了（blob 缺失）。

**必须先修**（见 §5 的 S1），否则整个迁移没有可回滚的基点。

---

## 2. 目标与完成定义

完成 = 下面 5 条同时成立：

1. 上面 5 个模块有了**唯一归宿**，且**任何地方都不存在第二份可编辑副本**。
2. `xueqiu-analyzer-skill` 仓里**没有任何代码被其他仓 import**；它的 GitHub 仓已 archive，
   README 指向新归宿。
3. crawler / monitor / 插件仓里，`XUEQIU_ANALYZER_PATH`、同级 checkout、`_ensure_xueqiu_analyzer_path`、
   `pip install -e _deps/xueqiu-analyzer-skill` 这类**临时接线全部删除**，改为正常依赖。
4. 搬迁前后的行为**逐字节等价**：插件 `BLOCK_GUARD` 生成结果不变；限速/台账语义不变。
5. 三仓 + 新归宿的测试全绿。

---

## 3. 决策点（**执行前必须先与用户确认这几条**）

### D1（最重要）4 个 opencli 治理模块的归宿

| 方案 | 说明 | 代价 |
| --- | --- | --- |
| **A1（推荐）放进插件仓 `opencli-adapters` 的 Python 子包**（如 `python/`，包名待定） | 插件仓本来就是"opencli 通道"的唯一归属；`waf.py` 是插件 `BLOCK_GUARD` 的上游规则源，搬进去后**该仓自包含，跨仓构建依赖消失**；限速器/台账的 JS 版就在同一仓，Python 版放在旁边，语义同处一室；crawler 的 CI 已经 checkout 这个仓（守卫测试用），可复用同一个 checkout | 插件仓变成"JS 插件 + Python 包"的混合仓；仓的定位要写清楚 |
| A2 放进 crawler 仓，monitor 依赖 crawler | 避免混合语言仓；crawler 是最大使用方 | monitor 要依赖一个"应用仓"（而非库仓），是新的耦合方向；插件仓生成 `BLOCK_GUARD` 时要 checkout crawler（比现在的 analyzer checkout 更重） |
| A3 新建一个小共享仓（如 `xueqiu-opencli-py`） | 职责最干净 | 与"减少仓、消重叠"的意图相反 |
| A4 各自复制 + 逐字节漂移守卫 | 最省事 | 限速器/台账出现两份，正是本次会话刚花力气消除的病；守卫成本接近共享 |

**推荐 A1。** 注意 `waf.py` 必须始终是**唯一实现**：搬进插件仓后，插件内的
`BLOCK_GUARD` 仍是"由它生成"的副本，不能反过来变成事实来源（这是既有不变量，见
`opencli-adapters/CONTRACT.md`）。

### D2 `ima_kb_uploader.py`（326 行，crawler 与 monitor 各用一处）的归宿

- **B1（推荐）与 4 个治理模块放进同一个共享包** —— 一次接线，两个消费方都改成正常依赖；
  它在语义上是"把内容发布到 IMA 知识库"，与 opencli 通道无关，所以包名别只叫 opencli（见 D4）。
- B2 两个消费仓各复制一份 —— 重复风险较低（纯 HTTP 上传器），但仍是两份。
- B3 只给一个仓（比如 crawler），另一个改成依赖它 —— 引入 crawl→monitor 或反向依赖，不建议。

### D3 闲置代码与资产怎么处理

- **C1（推荐）打 tag `archive/v4.3.7` → 在 main 上删除 → GitHub 仓 archive（只读）+ README 指路。**
  tag 里保留全部历史与 `data/` 报告，所以"删"是可逆的。
- C2 只打 tag 不删，仓也不 archive —— 不符合"遗弃"目标，且会持续误导后来者。
- C3 把 `data/` 里的历史报告**另存**到别处再删仓 —— 若这些报告还有价值，在 C1 之外单独加一步。

### D4 包名与 import 路径是否保留 `xueqiu_analyzer`

- **推荐保留模块名、只换宿主。** 原因：crawler / monitor 里有大量 `from xueqiu_analyzer.xxx import …`
  与 `sys.modules["xueqiu_analyzer.fetcher_opencli"]` 打桩（monitor 5 个测试文件），改名会把这些
  全部拖下水，收益只是好看。
- 若 D1 选 A1，则包里只保留 5 个模块；**不要让包名暗示它还是"分析器"** —— 建议包名如
  `xueqiu_governance`（或 D2 选 B1 时叫更能涵盖 IMA 的名字），但**模块名保持**
  `waf` / `opencli_rate_limiter` / `opencli_call_logger` / `fetcher_opencli` / `ima_kb_uploader`。
  ⚠️ 若换包名，`from xueqiu_analyzer.waf import …` 这类 import 与 `sys.modules` 打桩**都要跟着改** ——
  这是本方案里"最容易被漏掉、且漏了会静默跳过"的一处，见 §7。

### D5 analyzer 的 git 破损怎么修（S1 的具体做法）

- **D5-1（推荐）`git reset`（mixed）**：只重置 index，磁盘文件不动。代价：失去两个文件"已暂存"
  的状态，且那份暂存内容本就已取不出来（blob 已缺失，等于已经丢了）。
- D5-2 先尝试从其它克隆 / reflog / 备份里找回该 blob 再决定 —— 只有在那两个暂存改动确实重要时
  才值得。
- D5-3 `git fsck` 全量体检 + 重新 clone（若发现不止一个缺失对象）。

---

## 4. 归属矩阵（决策后的执行结果）

| 对象 | 去向 |
| --- | --- |
| `waf.py`、`opencli_rate_limiter.py`、`opencli_call_logger.py`、`fetcher_opencli.py` | D1 选定的共享归宿（推荐：`opencli-adapters/python/`） |
| `ima_kb_uploader.py` | D2 选定（推荐：同包） |
| 随模块一起走的测试：`tests/test_waf.py`、`test_opencli_rate_limiter.py`、`test_opencli_call_logger.py`、`test_fetch_news_status.py`、`test_source_fail_rotation.py`、`test_ima_kb_uploader.py` | 与对应模块同去 |
| 其余 18 个模块 + 12 个测试文件（`test_content_grader / test_crawler / test_crawler_nodriver_waf / test_csv_exporter / test_evaluator / test_extractor / test_ima_publisher / test_modules / test_param_modes / test_quality / test_sec_fetcher / test_token_utils`） | 归档（tag）后删除 |
| `scripts/`（V2 遗留）、`prompts/`、`plans/`、`config/`、`data/` | 归档（tag）后删除；`data/` 的历史报告如需另存见 D3-C3 |
| crawler 的 `XUEQIU_ANALYZER_PATH` / 同级 checkout 机制、CI 的 analyzer checkout | 删除，改为依赖共享包 |
| monitor 的 `_ensure_xueqiu_analyzer_path()`、`crawler.xueqiu_analyzer_path` 配置、CI 的 analyzer checkout 与 `XUEQIU_ANALYZER_PATH` | 同上 |
| 插件仓的 `waf-pattern-source`（跨仓路径）与 CI 的 analyzer checkout | 改为仓内路径，checkout 删除 |

---

## 5. 执行步骤（每步都带验收判据与回滚）

> 通用纪律：**每一步单独提交**；每一步做完就跑该步的判据；判据不过就 `git revert` 该步。

### S1（前置）修 analyzer 的 git 索引

```bash
cd ~/code/claude_code/xueqiu-analyzer-skill
cp -r .git /tmp/analyzer-git-backup-$(date +%Y%m%d)   # 先备份 .git，再动手
git reset                                              # 按 D5 选定；只重置 index
```

**判据**：`git status --short` 正常输出；`git diff --stat` 不再报 `unable to read`；
`git log -1` 与 `git rev-parse HEAD` 正常。
**回滚**：用备份覆盖 `.git`。

### S2 建新归宿并搬 4+1 个模块（依赖 D1/D2）

1. 在选定仓里建包目录与 `pyproject.toml`（D1 选 A1 时：`opencli-adapters/python/`）。
2. 搬入 5 个模块（**保持模块名**，见 D4）+ 6 个对应测试文件。
3. 若 D1 选 A1：把 `opencli-adapters/scripts/sync_waf_patterns.py` 的规则源从
   `_deps/xueqiu-analyzer-skill/src/xueqiu_analyzer/waf.py` 改为**仓内**路径，
   并删掉插件仓 CI 里的 analyzer checkout。

**判据**：
- 新包内 `pytest` 全绿；
- `python3 scripts/sync_waf_patterns.py --check` 退出 0，且输出仍报
  **16 个模式、4 个文件**（证明 `BLOCK_GUARD` 生成结果逐字节未变）；
- `git diff` 显示搬入的模块与原文件**逐字节一致**（用 `shasum -a 256` 比对，唯一允许的差异是
  包内相对 import 的路径）。
**回滚**：删除新包目录即可（此步不改消费方）。

### S3 crawler 切换到新归宿

改：`scripts/waf_bridge.py`（删 `analyzer_src_path()`/`XUEQIU_ANALYZER_PATH`/同级 checkout，
改为直接 import 新包）、`scripts/opencli_extractor.py:33-34`、`scripts/sync_raw_articles_to_ima.py:32`、
`tests/test_analyze_opencli_usage.py:113-114`（保留私有函数名 `_operation`/`_should_throttle`，
否则要一并改测试）、CI 的 analyzer checkout 与 `pip install -e`。

**判据**：`ruff check . && ruff format --check . && python3 -m pytest tests/ -q` 全绿，
且**计数与迁移前一致（246 passed, 1 skipped）**；`git grep -n xueqiu_analyzer` 在本仓为空。
**回滚**：`git revert`。

### S4 monitor 切换到新归宿

改：`src/detail_fetcher.py:45-46`、`src/cli.py:259-260,333-334`、`src/crawler.py:22-38`（**删掉
`_ensure_xueqiu_analyzer_path` 与 `_DEFAULT_XA`**）、`src/config.py:33-34,115-116`（删配置项）、
`scripts/upload_announcement_sources_to_ima.py:39`、5 个打桩测试（`sys.modules` 的键名按 D4 改）、
`tests/test_opencli_path.py`（若它专门测路径注入机制则随之删除）、CI。

**判据**：`TZ=Asia/Shanghai python3 -m pytest tests/ -q` 全绿，且计数与迁移前一致（**398 passed**）；
`git grep -n xueqiu_analyzer` 在本仓为空。
**回滚**：`git revert`。

### S5 全量门控（见 §6）

### S6 归档 analyzer

```bash
cd ~/code/claude_code/xueqiu-analyzer-skill
git tag -a archive/v4.3.7 -m "归档：代码已回归各自项目，见 <新归宿>"
git push origin archive/v4.3.7
# 在 main 上删除已迁走的代码与资产（scripts/ prompts/ plans/ config/ data/ src/ tests/）
# 改 README 为指路说明（一句话：本仓已废弃，代码去了哪、为什么）
gh repo archive winterswang/xueqiu-analyzer-skill --yes
```

**判据**：`gh repo view winterswang/xueqiu-analyzer-skill --json isArchived` 为 true；
三个消费仓与新归宿的测试仍全绿（它们不应再引用该仓）。
**回滚**：`gh repo unarchive` + `git revert` 删除提交（tag 仍在，代码可完整恢复）。

### S7 收尾

- 清理 `opencli-adapters/CONTRACT.md` / `README.md` / 用户级 Skill 里对 analyzer 跨仓路径的描述
  （迁移后 `waf.py` 在仓内）。
- 更新各仓 `PROJECT_LOG.md` / 迁移文档里的指路。

---

## 6. 验收门控

| 门 | 命令 | 通过判据 |
| --- | --- | --- |
| G0 等价性 | 搬迁前后对搬入模块做 `shasum -a 256` 比对；`sync_waf_patterns.py --check` | 逐字节一致；仍报 16 模式 4 文件 |
| G1 新归宿 | `ruff check` / `ruff format --check` / `pytest`（新包） | 全绿 |
| G2 crawler | `ruff check . && ruff format --check . && pytest tests/ -q` | **246 passed, 1 skipped** |
| G3 monitor | `TZ=Asia/Shanghai pytest tests/ -q` | **398 passed** |
| G4 插件仓 | `ruff check . && ruff format --check . && sync_waf_patterns.py --check && pytest tests/ -q` | 全绿（**14 passed**）+ WAF 对账通过 |
| G5 残留引用 | 三仓 + 插件仓 `git grep -n "xueqiu_analyzer\|XUEQIU_ANALYZER_PATH\|xueqiu-analyzer-skill"` | **为空**（历史文档除外） |
| G6 运行时 | monitor 下一轮 pipeline 跑过一次 | 消费方台账出现新调用且 `ok: true`，插件台账无新增错误码 |

> G2/G3 的"计数一致"是刻意的：搬迁不该改变任何测试的数量。若数量变了，说明有测试被漏掉或被静默跳过。

---

## 7. 不变量与风险

**不变量（违反了就是错的）**

1. `waf.py` 是风控判定的**唯一实现**；插件里的 `BLOCK_GUARD` 只能是它生成的副本。
2. 限速器与台账的**语义跨仓一致**（crawler 与 monitor 必须用同一份，"各自一份"= 回归到本次
   会话刚修掉的病）。
3. 搬迁**不改变**任何命令契约、输出字段、限速参数。

**风险**

- **静默跳过（最需要防的一条）**：monitor 有 5 处用 `sys.modules["xueqiu_analyzer.fetcher_opencli"]`
  打桩。若 D4 换了包名而漏改，打桩会**假装成功**（打到一个不存在的模块上不影响真实 import），
  测试仍然绿，但测的东西已经不是被测对象。→ 每个改包名的步骤都要**故意破坏一次**验证它会红。
- **`_operation` / `_should_throttle` 这类私有函数被消费方测试直接使用**：搬迁时若顺手改名，
  crawler 测试会红 —— 这是好事（能发现），但要预留改测试的成本。
- **monitor 的路径注入机制删除后，本地/CI 必须先装包**：需要明确安装方式（`pip install -e <归宿>/python`
  或 CI 里 checkout + install），否则 monitor 一跑就 `ImportError`。这是本方案唯一会**改变开发环境
  前置条件**的地方。
- **插件仓变混合语言仓**：CI 要加 Python 门；`README`/`CONTRACT` 要写明它现在同时提供 Python 侧。
- **归档顺序**：必须**先**让三个消费方全部切完（S3/S4/S5 通过）**再** archive 仓库，
  否则 CI 会在中间态红。

---

## 8. 本次不做

- 不改任何抓取/监控行为，不动 opencli 命令契约、限速参数、台账字段。
- 不复活分析流水线（若将来要用，从 `archive/v4.3.7` tag 里取）。
- 不处理三个消费仓各自与本迁移无关的既有问题（例如 analyzer 那个缺失 blob 的历史成因）。
