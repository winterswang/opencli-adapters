import { cli } from '@jackwener/opencli/registry';
import { Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CliError } from '@jackwener/opencli/errors';

const NON_DEFAULT = [
    { name: 'note-type', def: 'all' },
    { name: 'publish-time', def: 'anytime' },
    { name: 'scope', def: 'all' },
    { name: 'location', def: 'all' },
];

/**
 * 页面内风控检测。
 *
 * 为什么必须有：本覆盖是「导航到搜索页 → 抽 section.note-item 卡片」。被风控时
 * 小红书把页面**重定向到一个提示页**，卡片的数量因此是 0 —— 与「这个词真的没有
 * 结果」在返回值上**完全同形**。实测（2026-10-12）这类静默空返回会导致：子代理
 * 以为换个关键词就行，把一个 agent_team run 白跑成 165 次调用、53 分钟，最后交
 * 不出任何证据。
 *
 * 已观测到的两种形态：
 *   1. 账号级 —— 302 到 /website-login/error?...&error_code=3000xx
 *      （实测 300011「当前账号存在异常，请切换账号后重试」，页面标题「安全限制」）
 *   2. 通用风控页 —— 正文出现「安全限制 / 操作频繁 / 滑动验证」等短语
 *
 * 检测放在**页面里**（而不是 Node 侧用返回结果猜），因为只有页面能看到最终的 URL
 * 与渲染后的正文。
 */
const BLOCK_DETECT_JS = [
    'const __href = location.href || "";',
    'const __text = (document.body && document.body.innerText) || "";',
    // 账号级：重定向到 website-login/error，或 URL 里带 error_code=3000xx
    'const __ec = (__href.match(/error_code=(\\d+)/) || [])[1] || "";',
    'if (/\\/website-login\\/error/.test(__href) || /^3000\\d\\d$/.test(__ec)) {',
    '  return JSON.stringify({ blocked: true, kind: "account", code: __ec, url: __href, text: __text.slice(0, 200) });',
    '}',
    // 通用风控页
    'if (/安全限制|当前账号存在异常|账号存在异常|操作频繁|访问频繁|请完成验证|滑动验证|请切换账号/.test(__text)) {',
    '  return JSON.stringify({ blocked: true, kind: "risk-control", code: __ec, url: __href, text: __text.slice(0, 200) });',
    '}',
].join('');

function buildExtractJs(targetCount, maxScrolls) {
    return ' (async () => {' + BLOCK_DETECT_JS +
        'const countCards = () => document.querySelectorAll("section.note-item").length;' +
        'const target = ' + targetCount + ';' +
        'for (let i = 0; i < ' + maxScrolls + '; i++) {' +
            'if (countCards() >= target) break;' +
            'const before = countCards();' +
            'const height = document.body.scrollHeight;' +
            'window.scrollTo(0, height);' +
            'await new Promise((resolve) => {' +
                'let timer = null;' +
                'const ob = new MutationObserver(() => {' +
                    'if (document.body.scrollHeight > height || countCards() > before) {' +
                        'if (timer) clearTimeout(timer);' +
                        'ob.disconnect();' +
                        'setTimeout(resolve, 400);' +
                    '}' +
                '});' +
                'timer = setTimeout(() => { ob.disconnect(); resolve(); }, 1800);' +
                'ob.observe(document.body, { childList: true, subtree: true });' +
            '});' +
        '}' +
        'const out = [];' +
        'const seen = {};' +
        'document.querySelectorAll("section.note-item").forEach((card) => {' +
            'let url = "";' +
            'card.querySelectorAll("a[href*=xsec_token]").forEach((a) => {' +
                'if (url) return;' +
                'const href = a.getAttribute("href") || "";' +
                'const m = href.match(/^\\/(?:search_result|explore)\\/([0-9a-zA-Z]+)\\?(.*)$/);' +
                'if (m) url = "https://www.xiaohongshu.com/explore/" + m[1] + "?" + m[2];' +
            '});' +
            'if (!url) {' +
                'const a2 = card.querySelector("a[href^=\\"/explore/\\"]");' +
                'if (a2) url = "https://www.xiaohongshu.com" + a2.getAttribute("href");' +
            '}' +
            'if (!url) return;' +
            'const m2 = url.match(/\\/explore\\/([0-9a-zA-Z]+)/);' +
            'const id = m2 ? m2[1] : url;' +
            'if (seen[id]) return;' +
            'seen[id] = 1;' +
            'const q = (sel) => { const e = card.querySelector(sel); return e ? (e.textContent || "").trim() : ""; };' +
            'out.push({ id: id, title: q(".title"), author: q(".name"), likes: q(".count"), published_at: q(".time"), url: url });' +
        '});' +
        'return JSON.stringify({ blocked: false, items: out });' +
    ' })()';
}

cli({
    site: 'xiaohongshu',
    name: 'search',
    access: 'read',
    description: '搜索小红书笔记（搜索结果页 DOM 抓取，URL 自带 xsec_token）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'query', required: true, positional: true, help: '搜索关键词' },
        { name: 'limit', type: 'int', default: 20, help: '返回条数' },
        { name: 'sort', type: 'string', default: 'comprehensive', choices: ['comprehensive', 'latest', 'most-liked', 'most-commented', 'most-collected'], help: '排序（本覆盖只支持 comprehensive）' },
        { name: 'note-type', type: 'string', default: 'all', choices: ['all', 'video', 'image'], help: '笔记类型（本覆盖只支持 all）' },
        { name: 'publish-time', type: 'string', default: 'anytime', choices: ['anytime', 'day', 'week', 'half-year'], help: '发布时间（本覆盖只支持 anytime）' },
        { name: 'scope', type: 'string', default: 'all', choices: ['all', 'seen', 'unseen', 'following'], help: '搜索范围（本覆盖只支持 all）' },
        { name: 'location', type: 'string', default: 'all', choices: ['all', 'same-city', 'nearby'], help: '位置距离（本覆盖只支持 all）' },
    ],
    columns: ['rank', 'title', 'author', 'likes', 'published_at', 'url'],
    func: async (page, kwargs) => {
        const query = String(kwargs.query ?? '').trim();
        if (!query) throw new ArgumentError('xiaohongshu search requires a non-empty query');

        if (String(kwargs.sort ?? 'comprehensive') !== 'comprehensive') {
            throw new ArgumentError('this local xiaohongshu search override only supports --sort comprehensive; run `opencli adapter reset xiaohongshu` to use the packaged adapter instead');
        }
        for (const spec of NON_DEFAULT) {
            const value = kwargs[spec.name] ?? spec.def;
            if (String(value) !== spec.def) {
                throw new ArgumentError('this local xiaohongshu search override does not support --' + spec.name + ' ' + value + ' (only ' + spec.def + ')');
            }
        }

        const limit = Math.max(1, Number(kwargs.limit) || 20);
        const url = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(query) + '&source=web_search_result_notes';

        await page.goto(url);
        await page.waitFor ? await page.waitFor(3) : await page.wait(5);

        const js = buildExtractJs(limit + 2, Math.min(40, Math.ceil(limit / 10) + 8));
        const raw = await page.evaluate(js);

        let payload = null;
        try {
            payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
            payload = null;
        }
        // 旧版形态（裸数组）兜底：万一 evaluate 返回的还是数组，按「无风控」处理。
        const parsed = Array.isArray(payload) ? { blocked: false, items: payload } : (payload || { blocked: false, items: [] });

        // ⚠️ 关键：风控必须**抛错**，不能返回空数组。空数组与「关键词真的没结果」
        // 同形，会让调用方（agent）误判为「换个词就行」而持续空转 —— 见文件头注释。
        if (parsed.blocked) {
            const code = String(parsed.code || '');
            const kind = String(parsed.kind || 'risk-control');
            const detail = kind === 'account'
                ? '账号级风控（error_code=' + (code || 'unknown') + '，页面提示「当前账号存在异常，请切换账号后重试」）'
                : '风控验证页（页面出现安全限制/操作频繁类文案）';
            throw new CliError(
                'SECURITY_BLOCK',
                'Xiaohongshu search blocked by risk control: ' + detail
                    + '。这不是「没有结果」—— 搜索结果页被重定向到了验证/限制页。',
                '请在已连上 opencli 的 Chrome 里打开小红书检查：'
                    + '账号级（3000xx）需切换账号或等待风控解除；'
                    + '验证页需人工完成验证。'
                    + '⚠️ 不要反复重试同一关键词，那会加重风控。'
                    + '（对照：feed / liked / note 走不同接口，通常仍可用）',
            );
        }

        return (Array.isArray(parsed.items) ? parsed.items : [])
            .filter((row) => row.title)
            .slice(0, limit)
            .map((row, i) => ({ rank: i + 1, title: row.title, author: row.author, likes: row.likes, published_at: row.published_at, url: row.url }));
    },
});
