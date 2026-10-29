/**
 * 跨进程互斥锁与状态文件读写（Node 没有 flock）。
 *
 * 锁 = 独占创建（`open(..., 'wx')`）+ 陈旧回收 + 所有权凭证。凭证那一条不能省：
 * 若本进程在临界区里被挂起超过 LOCK_STALE_MS（笔记本睡眠 / SIGSTOP），别人会回收
 * 我们的锁并建一把新的；我们恢复后若无脑 unlink，删掉的就是**别人的**锁，第三个
 * 进程随即能挤进临界区做并发读改写。
 *
 * 光有凭证还不够（opencli-adapters#1）：**回收方**同样会误删。两个进程同时判定
 * 锁陈旧时，先回收的那个建的新锁会被后一个按同一路径删掉。所以回收要走回收锁并
 * 在锁内复核；释放要按 inode 确认路径上还是自己那把。细节见 reclaimStaleLock。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { log } from './env.js';
import { sleep } from './util.js';

export const LOCK_STALE_MS = 60_000; // 持锁只为读改写状态，超过这个时间必然是崩溃残留

// 等锁的上限，**算在调用方的 subprocess 超时预算里**（它与预留等待是相加的，
// 见 scripts/opencli_extractor.py 的 OPENCLI_CALL_TIMEOUT_SECONDS）。临界区只是一次
// 几十 KB 的 JSON 读改写、亚毫秒级，30 秒这种量级纯属照搬「真实锁」的直觉，会把
// 最坏等待抬到 30+87 ≈ 117 秒、反过来逼调用方把超时抬得更高。2 秒足够跨过
// 轮询间隔（25–50ms）和一次进程调度；超时就 fail-open 放行。
export const LOCK_WAIT_MS = 2_000;
export const LOCK_POLL_MS = 25;

export function readState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (state && typeof state === 'object') return state;
  } catch {
    /* 首次运行或文件损坏：从头开始，不影响调用 */
  }
  return { next_at: 0, calls: 0 };
}

export function writeState(statePath, state) {
  // 先写临时文件再 rename —— 读方永远看不到半截 JSON。
  //
  // 临时名带 pid：Python 版用的是 `${statePath}.tmp`（同一个名字），若同时开两个
  // 实现（`XUEQIU_PY_THROTTLE=1` 的回退档），两边会互相 rename 对方写到一半的
  // 临时文件，读方解析失败后 readState 会静默回落成 {next_at:0,calls:0}、把限速
  // 排期整个丢掉。
  //
  // ⚠️ 同一个坑 2026-10-15 在 `lib/cooldown.js` 里被**重新引进**过（那边写的是固定
  // 的 `${file}.tmp`），代价是并发下整次 trip 丢失。改那两个模块的写入路径时，先看这里。
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath);
}

export function newLockToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// 文件身份与回收锁（opencli-adapters#1）
//
// 原实现是「stat 判断陈旧 → 直接 unlink」。检查与删除之间锁路径可能已被别人替换：
//   A、B 同时判定锁过期 → A 删旧锁、建新锁 → B 按同一路径删掉 A 刚建的新锁
//   → 两个进程同时进入临界区。
//
// 现在回收分两步：先抢一把**回收锁**（`<lock>.reclaim`，O_EXCL），抢到之后
// **重新判断陈旧性**再删。同一时刻只有一个进程能删主锁，且它删之前看到的是
// 当下的真实状态，不会再误删别人新建的锁。
// ---------------------------------------------------------------------------

function identityOfPath(p) {
  try {
    const st = fs.statSync(p);
    return { ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function identityOfFd(fd) {
  try {
    const st = fs.fstatSync(fd);
    return { ino: st.ino, dev: st.dev };
  } catch {
    return null;
  }
}

/** 同一个文件？在 POSIX 下 ino+dev 就够了；Windows 两者都可能是 0，退化成「都拿不到就信」。 */
function sameFile(a, b) {
  if (!a || !b) return false;
  if (a.ino === 0 && b.ino === 0) return true;
  return a.ino === b.ino && a.dev === b.dev;
}

/**
 * 抢回收锁。抢不到返回 null（别人正在回收）。
 *
 * 回收锁自己只在毫秒级临界区里存在，所以**不再为它套一层回收锁** —— 递归没有尽头。
 * 超过 LOCK_STALE_MS 还留着，只能是持锁进程被 KILL 的残留，直接清掉。
 */
function openReclaimLock(lockPath) {
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    return { fd: fs.openSync(reclaimPath, 'wx'), path: reclaimPath };
  } catch (err) {
    if (err.code === 'EEXIST') {
      const id = identityOfPath(reclaimPath);
      if (id && Date.now() - id.mtimeMs > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(reclaimPath);
        } catch {
          /* 被别人先删了 */
        }
      }
    }
    return null;
  }
}

function closeReclaimLock(handle) {
  if (!handle) return;
  try {
    fs.closeSync(handle.fd);
  } catch {
    /* 已关闭 */
  }
  try {
    fs.unlinkSync(handle.path);
  } catch {
    /* 已删除 */
  }
}

/**
 * 回收一把陈旧锁。返回 true 表示确实删掉了，调用方应立刻重试取锁。
 *
 * **必须先拿到回收锁再判断陈旧性** —— 这一步是这次修复的全部要点。回收锁在手时
 * 主锁路径不可能被别人删（删除只有这条路径），我们看到的 mtime 就是即将删掉的那个
 * 文件的 mtime。
 */
function reclaimStaleLock(lockPath) {
  const handle = openReclaimLock(lockPath);
  if (!handle) return false;
  try {
    const id = identityOfPath(lockPath);
    if (!id) return false; // 锁已被释放
    if (Date.now() - id.mtimeMs <= LOCK_STALE_MS) return false; // 复核：已经不陈旧了
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    closeReclaimLock(handle);
  }
}

export { reclaimStaleLock };

/**
 * 取锁。成功返回 `{ fd }`；需要 fail-open 放过本次调用时返回 `{ failOpen: true }`
 * （锁被别人占着超过 LOCK_WAIT_MS、或锁文件根本建不出来）。
 */
export async function acquireLock(label, lockPath, lockToken) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, lockToken);
      } catch {
        /* 写不进凭证不影响互斥；解锁时按「空文件 = 自己的」兜底 */
      }
      return { fd };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        log.warn(`rate-limit[${label}]: 无法创建锁 ${lockPath}（${err.message}），本轮放行`);
        return { failOpen: true };
      }
    }
    // 陈旧回收：只在**拿到回收锁并复核**之后才删（见 reclaimStaleLock）。
    // 回收成功 → 立刻重试取锁；锁刚被别人释放 → 同样立刻重试。
    if (reclaimStaleLock(lockPath)) continue;
    if (!identityOfPath(lockPath)) continue;
    if (Date.now() > deadline) {
      // 文案别再说「仅记录状态」—— 这里既没等到、也没写状态，本次就是**不限速**放行。
      log.warn(`rate-limit[${label}]: 等待状态锁超时，本次不限速放行`);
      return { failOpen: true };
    }
    await sleep(LOCK_POLL_MS + Math.random() * LOCK_POLL_MS);
  }
}

/**
 * 释放锁：**只删自己的**。
 *
 * 两道校验缺一不可（opencli-adapters#1）：
 *   1. 内容里的 lockToken 认所有权；
 *   2. 用 fd 读到的 inode 与路径当前 inode 比对 —— 「读 owner → 删路径」之间路径
 *      可能已被换掉（我们的锁被回收、别人建了新锁），只看内容会删错人。
 *
 * 为什么不需要回收锁：删除主锁只可能由「陈旧回收」或「持有者释放」发起，前者不会
 * 动一把新鲜的锁，后者需要先持有它。也就是说我们这把锁在释放期间不会被人替换，
 * inode 一致就说明路径上还是我们读的那一个。
 */
export function releaseLock(fd, lockPath, lockToken) {
  try {
    fs.closeSync(fd);
  } catch {
    /* 已关闭 */
  }
  try {
    const opened = fs.openSync(lockPath, 'r');
    try {
      const id = identityOfFd(opened);
      const owner = fs.readFileSync(opened, 'utf8');
      if (!sameFile(id, identityOfPath(lockPath))) return; // 路径已不是我们读的那把
      // 空文件按「自己的」处理：凭证写失败时的兜底，否则锁会一直留到陈旧回收。
      if (owner === '' || owner === lockToken) fs.unlinkSync(lockPath);
    } finally {
      try {
        fs.closeSync(opened);
      } catch {
        /* 已关闭 */
      }
    }
  } catch {
    /* 已被陈旧回收线程删掉 */
  }
}
