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
 * 状态文件：`~/.opencli/<key>-cooldown.json`
 * ------------------------------------------
 *     { "until_ms": <epoch ms>, "level": <int>, "reason": "<错误码>",
 *       "last_trip_ms": <epoch ms>, "trips": <int> }
 * 升级：每次命中，`level += 1`，冷却 = `min(base_s × 2^(level-1), max_s)`（1h→2h→4h…24h）。
 * 衰减：距上次命中超过 `decay_s` 则 `level` 归零 —— 否则一次误触就会永久抬价。
 */
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
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, 'utf8');
    fs.renameSync(temporary, file); // 同目录 rename 是原子的
    return true;
  } catch (err) {
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
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (DEBUG) log.debug(`cooldown: 未取到锁，无锁写入 ${lockPath}: ${err?.message ?? err}`);
  }

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
