#!/usr/bin/env node
/**
 * 台账脱敏的行为回归（opencli-adapters#2）。
 *
 * 为什么要单独测这一层：台账是**明文落盘**的，`web article` 接受任意 URL，
 * 一次带 `?token=…` 的调用就会把凭证写进 `~/.opencli/adapter-calls.jsonl`，
 * 并在轮转文件 `adapter-calls.jsonl.1` 里长期留存。这里盯的是「写进去之后
 * 到底还能不能捞到那个值」——而不是脱敏函数本身长什么样。
 *
 * 不 import 入口文件 `rate-limit.js`：它依赖 `@jackwener/opencli/registry`。
 * 被测的是 `lib/redact.js` 与 `lib/requestlog.js` 这两个纯函数模块。
 *
 * 手动跑：`node tests/test_adapter_log_redaction.mjs`
 */
import assert from 'node:assert/strict';

import { redactUrl, redactArgs } from '../lib/redact.js';
import { pickTarget, stripInternalArgs } from '../lib/requestlog.js';

const SECRET = 'super-secret-token-value';
const FRAGMENT = 'frag-token-9f3a';

/** 按 rate-limit.js 的 buildRecord 组装方式模拟一行台账。 */
function buildLine(args) {
  const visible = stripInternalArgs(args) || {};
  return JSON.stringify({
    schema: 2,
    layer: 'plugin',
    target: pickTarget(args) || null,
    args: JSON.stringify(redactArgs(visible)),
  });
}

// --- 1. 带凭证参数的 URL：值和 fragment 都不能出现，域名与路径要留着 ---
{
  const url = `https://example.com/article/123?token=${SECRET}&page=2#${FRAGMENT}`;
  const line = buildLine({ url });
  assert.ok(!line.includes(SECRET), `台账里仍有凭证值：${line}`);
  assert.ok(!line.includes(FRAGMENT), `台账里仍有 fragment：${line}`);
  assert.ok(line.includes('example.com'), `域名被一起遮掉了：${line}`);
  assert.ok(line.includes('/article/123'), `路径被一起遮掉了：${line}`);
  assert.ok(line.includes('page=2'), `非敏感参数被误伤：${line}`);
}

// --- 2. 常见敏感参数名都要覆盖（大小写、连字符/下划线混写） ---
{
  const names = ['access_token', 'access-token', 'AccessToken', 'signature', 'api_key', 'password'];
  for (const name of names) {
    const line = buildLine({ url: `https://a.test/x?${name}=${SECRET}` });
    assert.ok(!line.includes(SECRET), `参数 ${name} 没被遮住：${line}`);
  }
}

// --- 3. 非敏感 URL 必须原样保留（不能被 URL 序列化改写成另一种形态） ---
{
  const url = 'https://example.com/a/b?x=1&y=2';
  assert.equal(redactUrl(url), url, '非敏感 URL 被改写了');
  assert.equal(pickTarget({ url }), url, 'pickTarget 改写了非敏感 URL');
}

// --- 4. 参数里直接带凭证（--token xxx）也要遮 ---
{
  const line = buildLine({ url: 'https://example.com/x', token: SECRET });
  assert.ok(!line.includes(SECRET), `顶层 token 参数没被遮：${line}`);
  assert.ok(line.includes('token'), 'key 名不该一起被删掉，否则排查时看不出带了凭证');
}

// --- 5. 嵌套对象里的 URL 同样要遮 ---
{
  const line = buildLine({ nested: { url: `https://example.com/p?token=${SECRET}` } });
  assert.ok(!line.includes(SECRET), `嵌套 URL 没被遮：${line}`);
  assert.ok(line.includes('example.com'), '嵌套 URL 的域名被误伤');
}

// --- 6. 畸形 URL（解析不了）走兜底，但不能因此放行 ---
{
  const line = buildLine({ url: `/relative/path?token=${SECRET}#${FRAGMENT}` });
  assert.ok(!line.includes(SECRET), `畸形 URL 的凭证漏了：${line}`);
  assert.ok(!line.includes(FRAGMENT), `畸形 URL 的 fragment 漏了：${line}`);
}

// --- 7. 非 URL 的定位参数不受影响（xueqiu user-articles --user_id …） ---
{
  assert.equal(pickTarget({ user_id: '4111857140' }), '4111857140');
  assert.equal(pickTarget({ symbol: 'SH600519' }), 'SH600519');
}

console.log('all assertions passed');
