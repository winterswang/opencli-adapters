#!/usr/bin/env node
/**
 * 锁的陈旧回收 / 释放竞态回归（opencli-adapters#1）。
 *
 * 原实现是「stat 判断陈旧 → 直接 unlink」，检查与删除之间路径可能已被替换：
 *
 *   进程 A、B 同时判定当前锁过期
 *     → A 删旧锁、建新锁
 *     → B 按同一路径删掉 A 刚建的新锁，再建自己的
 *     → 两个进程同时进入临界区，并发读改写状态文件
 *
 * 这里用模块级函数直接复现那个交错序列（不依赖多进程的时序），断言后手回收者
 * **不会**删掉先手新建的锁。旧实现在第一条断言上就会挂。
 *
 * 手动跑：`node tests/test_lockfile_reclaim_race.mjs`
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    LOCK_STALE_MS,
    acquireLock,
    newLockToken,
    reclaimStaleLock,
    releaseLock,
} from '../lib/lockfile.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-lock-'));
let seq = 0;
const freshPath = () => path.join(tmpRoot, `lock-${seq++}`);

/** 把文件的 mtime 拨到「早就过期」的位置。 */
function makeStale(lockPath) {
    const old = new Date(Date.now() - LOCK_STALE_MS - 5_000);
    fs.utimesSync(lockPath, old, old);
}

function writeLock(lockPath, token) {
    fs.writeFileSync(lockPath, token);
}

const exists = (p) => fs.existsSync(p);

// --- 1. 陈旧锁能被回收 ---
{
    const lockPath = freshPath();
    writeLock(lockPath, 'stale-owner');
    makeStale(lockPath);
    assert.equal(reclaimStaleLock(lockPath), true, '陈旧锁应该被回收');
    assert.equal(exists(lockPath), false, '回收后锁文件应已删除');
}

// --- 2. 新鲜的锁不能碰 ---
{
    const lockPath = freshPath();
    writeLock(lockPath, 'live-owner');
    assert.equal(reclaimStaleLock(lockPath), false, '新鲜锁不应被回收');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'live-owner');
}

// --- 3. 核心回归：先手回收者新建的锁，不能被后手回收者删掉 ---
//     复现 issue 里的交错：A、B 都认为锁过期 → A 回收并建新锁 → B 再来回收。
{
    const lockPath = freshPath();
    writeLock(lockPath, 'crash-leftover');
    makeStale(lockPath);

    // A：回收陈旧锁，随即建立自己的新锁
    assert.equal(reclaimStaleLock(lockPath), true, 'A 应回收掉陈旧锁');
    const tokenA = 'token-A';
    writeLock(lockPath, tokenA);

    // B：手里还攥着「刚才那把锁是陈旧的」这个判断，现在再来回收一次
    assert.equal(reclaimStaleLock(lockPath), false, 'B 不应回收 A 刚建的新锁');
    assert.equal(exists(lockPath), true, 'A 的新锁必须还在');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), tokenA, 'A 的新锁不能被换成别人的');
}

// --- 4. 释放：不能删掉已经换成别人的锁 ---
{
    const lockPath = freshPath();
    const tokenA = newLockToken();
    writeLock(lockPath, tokenA);
    const fd = fs.openSync(lockPath, 'r+');

    // 模拟「我们的锁被回收、别人建了新锁」—— 路径上的 inode 已经换了
    fs.unlinkSync(lockPath);
    writeLock(lockPath, 'token-B');

    releaseLock(fd, lockPath, tokenA);
    assert.equal(exists(lockPath), true, '释放不能删掉别人的锁');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'token-B');
}

// --- 5. 释放：自己的锁要删掉 ---
{
    const lockPath = freshPath();
    const token = newLockToken();
    writeLock(lockPath, token);
    const fd = fs.openSync(lockPath, 'r+');
    releaseLock(fd, lockPath, token);
    assert.equal(exists(lockPath), false, '自己的锁应被释放');
}

// --- 6. 释放：凭证写失败留下的空文件按「自己的」处理（否则要等 60s 陈旧回收） ---
{
    const lockPath = freshPath();
    fs.writeFileSync(lockPath, '');
    const fd = fs.openSync(lockPath, 'r+');
    releaseLock(fd, lockPath, 'whatever');
    assert.equal(exists(lockPath), false, '空锁文件应被释放');
}

// --- 7. 取锁 → 释放 的正常路径，且不留下回收锁 ---
{
    const lockPath = freshPath();
    const token = newLockToken();
    const { fd, failOpen } = await acquireLock('test', lockPath, token);
    assert.equal(failOpen, undefined, '空闲锁应能取到');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), token);
    releaseLock(fd, lockPath, token);
    assert.equal(exists(lockPath), false);
    assert.equal(exists(`${lockPath}.reclaim`), false, '回收锁不能被落下');
}

// --- 8. 陈旧锁也能被 acquireLock 自动回收（端到端走一遍取锁路径） ---
{
    const lockPath = freshPath();
    writeLock(lockPath, 'dead-process');
    makeStale(lockPath);
    const token = newLockToken();
    const { fd, failOpen } = await acquireLock('test', lockPath, token);
    assert.equal(failOpen, undefined, '陈旧锁应被自动回收后取到');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), token, '应拿到自己的新锁');
    releaseLock(fd, lockPath, token);
}

console.log('all assertions passed');
