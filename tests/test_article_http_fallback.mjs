#!/usr/bin/env node
/**
 * `web article` 的协议回退回归（opencli-adapters#3）。
 *
 * 原实现把 `http://` 无条件升级成 `https://` 后直接 `page.goto()`。对 cninfo 这类
 * 支持 HTTPS 的站点是对的，但**只支持 HTTP** 的站点会被改成不可访问的地址，
 * 而 `page.goto()` 不会替我们换回原协议 —— 整条链路直接失败。
 *
 * 这里用一个假的 page 记录 goto 序列，不需要真浏览器、不需要 opencli 运行时。
 *
 * 手动跑：`node tests/test_article_http_fallback.mjs`
 */
import assert from 'node:assert/strict';

import { gotoArticle, preferredUrlFor } from '../lib/article-fetch.js';

/** 假 page：按 plan 决定第 N 次 goto 是否抛错，并记录实际导航过的地址。 */
function fakePage(plan = []) {
    const visits = [];
    return {
        visits,
        async goto(url) {
            visits.push(url);
            const behavior = plan[visits.length - 1];
            if (behavior instanceof Error) throw behavior;
        },
    };
}

// --- 1. https 输入保持不变，只导航一次 ---
{
    const page = fakePage();
    const url = await gotoArticle(page, 'https://example.com/a?x=1');
    assert.equal(url, 'https://example.com/a?x=1');
    assert.deepEqual(page.visits, ['https://example.com/a?x=1']);
}

// --- 2. http 输入且站点支持 HTTPS：升级一次即成功，不再回退 ---
{
    const page = fakePage();
    const url = await gotoArticle(page, 'http://cninfo.com.cn/announcement/1.pdf');
    assert.equal(url, 'https://cninfo.com.cn/announcement/1.pdf');
    assert.deepEqual(page.visits, ['https://cninfo.com.cn/announcement/1.pdf']);
}

// --- 3. 只支持 HTTP 的站点：升级失败后回退原地址，且只回退一次 ---
{
    const page = fakePage([new Error('ERR_SSL_PROTOCOL_ERROR'), undefined]);
    const raw = 'http://http-only.test/page';
    const url = await gotoArticle(page, raw);
    assert.equal(url, raw, '回退后应返回原始 HTTP 地址');
    assert.deepEqual(page.visits, ['https://http-only.test/page', raw]);
    assert.equal(page.visits.length, 2, '只允许回退一次，不得重试成环');
}

// --- 4. 两种协议都失败：抛 HTTPS 那次的原因（首选路径的瓶颈） ---
{
    const httpsError = new Error('ERR_SSL_PROTOCOL_ERROR');
    const page = fakePage([httpsError, new Error('ERR_CONNECTION_REFUSED')]);
    await assert.rejects(
        () => gotoArticle(page, 'http://http-only.test/page'),
        (err) => err === httpsError,
        '应抛 HTTPS 那次错误，而不是回退那次的',
    );
    assert.equal(page.visits.length, 2);
}

// --- 5. 地址规范化：只有 http:// 前缀被升级 ---
{
    assert.equal(preferredUrlFor('http://a.test/x'), 'https://a.test/x');
    assert.equal(preferredUrlFor('HTTP://a.test/x'), 'https://a.test/x');
    assert.equal(preferredUrlFor('https://a.test/x'), 'https://a.test/x');
    assert.equal(preferredUrlFor('http://a.test/x?next=http://b.test'), 'https://a.test/x?next=http://b.test');
}

console.log('all assertions passed');
