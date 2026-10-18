#!/usr/bin/env node
/**
 * 滚动小时额度的行为回归（opencli-adapters#4）。
 *
 * 为什么是直连 `lib/ratelimit.js` 而不是走 opencli：钩子链要 daemon、真站点请求，
 * 单测不该有那些依赖。`acquireSlot` 只依赖 fs/path + lib 小件，`policy.state_path`
 * 可以把状态文件指到临时目录 —— 隔离不需要动 HOME。
 *
 * 入口文件 `rate-limit.js` import 了 `@jackwener/opencli/registry`，**不要**从这里进。
 *
 * 手动跑：`node tests/test_rolling_window_quota.mjs`（CI 由
 * tests/test_plugin_rolling_window_mjs.py 包装执行）。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquireSlot, planWindowSlot, WINDOW_S } from '../lib/ratelimit.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-quota-'));
const statePath = (name) => path.join(tmpRoot, `${name}-throttle.json`);

/** 读状态文件里的 window 环（没有就是空数组）。 */
function stampsOf(name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(name), 'utf8'));
    return Array.isArray(parsed.window) ? parsed.window : [];
  } catch {
    return [];
  }
}

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: 期望 ±${tolerance} 内得 ${expected}，实际 ${actual}`,
  );

// ---------------------------------------------------------------------------
// planWindowSlot：纯函数，覆盖三种分支 + 边界剪枝
// ---------------------------------------------------------------------------
{
  const nowS = 1_000_000;
  const base = { nowS, baseNextAt: nowS, maxPerHour: 3, waitMaxS: 8 };

  // 未满额度：原落点放行，只记账
  const under = planWindowSlot({ ...base, stamps: [nowS - 10, nowS - 5] });
  assert.equal(under.fireAt, nowS);
  assert.equal(under.waitedS, 0);
  assert.equal(under.overflow, false);
  assert.deepEqual(under.stamps, [nowS - 10, nowS - 5]);

  // 满了且槽位很快滑出：等待有界、落点推到滑出时刻
  const bounded = planWindowSlot({
    ...base,
    stamps: [nowS - WINDOW_S + 3, nowS - 60, nowS - 30],
  });
  near(bounded.fireAt, nowS + 3, 1e-9, '有界等待的落点');
  near(bounded.waitedS, 3, 1e-9, '有界等待的窗口归因');
  assert.equal(bounded.overflow, false);

  // neededS 恰好等于上限：仍然等（≤ 语义）
  const edge = planWindowSlot({
    ...base,
    stamps: [nowS - WINDOW_S + 8, nowS - 60, nowS - 30],
  });
  assert.equal(edge.overflow, false);
  near(edge.waitedS, 8, 1e-9, '边界值等待');

  // 满了且要等太久：放行 + overflow 标记 + 记录「本该等多久」
  const overflow = planWindowSlot({ ...base, stamps: [nowS - 3500, nowS - 60, nowS - 30] });
  assert.equal(overflow.fireAt, nowS);
  assert.equal(overflow.waitedS, 0);
  assert.equal(overflow.overflow, true);
  near(overflow.neededS, 100, 1e-9, '溢出时记录的所需等待');

  // 配额关闭：满环也直接放行（且不给 window 记账口径）
  const off = planWindowSlot({
    ...base,
    maxPerHour: 0,
    stamps: [nowS - 3500, nowS - 60, nowS - 30],
  });
  assert.equal(off.overflow, false);
  assert.equal(off.waitedS, 0);

  // prune：窗口外的时间戳不参与计数（跨进程共享的状态可能带着昨天的环）
  const pruned = planWindowSlot({
    ...base,
    stamps: [nowS - WINDOW_S - 5, nowS - 10, nowS - 5, '垃圾', Number.NaN],
  });
  assert.equal(pruned.stamps.length, 2, '窗口外/非数值的时间戳必须被剪掉');
  assert.equal(pruned.overflow, false);
}

// ---------------------------------------------------------------------------
// acquireSlot：端到端（真实状态文件读写 + 锁）
// ---------------------------------------------------------------------------
{
  // 配额关闭：不写 window 键，状态文件对老读者保持同形
  const offPath = statePath('off');
  for (let i = 0; i < 3; i += 1) {
    const slot = await acquireSlot('off', 'test/off', {
      min_delay_s: 0.01,
      max_delay_s: 0.02,
      max_per_hour: 0,
      state_path: offPath,
    });
    assert.equal(slot.window_overflow, false);
    assert.equal(slot.window_size, 0);
  }
  const offState = JSON.parse(fs.readFileSync(offPath, 'utf8'));
  assert.equal(offState.window, undefined, '配额关闭不得写 window 键');
  assert.equal(offState.calls, 3);

  // 未满额度：连续调用正常放行、环在增长
  const underPath = statePath('under');
  for (let i = 0; i < 3; i += 1) {
    const slot = await acquireSlot('under', 'test/under', {
      min_delay_s: 0.01,
      max_delay_s: 0.02,
      max_per_hour: 5,
      window_wait_max_s: 8,
      state_path: underPath,
    });
    assert.equal(slot.window_overflow, false);
    assert.equal(slot.window_size, i + 1);
  }
  assert.equal(stampsOf('under').length, 3);

  // 满了且要等 ~1 小时：溢出放行（不烧超时预算），但同样入环
  const overPath = statePath('over');
  const policy = {
    min_delay_s: 0.01,
    max_delay_s: 0.02,
    max_per_hour: 3,
    window_wait_max_s: 8,
    state_path: overPath,
  };
  for (let i = 0; i < 3; i += 1) await acquireSlot('over', 'test/over', policy);
  const overflowSlot = await acquireSlot('over', 'test/over', policy);
  assert.equal(overflowSlot.window_overflow, true, '第 4 次调用应当溢出放行');
  assert.ok(overflowSlot.window_needed_s > 3000, `所需等待应接近 1 小时，实际 ${overflowSlot.window_needed_s}`);
  assert.equal(overflowSlot.window_size, 4, '溢出的调用同样要入环记账');
  assert.equal(stampsOf('over').length, 4);
  // 溢出不能烧掉调用方预算：总等待仍是基础间隔的量级
  assert.ok(overflowSlot.waited_s < 1, `溢出放行不该等待，实际 ${overflowSlot.waited_s}s`);

  // 有界等待：把最早的章戳摆在「3 秒后滑出窗口」，第 4 次调用应等到它滑出
  const boundedPath = statePath('bounded');
  const nowS = Date.now() / 1000;
  fs.writeFileSync(
    boundedPath,
    JSON.stringify({
      next_at: 0,
      calls: 3,
      window: [nowS - WINDOW_S + 3, nowS - 30, nowS - 20],
    }),
  );
  const boundedSlot = await acquireSlot('bounded', 'test/bounded', {
    ...policy,
    state_path: boundedPath,
  });
  assert.equal(boundedSlot.window_overflow, false);
  near(boundedSlot.window_waited_s, 3, 0.5, '有界等待的窗口归因');
  assert.ok(boundedSlot.waited_s >= 2.5, `总等待应包含窗口等待，实际 ${boundedSlot.waited_s}s`);
  assert.equal(stampsOf('bounded').length, 4);

  // 滑出后额度恢复：窗口外的时间戳不占额度，满环自动解锁
  const recoveredPath = statePath('recovered');
  const laterS = Date.now() / 1000;
  fs.writeFileSync(
    recoveredPath,
    JSON.stringify({
      next_at: 0,
      calls: 9,
      window: [laterS - WINDOW_S - 1, laterS - 5],
    }),
  );
  const fresh = await acquireSlot('recovered', 'test/recovered', {
    ...policy,
    max_per_hour: 2,
    state_path: recoveredPath,
  });
  assert.equal(fresh.window_overflow, false, '窗口外的章戳不应继续占额度');
  assert.equal(fresh.window_size, 2, '剪掉窗口外的 1 条后，占用 = 剩余 1 条 + 本次');
}

// ---------------------------------------------------------------------------
// 跨进程：两个进程共享同一份额度（状态文件 + 锁），不是各算各的
// ---------------------------------------------------------------------------
{
  const sharedPath = statePath('shared');
  const { fileURLToPath } = await import('node:url');
  const modulePath = fileURLToPath(new URL('../lib/ratelimit.js', import.meta.url));
  const child = `import { acquireSlot } from '${modulePath}';
    const slot = await acquireSlot('shared', 'test/shared', {
      min_delay_s: 0.01, max_delay_s: 0.02, max_per_hour: 5, window_wait_max_s: 8,
      state_path: '${sharedPath}',
    });
    console.log(JSON.stringify(slot));`;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const [a, b] = await Promise.all([
    run(process.execPath, ['--input-type=module', '-e', child]),
    run(process.execPath, ['--input-type=module', '-e', child]),
  ]);
  const slots = [JSON.parse(a.stdout), JSON.parse(b.stdout)];
  for (const slot of slots) {
    assert.equal(slot.window_overflow, false);
    assert.ok(slot.window_size >= 1, `子进程应看到共享额度，实际 ${slot.window_size}`);
  }
  // 两个进程各记一笔：环里必须有 2 条（各算各的话只会是 1）
  assert.equal(stampsOf('shared').length, 2, '并发进程必须共享同一份窗口记账');
}

console.log('rolling window quota: all assertions passed');
