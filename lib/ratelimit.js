/**
 * 频率控制：「预留下一个槽位，然后睡到它开始」。
 *
 * 跨进程：状态放文件（`<key>-throttle.json`），互斥用独占创建的锁文件。
 * 算法：持锁读改写 next_at → 释放锁 → 才 sleep —— 所以睡眠**不占锁**，长命令不会
 * 阻塞别的调用方。
 *
 * ⚠️ 睡眠发生在 **opencli 子进程内部**，会被调用方 `subprocess.run(timeout=…)` 的
 * 墙钟一并计时。调用方的超时必须大于「最大等待 + 单次真实执行」，否则长停一命中就
 * 必然被误杀（2026-07-12 实测：30s 上限下 2/18 账号失败）。
 *
 * **fail-open 的依据**（别在这里补 try/catch —— 那是重复的）：opencli 只在
 * `execution.js:206` 一处触发 onBeforeExecute，且经 `emitHook` 派发，而 `emitHook`
 * 对每个 handler 都套了 try/catch（「a failing hook never blocks command execution」）。
 * 所以本函数抛出的异常只会让 opencli 打一条 warn、本次不限速，命令照常执行。
 * 本模块内的 try 只有 `finally`、没有 `catch` 是**有意的**：状态写失败时也必须释放锁。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEBUG, log } from './env.js';
import { acquireLock, newLockToken, readState, releaseLock, writeState } from './lockfile.js';
import { statePathFor } from './paths.js';
import { asNumber, randomBetween, sleep } from './util.js';

/** 滚动窗口长度。墙按「滚动 60 分钟」计量（opencli-adapters#4 实测），写死不开放配置
 * —— 配错窗口长度等于给自己开缺口，而这个数没有第二个合理值。 */
export const WINDOW_S = 3600;

/** 窗口时间戳环的硬上限。正常 prune 就兜得住（70/小时 × 1 小时窗口）；这条只防
 * 时钟跳变 / 手改状态文件把环撑成无界。 */
const MAX_STAMPS = 1000;

/**
 * 纯函数：在滚动窗口约束下为一次调用规划落点（有界等待 + 超界放行，opencli-adapters#4）。
 *
 * - 未满额度：按原落点走（fireAt = baseNextAt），只做记账。
 * - 满了且再等 `neededS ≤ waitMaxS` 就有槽位滑出窗口：把落点推到滑出时刻（等待**有界**，
 *   不破坏调用方的 subprocess 超时预算）。
 * - 满了且要等太久：**放行**并打 overflow 标记（软约束）。刻意不拒绝：钩子没有中止
 *   执行的 API（见 lib/cooldown.js 文件头），能用的拒绝手段只剩「指向不存在 profile」
 *   —— 那条路报 BROWSER_CONNECT、要烧 ~45s，而调用方（crawler 生产链路）对它的处置
 *   是重试与回退，TD-023 尚未接线，拒绝只会把请求赶进不记账的 `browser` 回退通道，
 *   比放行更糟。硬约束等消费方按窗口占用自行节流后再议（issue #107 的跟进清单）。
 *
 * 溢出放行的调用**同样记账**（fireAt 进环）—— 它们是真实请求，不记账窗口就永远
 * 「看起来没满」，额度失去诊断价值。
 *
 * @returns {{fireAt:number, waitedS:number, overflow:boolean, neededS:number, stamps:number[]}}
 *   waitedS 是**窗口归因**的那段等待（不含基础间隔）；stamps 是 prune 后的窗口占用。
 */
export function planWindowSlot({ stamps, nowS, baseNextAt, maxPerHour, waitMaxS }) {
  const floor = nowS - WINDOW_S;
  const inWindow = stamps
    .map(Number)
    .filter((s) => Number.isFinite(s) && s > floor)
    .sort((a, b) => a - b);
  if (maxPerHour <= 0 || inWindow.length < maxPerHour) {
    return { fireAt: baseNextAt, waitedS: 0, overflow: false, neededS: 0, stamps: inWindow };
  }
  const wakeAt = inWindow[0] + WINDOW_S; // 最早一笔滑出窗口、腾出槽位的时刻
  const neededS = Math.max(0, wakeAt - baseNextAt);
  if (neededS <= waitMaxS) {
    return {
      fireAt: Math.max(baseNextAt, wakeAt),
      waitedS: neededS,
      overflow: false,
      neededS,
      stamps: inWindow,
    };
  }
  return { fireAt: baseNextAt, waitedS: 0, overflow: true, neededS, stamps: inWindow };
}

/**
 * 预留下一个槽位并睡到它开始。
 *
 * @param {string} key    流量键（决定状态文件与策略来源）
 * @param {string} source 记进状态文件的 `last_source`（命令全名，便于排查）
 * @returns {Promise<{enabled:boolean, waited_s:number, reserved_s?:number, fail_open?:boolean,
 *   long_pause_s?:number, window_waited_s?:number, window_overflow?:boolean,
 *   window_needed_s?:number, window_size?:number}>}
 */
export async function acquireSlot(key, source, policy) {
  const statePath = statePathFor(key, policy);
  const lockPath = `${statePath}.lock`;
  let waited = 0;
  let reserved = 0;
  let longPause = 0;
  let windowed = { waitedS: 0, overflow: false, neededS: 0, size: 0 };

  // 锁文件先于状态文件落地，所以目录得在这里建 —— writeState 里那次 mkdirSync
  // 在**拿到锁之后**才执行，太晚。漏了这一步的后果（2026-10-12 实测）：在
  // `~/.opencli` 还不存在的机器上（全新安装 / 新用户），openSync 报 ENOENT，
  // 被 acquireLock 当作「无法创建锁」直接放行 —— **限速静默失效、没有任何告警**。
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const lockToken = newLockToken();
  const { fd, failOpen } = await acquireLock(key, lockPath, lockToken);
  if (failOpen) return { enabled: true, waited_s: 0, fail_open: true };

  try {
    const state = readState(statePath);
    const nowS = Date.now() / 1000;
    const baseNextAt = Math.max(nowS, asNumber(state.next_at));
    const calls = Math.trunc(asNumber(state.calls)) + 1;
    const every = Math.trunc(asNumber(policy.long_pause_every));
    longPause =
      every > 0 && calls % every === 0
        ? randomBetween(asNumber(policy.long_pause_min_s), asNumber(policy.long_pause_max_s))
        : 0;
    reserved =
      randomBetween(asNumber(policy.min_delay_s), asNumber(policy.max_delay_s)) + longPause;

    const maxPerHour = Math.trunc(asNumber(policy.max_per_hour, 0));
    const plan = planWindowSlot({
      stamps: Array.isArray(state.window) ? state.window : [],
      nowS,
      baseNextAt,
      maxPerHour,
      waitMaxS: asNumber(policy.window_wait_max_s, 0),
    });
    // 记账只在配额开启时维护：关闭时不写 window 键（状态文件不增长，老读者无感），
    // 开启即冷启动（无历史 = 未满）。溢出放行的同样入环。
    const stamps =
      maxPerHour > 0 ? [...plan.stamps, plan.fireAt].slice(-MAX_STAMPS) : plan.stamps;
    writeState(statePath, {
      next_at: plan.fireAt + reserved,
      calls,
      last_source: source,
      ...(maxPerHour > 0 ? { window: stamps } : {}),
    });
    waited = Math.max(0, plan.fireAt - nowS);
    windowed = {
      waitedS: plan.waitedS,
      overflow: plan.overflow,
      neededS: plan.neededS,
      // 配额关闭时报 0（= 未启用），不把历史残留当现势占用报出去。
      size: maxPerHour > 0 ? stamps.length : 0,
    };
  } finally {
    releaseLock(fd, lockPath, lockToken);
  }

  if (waited > 0) {
    if (DEBUG) log.debug(`rate-limit[${key}]: 等待 ${waited.toFixed(1)}s（${source}）`);
    await sleep(waited * 1000);
  }
  return {
    enabled: true,
    waited_s: waited,
    reserved_s: reserved,
    long_pause_s: longPause,
    window_waited_s: windowed.waitedS,
    window_overflow: windowed.overflow,
    window_needed_s: windowed.neededS,
    window_size: windowed.size,
  };
}
