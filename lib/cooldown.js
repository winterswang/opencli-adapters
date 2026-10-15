/**
 * 风控熔断：命中站点风控后，在冷却期内让该站点**发不出任何请求**。
 *
 * 为什么需要它（2026-10-14 实测）
 * ------------------------------
 * 小红书 search 被风控后的形态是**持续性**的：实测封禁中位 6.3 小时、最长 19.3 小时，
 * 且空闲 9 小时后单发一枪仍被拦。页面上那句「请一分钟后再试」是骗人的。
 * 没有熔断器时，几十个子代理会各自继续撞上去 —— 每一次撞击都在**加重**封锁，
 * 且调用方要白等 2–5 分钟的限速队列才拿到错误。台账里 4 段"封禁"就是这么由单发
 * 探针续命出来的。
 *
 * 关键约束：插件钩子**没有中止执行的 API**
 * --------------------------------------
 * `dist/src/hooks.js` 对每个 handler 都套了 try/catch，注释原文
 * 「a failing hook never blocks command execution」—— 在钩子里抛异常只会让 opencli
 * 打一行 warn，**命令照常执行**。（同一条事实在 `lib/ratelimit.js` 的 fail-open
 * 说明里已经写过，本模块只是把它用在反方向。）钩子是 `await fn(...)`，所以能**延迟**
 * 却不能**中止**。
 *
 * 可用的杠杆：`process.env.OPENCLI_PROFILE`
 * ---------------------------------------
 * `dist/src/browser/profile.js:46` 把 `OPENCLI_PROFILE` 当作**硬要求**读：
 *     const explicit = normalizeContextId(profile) ?? normalizeContextId(process.env.OPENCLI_PROFILE);
 * 而 `profile.d.ts` 写明它是「Hard requirement — never falls back」「route strictly and
 * fail loud if it is offline」。**profile 解析发生在钩子之后**，所以在钩子里把它指向
 * 一个不存在的 profile，命令会在 routing 阶段硬失败 —— 浏览器根本没启动，站点请求
 * 一个都没发出去。2026-10-14 实测：`BROWSER_CONNECT` / exitCode 69 /
 * `Browser profile "__opencli_risk_cooldown__" is not connected`。
 *
 * 已知代价：这条路径要等约 45 秒才失败（daemon 连接超时），所以它是**兜底**而
 * 不是唯一的快速失败手段 —— 调用方（如 FrontierAgent 的 `_platform_cli.py`）
 * 应先读本模块的状态文件直接拒绝，那份检查是 0 秒的。
 *
 * ⚠️ 已知代价之二：一个**显式的 `--profile` 参数能绕过本熔断器**。
 * `dist/src/browser/profile.js` 读的是
 * `normalizeContextId(profile) ?? normalizeContextId(process.env.OPENCLI_PROFILE)`
 * —— `??` 左边一旦有值，我们改的 env 就完全不参与路由。所以任何 pin 了
 * `--profile <真名>` 的调用方在冷却期内**照常发出请求**，而台账仍记
 * `cooldown_active: true`（钩子以为自己拦住了）。三仓目前都没有传 `--profile`
 * （2026-10-15 grep 全空），故当下不可达；但它是 opencli 的全局公开参数。
 *
 * 状态文件：`~/.opencli/<key>-cooldown.json`
 * ------------------------------------------
 *     { "until_ms": <epoch ms>, "level": <int>, "reason": "<错误码>",
 *       "last_trip_ms": <epoch ms>, "trips": <int> }
 * 升级：每次命中，`level += 1`，冷却 = `min(base_s × 2^(level-1), max_s)`（1h→2h→4h…24h）。
 * 衰减：距上次命中超过 `decay_s` 则 `level` 归零 —— 否则一次误触就会永久抬价。
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEBUG, log } from './env.js';
import { OPENCLI_DIR } from './paths.js';

/**
 * 会触发熔断的错误码。
 * ⚠️ 必须与 `scripts/risk_audit.py` 的 `BLOCK_CODES` 保持一致 —— 那边负责统计，
 * 这边负责拦。两边漂了就会出现「台账说没被封、熔断器却在拦」这种查不出来的状态。
 */
export const RISK_CODES = new Set(['RATE_LIMITED', 'SECURITY_BLOCK', 'BLOCKED_WAF']);

/** 用来把命令挡在触网之前的假 profile 名。刻意取得不可能与真实 profile 重名。 */
export const BLOCK_PROFILE = '__opencli_risk_cooldown__';

/** 每键可被 `sites.<key>.cooldown` 覆盖；未声明时用这里。 */
const DEFAULTS = { enabled: true, base_s: 3600, max_s: 86400, decay_s: 86400 };

export function cooldownPathFor(key, policy) {
  const override =
    (policy && policy.cooldown && policy.cooldown.state_path) || process.env.OPENCLI_COOLDOWN_STATE;
  if (override) return path.resolve(String(override).replace(/^~(?=\/|$)/, os.homedir()));
  return path.join(OPENCLI_DIR, `${key}-cooldown.json`);
}

function settings(policy) {
  const raw = (policy && policy.cooldown) || {};
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  // ⚠️ 站点被**显式禁用**（`sites.<key>.enabled: false`）⇒ 整套熔断也停。
  // 否则会出现这种情形：用户说「别再管这个站」，`shouldThrottle` 因此返回假、命令照跑，
  // 可一旦命中风控，`tripCooldown` 仍按默认策略记账并**逐级抬价** —— 等他把限速重新
  // 打开的那一刻，先吃到一个已经涨到几小时的冷却。`enabled` 不传到这一层就没人拦得住。
  // （用户注释口径：「所有站点默认开启」说的是**未声明**的键 —— 它们没有 `enabled:false`。）
  if (policy && policy.enabled === false) {
    return {
      enabled: false,
      baseS: num(raw.base_s, DEFAULTS.base_s),
      maxS: num(raw.max_s, DEFAULTS.max_s),
      decayS: num(raw.decay_s, DEFAULTS.decay_s),
    };
  }
  return {
    enabled: raw.enabled !== false,
    baseS: num(raw.base_s, DEFAULTS.base_s),
    maxS: num(raw.max_s, DEFAULTS.max_s),
    decayS: num(raw.decay_s, DEFAULTS.decay_s),
  };
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // 不存在 / 半截 JSON 都当"没有冷却"，绝不能因为读不了就拦住正常调用
  }
}

function writeState(file, state) {
  // ⚠️ tmp 名必须**每个写者唯一**。此前是固定的 `${file}.tmp`：抢不到锁的那个写者
  // 走的是无锁写（见 acquireStateLock 的说明），与持锁写者**共用同一个 tmp 路径** ——
  // 后者刚写完 tmp、还没 rename，前者先把 tmp rename 走了，后者的 rename 就 ENOENT，
  // 于是**整次 trip 全部丢弃**（until_ms / level / trips 都没落盘），而不是注释里
  // 以为的「最多丢一级升级」。若丢的恰是第一次 trip，冷却根本没建起来、后续照打，
  // 现场只留一行警告。2026-10-15 实测：20 个进程并发 trip，丢 3 次。
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, 'utf8');
    fs.renameSync(temporary, file); // 同目录 rename 是原子的
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(temporary); // 失败了就把自己的 tmp 清掉，别在 ~/.opencli 里留垃圾
    } catch {
      // rename 已经成功时这里必然失败 —— 没什么可清的，忽略
    }
    // 写不进去只能放弃：状态没落盘 = 下次调用不会被拦。可接受（退化成旧行为），
    // 但必须留痕，否则就成了"熔断器装好了却没生效"这种最坏的可观测性。
    log.warn(`cooldown: 状态写入失败 ${file}: ${err?.message ?? err}`);
    return false;
  }
}

/** 冷却剩余毫秒数（0 = 不在冷却中）。调用方用它决定是否直接拒绝。 */
export function cooldownRemainingMs(key, policy, nowMs = Date.now()) {
  const config = settings(policy);
  if (!config.enabled) return 0;
  const state = readState(cooldownPathFor(key, policy));
  return Math.max(0, (Number(state.until_ms) || 0) - nowMs);
}

/** 只读地看一眼当前状态，供报表/诊断用。 */
export function peekCooldown(key, policy, nowMs = Date.now()) {
  const state = readState(cooldownPathFor(key, policy));
  return {
    active: cooldownRemainingMs(key, policy, nowMs) > 0,
    remaining_ms: cooldownRemainingMs(key, policy, nowMs),
    until_ms: Number(state.until_ms) || null,
    level: Math.trunc(Number(state.level)) || 0,
    reason: state.reason ?? null,
    last_trip_ms: Number(state.last_trip_ms) || null,
    trips: Math.trunc(Number(state.trips)) || 0,
  };
}

/**
 * 记一次命中并延长冷却。返回新状态（未启用则返回 null）。
 *
 * 读改写整体持一把 `wx` 锁；抢不到锁就**不带锁地写**并留一条 debug 日志 ——
 * 并发命中时最坏情况是丢掉一级升级（冷却短一档），比为此把调用阻塞住划算。
 */
export function tripCooldown(key, reason, policy, nowMs = Date.now()) {
  const config = settings(policy);
  if (!config.enabled) return null;
  const file = cooldownPathFor(key, policy);
  const lockPath = `${file}.lock`;
  const fd = acquireStateLock(lockPath);

  try {
    const now = nowMs;
    const state = readState(file);
    const lastTrip = Number(state.last_trip_ms) || 0;
    let level = Math.trunc(Number(state.level)) || 0;
    // 静默够久 → 归零，否则一次误触会永久抬价
    if (lastTrip && now - lastTrip > config.decayS * 1000) level = 0;
    level += 1;
    const seconds = Math.min(config.baseS * 2 ** (level - 1), config.maxS);
    const next = {
      until_ms: now + seconds * 1000,
      level,
      reason,
      last_trip_ms: now,
      trips: (Math.trunc(Number(state.trips)) || 0) + 1,
    };
    writeState(file, next);
    return next;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关不掉就算了，进程马上退出 */
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* 同上 */
      }
    }
  }
}

// 临界区只有几次文件操作（微秒级），所以「等一下再试」几乎总能拿到锁。
// 最多等 ~200ms；再拿不到才退回无锁写（保留原设计的降级，但让它变罕见）。
const LOCK_RETRY_ATTEMPTS = 40;
const LOCK_RETRY_SLEEP_MS = 5;
// 锁超过这么久一定是泄漏的（正常临界区是微秒级）。本仓有实例：
// `~/.opencli/dianping-throttle.json.lock`。不回收的话，一次 kill -9 会让之后的
// 每一次 trip 都落到无锁写 —— 而**并发正是这个模块存在的理由**。
const LOCK_STALE_MS = 30_000;

function sleepSync(ms) {
  // Node 主线程可用的同步睡眠；不 spawn 子进程。
  // 兜底：裁剪过的运行时可能没有 SharedArrayBuffer —— 睡不成也不该出错，
  // 大不了这一轮少等一会儿（重试次数本身是有限的）。
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 没睡成就算了 */
  }
}

/**
 * 取状态文件的写锁；拿不到返回 null（调用方退回无锁写）。
 *
 * **绝不抛**：它是熔断器的旁路，绝不能因为它自己出错而让调用方命令失败
 * （原实现在这里也是全吞异常的）。整个函数体套一层 try/catch 兜住 mkdir/stat
 * 之类非预期错误。
 */
function acquireStateLock(lockPath) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return fs.openSync(lockPath, 'wx');
      } catch (err) {
        if (err?.code !== 'EEXIST') break; // 不是"被别人占着"（无权限等）：别空转
        try {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) {
            fs.unlinkSync(lockPath); // 陈旧锁：回收后立刻重试
            continue;
          }
        } catch {
          continue; // 锁刚好被释放了：下一轮直接拿
        }
        sleepSync(LOCK_RETRY_SLEEP_MS);
      }
    }
  } catch {
    /* 连 mkdir/stat 都出错：当作没拿到锁，走无锁写 */
  }
  if (DEBUG) log.debug(`cooldown: 未取到锁，退回无锁写入 ${lockPath}`);
  return null;
}

/**
 * 把命令挡在触网之前 —— 见文件头「可用的杠杆」。
 *
 * 会先把调用方原本的 `OPENCLI_PROFILE` 存到 `guard.origProfile` 上，由
 * `restoreProfile()` 还原；opencli 每条命令是一个独立进程，但守护进程模式下
 * 不还原就会污染后续命令。
 */
export function blockWithBogusProfile(guard) {
  if (guard.origProfile === undefined) {
    guard.origProfile = process.env.OPENCLI_PROFILE ?? null;
  }
  process.env.OPENCLI_PROFILE = BLOCK_PROFILE;
}

export function restoreProfile(guard) {
  if (guard.origProfile === undefined) return;
  if (guard.origProfile === null) delete process.env.OPENCLI_PROFILE;
  else process.env.OPENCLI_PROFILE = guard.origProfile;
  guard.origProfile = undefined;
}

/** 人类可读的剩余时间，用在告警里。 */
export function humanizeMs(ms) {
  if (ms <= 0) return '0 秒';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = ms / 3600000;
  return hours < 48 ? `${hours.toFixed(1)} 小时` : `${(hours / 24).toFixed(1)} 天`;
}
