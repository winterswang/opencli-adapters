#!/usr/bin/env node
/**
 * stock-notices 符号校验回归（2026-10-30 事故）。
 *
 * 事故：池子新入 BRK.B.US 后，`opencli xueqiu stock-notices BRK.B` 每轮抛
 * ARGUMENT，舆情 gate 的 source_failures 记一条，组级 gate 判 warn。
 *
 * 根因是正则抄错：`(?:\\.[.-][A-Z]{1,2})?` 要求**两个**分隔符（先点、再点或横线），
 * 于是 BRK.B 匹配不上；而 comments.js 的同款正则是 `(?:[.-][A-Z]{1,2})?`，单个分隔符。
 *
 * 手动跑：`node tests/test_stock_notices_symbol.mjs`
 */
import assert from 'node:assert/strict';

import { normalizeSymbolInput, XUEQIU_SYMBOL_PATTERN } from '../stock-notices.js';

// 股份类别：点号与连字符两种写法都要过
assert.equal(normalizeSymbolInput('BRK.B'), 'BRK.B');
assert.equal(normalizeSymbolInput('BRK-B'), 'BRK-B');
assert.equal(normalizeSymbolInput('brk.b'), 'BRK.B', '应统一大写');

// 普通美股 / A 股（6 位数字自动补市场前缀）
assert.equal(normalizeSymbolInput('AAPL'), 'AAPL');
assert.equal(normalizeSymbolInput('600519'), 'SH600519');
assert.equal(normalizeSymbolInput('$AAPL'), 'AAPL', '前导 $ 应剥掉');

// 非法输入仍然要拒绝（放宽不能放到没有边界）
for (const bad of ['', 'BAD@', 'TOOLONGTICKER', 'BRK.B.US']) {
    assert.throws(() => normalizeSymbolInput(bad), /invalid symbol|requires a symbol/, `${bad} 应被拒绝`);
}

// 正则本身：一个分隔符即可，两个不行
assert.ok(XUEQIU_SYMBOL_PATTERN.test('BRK.B'));
assert.ok(XUEQIU_SYMBOL_PATTERN.test('BRK-B'));
assert.ok(!XUEQIU_SYMBOL_PATTERN.test('BRK..B'), '连续两个分隔符仍应拒绝');

console.log('all assertions passed');
