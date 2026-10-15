#!/usr/bin/env node
/**
 * 判据回归：小红书 `search` 命中验证页时，「频控」还是「扫码墙」分得清吗？
 *
 * 为什么要有这个测试（2026-10-14，两次踩坑）
 * -----------------------------------------
 * `/website-login/captcha` 这个容器里住着**两种**完全不同的拦截：
 *
 *   A 频控   —— 正文「请求太频繁，请一分钟后再试」，**页面上没有二维码**
 *   B 身份验证 —— 正文「请使用已登录该账号的「小红书APP」扫码验证身份」，有二维码
 *
 * 两种的正确响应截然相反：A 只能等（实测恢复中位 6.3 小时），B 需要马上人工扫码。
 * 报错了不会让人损失一次重试，而是让人**满世界去找一个根本不存在的二维码**。
 * 这个坑实际发生过两次：
 *
 *   1. 第一版判据只认 URL，把 A 报成「疑似扫码墙」；
 *   2. 第二版改成「正文优先、URL 兜底」——听着对，但 URL 那条兜底**在第一个 tick 就
 *      return**。服务器在正文渲染之前就把地址重定向到 captcha，此时 bodyText 是空的，
 *      两条看正文的判据都没机会匹配，于是必然落到 URL 兜底 —— 等于没改。
 *
 * 现在的规则：**正文说了算**；等满 5 秒正文仍不匹配、但地址在验证容器里，就如实返回
 * `challenge_unknown`（"分不清，你自己看一眼"），绝不猜。
 *
 * 用法：`node tests/test_xhs_challenge_classify.mjs`
 *   `XHS_SEARCH_JS=<path>` 可指向别的副本，默认取 ~/.opencli/clis/xiaohongshu/search.js
 *   （适配器是本地 eject 的覆盖副本，不在本仓库里，所以这个测试是"跨库"的）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ADAPTER =
  process.env.XHS_SEARCH_JS ||
  path.join(os.homedir(), '.opencli/clis/xiaohongshu/search.js');

/**
 * 取出真实的判据函数。
 *
 * ⚠️ 必须**求值模板字面量**，不能拿文件原文直接 new Function：源码里写的是
 * `\\/website-login\\/captcha`，模板字面量会把它变成 `\/website-login\/captcha`
 * 才是页面里跑的那份正则。直接喂原文会得到 `\\/`（转义反斜杠 + 斜杠），报
 * `Invalid regular expression flags` —— 这正是我第一版测试脚本的错。
 */
function loadWaiter() {
  const source = fs.readFileSync(ADAPTER, 'utf8');
  const match = source.match(/const WAIT_FOR_CONTENT_JS = `[\s\S]*?\n`;/);
  if (!match) throw new Error(`抽不到 WAIT_FOR_CONTENT_JS，${ADAPTER} 的结构变了？`);
  const pageScript = new Function(`${match[0]}\nreturn WAIT_FOR_CONTENT_JS;`)();
  return new Function(
    'document',
    'location',
    'MutationObserver',
    'setTimeout',
    // 括号是必须的：pageScript 以换行开头，`return\n new Promise(...)` 会被 ASI
    // 拆成 `return;` —— 于是七条用例全部拿到 undefined。
    `return (${pageScript});`,
  );
}

class SilentObserver {
  observe() {}
  disconnect() {}
}

/** 在假 DOM 上跑一次真实的判据，返回它给出的分类。 */
function classify({ href, bodyText, noteCard = false, loginButton = false }) {
  const waiter = loadWaiter();
  const document = {
    body: { innerText: bodyText },
    querySelector: (selector) => {
      if (loginButton && String(selector).includes('login-btn')) return {};
      if (noteCard && String(selector).includes('note-item')) return {};
      return null;
    },
  };
  // setTimeout 立刻回调 = 模拟"已经等满 5 秒"
  return waiter(document, { href }, SilentObserver, (fn) => { fn(); return 0; });
}

const CAPTCHA =
  'https://www.xiaohongshu.com/website-login/captcha?redirectPath=https%3A%2F%2Fwww.xiaohongshu.com%2Fsearch_result%2F&verifyUuid=abc&verifyType=124&verifyBiz=461&verifyMsg=null';
const SEARCH_RESULT =
  'https://www.xiaohongshu.com/search_result?keyword=%E7%BE%8E%E9%A3%9F&source=web_search_result_notes';

const cases = [
  {
    name: '频控页 → rate_limited（文字明确，不带二维码）',
    input: { href: CAPTCHA, bodyText: '请求太频繁，请一分钟后再试\n刷新\n问题反馈' },
    expect: 'rate_limited',
  },
  {
    name: '真扫码墙 → identity_challenge（文字明确）',
    input: {
      href: CAPTCHA,
      bodyText: '为保护账号安全，请使用已登录该账号的「小红书APP」扫码验证身份',
    },
    expect: 'identity_challenge',
  },
  {
    // ★ 这条就是本次修复的回归点：正文还没渲染时，绝不能猜成扫码墙
    name: '验证容器里但正文为空 → challenge_unknown（**不许猜**）',
    input: { href: CAPTCHA, bodyText: '' },
    expect: 'challenge_unknown',
  },
  {
    name: '验证容器里但正文是无关文字 → challenge_unknown',
    input: { href: CAPTCHA, bodyText: '加载中…' },
    expect: 'challenge_unknown',
  },
  {
    name: '正常搜索结果页有卡片 → content',
    input: { href: SEARCH_RESULT, bodyText: '美食 相关笔记', noteCard: true },
    expect: 'content',
  },
  {
    name: '正常搜索结果页但没卡片 → timeout（可重试的那种"慢"）',
    input: { href: SEARCH_RESULT, bodyText: '搜索' },
    expect: 'timeout',
  },
  {
    name: '登录墙 → login_wall（与风控是两回事）',
    input: { href: SEARCH_RESULT, bodyText: '登录后查看搜索结果' },
    expect: 'login_wall',
  },
];

let failed = 0;
for (const { name, input, expect } of cases) {
  let actual;
  try {
    actual = await classify(input);
  } catch (error) {
    actual = `THREW: ${error?.message ?? error}`;
  }
  const ok = actual === expect;
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${name}\n      期望 ${expect} / 实际 ${actual}`);
}

console.log();
if (failed) {
  console.error(`❌ ${failed}/${cases.length} 条失败`);
  process.exit(1);
}
console.log(`✅ ${cases.length}/${cases.length} 条通过`);
