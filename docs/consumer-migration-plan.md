# 第二阶段迁移方案：把消费方与用户级 Skill 切到独立仓

> 状态：**大部分已执行**（2026-10-12）。
>
> - 第一阶段（提取独立仓、插件 ID 更名）已完成并推送：`72250de` / `4bcb59c` / `b9a3196`，
>   GitHub `winterswang/opencli-adapters`，CI 已绿。
> - §6 的 S1–S6 已执行：建远端、路径解析器与三条守卫、crawler 5 个 + monitor 1 个守卫测试改接、
>   删除本仓副本与 `sync_waf_patterns.py`（含其测试）、两个 CI 增 checkout（ref 固定）、
>   用户级 Skill 更新 4 处。门控 **G0–G3 全过**：crawler 246 passed、monitor 398 passed、
>   analyzer 288 passed、本仓 14 passed；7 条命令注册正常。
> - **尚未完成**：(a) 消费方改动**尚未提交**（crawler 38 项、monitor 5 项、analyzer 3 项）；
>   (b) **G4 的真实调用验证**要等下一轮 monitor pipeline —— 2026-10-12 的窗口是 14:20–18:15，
>   而插件切换发生在 19:15 之后，当天已无 pipeline 可验证，下一轮约在次日 14:00；
>   (c) analyzer 仓的 git 索引损坏（见解散方案 §1.5），那边提交不了。
> - 两个待定决策：消费方改动是否提交；用户级 Skill **目录名**是否改为 `opencli-adapters`
>   （内容已改，名字未动）。
>
> 本方案只管**引用收口**，不改插件行为、不改任何命令契约。

## 0. 完成定义

迁移完成 = 下面 5 条同时成立：

1. 全机只有**一份**可编辑的插件源码（本仓），不存在第二份会被误改的副本。
2. 所有「先读契约」「要改哪里」的入口（用户级 Skill、各仓注释、docs）都指向本仓。
3. 三个消费仓的守卫测试从本仓取源码，且**改错会红** —— 不是跳过、不是读副本。
4. 运行中的插件来源可判定：`~/.opencli/plugins/opencli-adapters` → 本仓，且锁定到具体 commit。
5. 切换后至少有一轮**真实消费方调用**，插件台账与消费方台账均无新增错误码。

## 1. 基线事实（2026-10-12 核对，作为回滚锚点）

| 项 | 实测值 |
| --- | --- |
| 运行中的插件 | `~/.opencli/plugins/opencli-adapters` → `/Users/wangguangchao/code/opencli-adapters` |
| 锁定 commit | `a5fecba`（`~/.opencli/plugins.lock.json`，installedAt 2026-10-12T11:15:46Z） |
| 旧 ID | `xueqiu-adapters` 已卸载；`~/.opencli/clis/` 为空 |
| 代码一致性 | 22 个 `.js`（含 `lib/*`、`search.js`）与 crawler 副本 **SHA-256 一致** |
| 已知差异 | `opencli-plugin.json`（更名）、本仓新增 `package.json`/`pyproject.toml`/`scripts/`/`tests/`、5 个文档脚本的路径与命名 —— 全部可列举，无计划外漂移 |
| 本仓自测 | ruff / ruff format --check / WAF 对账（16 模式 4 文件）/ pytest **14 passed** |
| 新仓远端 | **无**（`git remote -v` 为空）→ CI 不会跑，`release.yml` 永不触发 |

## 2. 待收口的引用清单（已逐条核实）

### 2.1 有真实路径依赖（必须改，否则断或假绿）

| 位置 | 现状 | 目标 |
| --- | --- | --- |
| `xueqiu-crawler/tests/test_opencli_command_names.py:24` | `PLUGIN_DIR = parent.parent / "opencli-adapters"` | 走统一路径解析 |
| `xueqiu-crawler/tests/test_opencli_adapter_plugin_integrity.py:25` | 同上 | 同上 |
| `xueqiu-crawler/tests/test_opencli_adapter_symbols.py:25` | 同上 | 同上 |
| `xueqiu-crawler/tests/test_opencli_adapter_domains.py:23` | 同上 | 同上 |
| `xueqiu-crawler/tests/test_opencli_throttle.py:23` | 同上 | 同上 |
| `xueqiu-monitor/tests/test_opencli_contract.py:25` | `PLUGIN_DIR = CRAWLER / "opencli-adapters"`，**CI 中自动 skip** | 走统一路径解析；同时让 CI 能真跑（见 2.4） |
| `xueqiu-crawler/scripts/sync_waf_patterns.py:29` | `ADAPTERS_DIR = parent.parent / 'opencli-adapters'` | **删除该脚本** —— 生成器整套职责已搬到本仓 `scripts/sync_waf_patterns.py`，留一份会再次分叉 |

### 2.2 仅注释 / docstring 指向旧路径（不致命，但会误导下一代 agent）

- `xueqiu-crawler/scripts/analyze_opencli_usage.py:54`、`scripts/opencli_extractor.py:12/59/65/125/238`
- `xueqiu-monitor/src/detail_fetcher.py:371/449/510`、`src/opencli_budget.py:6`、`tests/test_opencli_budget.py:26`
- `xueqiu-analyzer-skill/src/xueqiu_analyzer/waf.py:32/182`、`opencli_rate_limiter.py:4/53/92`、`fetcher_opencli.py:124`、`opencli_call_logger.py:34`
- `xueqiu-analyzer-skill/PROJECT_LOG.md:229/245/448`（历史日志，建议**只增不改**：追加一条迁移记录，不改旧条目）
- `xueqiu-crawler/docs/opencli_adapters_extraction_plan.md`（第一阶段方案，历史存档：加一行「已执行，见本仓 docs/」即可）

### 2.3 用户级 Skill（不在任何仓里，单独改）

`~/.claude/skills/xueqiu-adapters/SKILL.md` 四处失真：

1. `description` 的触发场景写「改 `xueqiu-crawler/opencli-adapters/` 下任何文件」→ 应为本仓。
2. 正文「`~/.opencli/plugins/xueqiu-adapters` 是指向 `<repo>/opencli-adapters/` 的符号链接」→ ID 已改为 `opencli-adapters`，指向本仓。
3. 「`xueqiu-crawler/opencli-adapters/CONTRACT.md` 是唯一权威」→ 权威已搬到本仓 `CONTRACT.md`。
4. 「改完必须做」四行验证命令 → 前三行里 crawler/monitor 的插件守卫已收归本仓，第四行 `cd xueqiu-crawler/opencli-adapters && ./check-drift.sh` 路径失效（本仓自带 `check-drift.sh`）。

**附一个待你定的点**：Skill 目录名是否也从 `xueqiu-adapters` 改为 `opencli-adapters`。建议改 ——
留着旧名等于把「两个名字指同一个东西」的混淆原样保留；改名只需同步 grep 一遍引用它的地方。
（若改，属于本方案内的一次独立改动，不与其它改动混提。）

### 2.4 CI（删除副本后必须同步，否则 CI 红）

| CI | 现状 | 需要的改动 |
| --- | --- | --- |
| `xueqiu-crawler/.github/workflows/tests.yml` | 只 checkout analyzer（`_deps/xueqiu-analyzer-skill`） | 增 checkout 本仓到 `_deps/opencli-adapters`（固定 ref），否则 5 个测试找不到源码 |
| `xueqiu-monitor/.github/workflows/tests.yml` | 只 checkout analyzer | 同上，可选；不做则那条守卫继续在 CI 里 skip（但本地必须真跑） |
| `xueqiu-analyzer-skill` | 无插件路径依赖 | 无需改 |

## 3. 路径解析机制（本方案的核心决定）

新增环境变量 **`OPENCLI_ADAPTERS_DIR`**，解析顺序：

1. `OPENCLI_ADAPTERS_DIR`（显式指定，测试与临时验证用）
2. 兄弟目录 `../opencli-adapters`（本机多仓并排的现状，零配置可用）
3. `_deps/opencli-adapters`（CI checkout 用）

**必须集中在一处实现**（建议 crawler 的 `tests/conftest.py` 里加一个 `plugin_dir()` fixture；
monitor 侧同理），不要 5 个测试各抄一遍 —— 那只会制造下一个漂移点。

**三条配套守卫**（不做这三条，迁移完还是假绿灯）：

| 守卫 | 判据 | 为什么 |
| --- | --- | --- |
| 解析失败即 fail（不是 skip） | 解析到的目录不存在 / 不含 `.js` → 直接红 | 现状是 skip，路径一断就静默变「没这条测试」 |
| 禁止指向仓内副本 | 解析结果不得落在 `<repo>/opencli-adapters` 之下 | 防回归：删了副本后有人再塞一份，守卫要红 |
| 身份校验 | 解析结果的 `opencli-plugin.json.name == "opencli-adapters"` | 防「拿到了旧 ID 的那份」 |

**注意语义变化**：monitor 的 `test_opencli_contract.py` 现在 CI 里是 skip；改为 fail 语义后，
若不在 2.4 里补 checkout，monitor CI 会**立刻变红**。这是预期内的变严，但要排在同一个改动里。

## 4. 门控（每道可重跑、有明确判据）

建议落成一个脚本 `scripts/migration_gate.sh <gate>`，逐门可单独跑，失败给非零退出码。

| 门 | 命令 | 通过判据 | 失败动作 |
| --- | --- | --- | --- |
| **G0 对账** | 新仓树 vs crawler 副本树逐文件比对（带允许差异清单） | 差异 ⊆ 清单，无一条多余 | 停止，人工判读 |
| **G1 本仓自测** | `ruff check` / `ruff format --check` / `sync_waf_patterns.py --check` / `pytest tests/ -q` | 全过，14 passed | 停止 |
| **G2 消费方自测** | crawler：`ruff` + `pytest tests/ -q`；monitor：`TZ=Asia/Shanghai pytest tests/ -q`；analyzer：`pytest tests/ -q` | 三仓全过，且插件守卫**确实运行**（不是 skip） | 停止 |
| **G3 切换** | 备份 → `./install.sh` | `opencli list` 出现 7 条命令（`xueqiu:news/replies/stock-notices/user-articles/comments`、`xiaohongshu:search`、`web:article`）；`opencli adapter status` 无告警；锁文件 commit == 本仓 HEAD | 执行 G5 回滚 |
| **G4 切换后观测** | 7 条命令各冒烟一次；随后等一轮真实消费方调用 | 冒烟：`ok` 且字段齐全；真实：消费方台账出现新调用且 `ok: true`、插件台账无新增错误码 | 执行 G5 回滚 |
| **G5 回滚** | 卸载本仓插件 → 从备份 tar 重装旧 ID | `opencli list` 7 条命令回来；锁文件恢复 | —— |

**G4 的「一轮真实调用」怎么等**：monitor 的 5 组 pipeline 大致每小时各跑一次（今天实测
g1 14:20 / g4 15:14 / g2 16:19 / g3 17:15 / g5 18:15）。切换后观察一个自然周期即可，
不需要造流量。

## 5. 回滚（确定性，不靠记忆）

切换前先留档：

```bash
cp ~/.opencli/plugins.lock.json ~/.opencli/plugins.lock.json.bak-$(date +%Y%m%d-%H%M)
mkdir -p ~/.opencli/adapters-backup/$(date +%Y%m%d)
git -C <crawler> archive --format=tar HEAD:opencli-adapters \
  > ~/.opencli/adapters-backup/$(date +%Y%m%d)/xueqiu-adapters.tar   # 备份的是「已提交版本」
```

回滚两步：

```bash
opencli plugin uninstall opencli-adapters
cd /tmp && tar xf <备份 tar> -C xueqiu-adapters && opencli plugin install file:///tmp/xueqiu-adapters
```

回滚后判据同上 G5。**注意**：备份 tar 取的是 crawler 副本的**已提交版本**，
不含那份未提交的 `search.js` 风控改动 —— 回滚会退回「风控静默空数组」的旧行为。
若回滚发生在删副本之后，它是唯一的退路，所以**删副本必须排在最后一门之前**。

## 6. 执行顺序

1. **本仓建远端并推送**（前置阻塞：G2 的 CI checkout、`release.yml` 都依赖它 —— 当前无远端）
2. 写路径解析 helper（crawler `conftest.py` + monitor 测试）与三条守卫
3. 改 5 个 crawler 测试 + 1 个 monitor 测试；`sync_waf_patterns.py` 直接删除
4. 改 2.2 的注释与 docs（历史日志只增不改）
5. 删 crawler 副本；同步改两个 workflow 增 checkout
6. 改用户级 Skill（2.3 四处 + 目录名决定）
7. 跑 G0 → G1 → G2
8. 跑 G3（切换）→ G4（冒烟 + 等一轮真实调用）→ 通过即完成；任一失败转 G5

## 7. 边界与风险

**本次不做**：改插件行为 / 命令契约 / 限频参数；动 monitor、analyzer 的抓取逻辑；
回滚已经切换好的插件（按「补事后门控」处理：G0–G4 若失败才转 G5）。

**风险**：

- **假绿灯是本方案要治的病，本身也是最大风险**：路径解析写错，测试仍然全绿。三条守卫是解药，
  实施时每条都要**故意破坏一次**验证它会红（与既有的命令名守卫同样做法）。
- **monitor 的 skip→fail 语义变严**会让 CI 第一次可能就红；这是暴露既有偏差，不是新 bug。
- **删副本后 crawler 若还有隐藏路径依赖**会断。已核实的读取点是读 `~/.opencli/` 下的台账
  （不是副本），但 `analyze_opencli_usage.py` 与 `opencli_extractor.py` 需在 G2 里真跑一次确认。
- **`_deps/opencli-adapters` 的 ref 固定**：CI 若跟 `main`，本仓一动就可能把消费方 CI 弄红。
  建议固定 tag 或 commit，并把「升 ref」当作本仓发版流程的一步。
