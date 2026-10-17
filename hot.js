import { cli } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { parseRelativeTimeToIso } from './lib/relative-time.js';

const MAX_SCROLLS = 5;
const TEXT_MAX_CHARS = 300;

export const CLICK_HOT_TAB_JS = ' (() => {' +
    'const tabs = Array.from(document.querySelectorAll("a"))' +
        '.filter((a) => (a.textContent || "").trim() === "热门" && a.offsetParent !== null);' +
    'if (!tabs.length) return "TAB_NOT_FOUND";' +
    'tabs[0].click();' +
    'return "CLICKED";' +
' })()';

export function buildExtractJs(targetCount, maxScrolls) {
    return ' (async () => {' +
        'const countItems = () => document.querySelectorAll("article.timeline__item").length;' +
        'const target = ' + targetCount + ';' +
        'for (let i = 0; i < ' + maxScrolls + '; i++) {' +
            'if (countItems() >= target) break;' +
            'const before = countItems();' +
            'const height = document.body.scrollHeight;' +
            'window.scrollTo(0, height);' +
            'await new Promise((resolve) => {' +
                'let timer = null;' +
                'const ob = new MutationObserver(() => {' +
                    'if (document.body.scrollHeight > height || countItems() > before) {' +
                        'if (timer) clearTimeout(timer);' +
                        'ob.disconnect();' +
                        'setTimeout(resolve, 400);' +
                    '}' +
                '});' +
                'timer = setTimeout(() => { ob.disconnect(); resolve(); }, 1500);' +
                'ob.observe(document.body, { childList: true, subtree: true });' +
            '});' +
        '}' +
        'const toNumber = (raw) => {' +
            'const text = String(raw || "").replace(/[^0-9.万亿]/g, "");' +
            'const m = text.match(/^([0-9]+(?:\\.[0-9]+)?)(万|亿)?/);' +
            'if (!m) return 0;' +
            'const value = parseFloat(m[1]);' +
            'if (m[2] === "万") return Math.round(value * 10000);' +
            'if (m[2] === "亿") return Math.round(value * 100000000);' +
            'return Math.round(value);' +
        '};' +
        'const parseMeta = (el) => {' +
            'const raw = el ? (el.getAttribute("analytics-data") || "") : "";' +
            'try { return JSON.parse(raw) || {}; } catch { return {}; }' +
        '};' +
        'const seen = {};' +
        'const items = [];' +
        'document.querySelectorAll("article.timeline__item").forEach((item) => {' +
            'const ownEl = item.querySelector("a.date-and-source[href]");' +
            'const ownMatch = ownEl ? (ownEl.getAttribute("href") || "").match(/^\\/(\\d+)\\/(\\d+)$/) : null;' +
            'if (!ownMatch) return;' +
            'const statusId = ownMatch[2];' +
            'if (seen[statusId]) return;' +
            'seen[statusId] = true;' +
            'const authorEl = item.querySelector("a.user-name[href]");' +
            'const authorMatch = authorEl ? (authorEl.getAttribute("href") || "").match(/\\/(\\d+)/) : null;' +
            'const contentEl = item.querySelector(".timeline__item__content");' +
            'const text = contentEl ? (contentEl.textContent || "").replace(/\\s+/g, " ").trim() : "";' +
            'const timeText = ownEl ? (ownEl.textContent || "").split("·")[0].trim() : "";' +
            'const controls = item.querySelectorAll(".timeline__item__control");' +
            'const pickCount = (selector) => {' +
                'const el = item.querySelector(selector);' +
                'return toNumber(el ? el.textContent : "");' +
            '};' +
            'const metaEl = item.querySelector("[analytics-data]") || (item.hasAttribute("analytics-data") ? item : null);' +
            'const meta = parseMeta(metaEl);' +
            'items.push({' +
                'status_id: statusId,' +
                'author: authorEl ? (authorEl.textContent || "").trim() : "",' +
                'author_id: authorMatch ? authorMatch[1] : "",' +
                'url: ownEl.href,' +
                'time_text: timeText,' +
                'text: text.slice(0, ' + TEXT_MAX_CHARS + '),' +
                'forwards: pickCount(".retweet-count") || toNumber(controls[0] ? controls[0].textContent : ""),' +
                'comments: pickCount(".replay-count") || toNumber(controls[1] ? controls[1].textContent : ""),' +
                'likes: pickCount(".like-count") || toNumber(controls[2] ? controls[2].textContent : ""),' +
                'tab: String(meta.tab || ""),' +
                'position: typeof meta.position === "number" ? meta.position : null,' +
            '});' +
        '});' +
        'return JSON.stringify({' +
            'items: items,' +
            'login_link: !!document.querySelector("a[href*=\\"login.xueqiu.com\\"]"),' +
        '});' +
    '})()';
}

const BLOCK_GUARD = "(function(){var t=(document.title||'')+' '+((document.body&&document.body.innerText)||'').slice(0,300);return /您的访问被阻断|request has been blocked|可能对网站造成安全威胁|potential threats to the server|访问被拦截|滑动验证|请按住滑块|访问验证|访问触发保护|完成人机验证|安全限制|访问频繁|website-login|405 forbidden|http 405|405 not allowed/.test(t)?'BLOCKED':'OK';})()";


cli({
    site: 'xueqiu',
    name: 'hot',
    access: 'read',
    description: '获取首页「热门」贴列表（DOM 抓取，依赖登录态）',
    domain: 'xueqiu.com',
    browser: true,
    args: [
        { name: 'limit', type: 'int', default: 20, help: '返回条数' },
        { name: 'scrolls', type: 'int', default: 3, help: '滚动加载次数（每次约 +8-10 条，上限 5）' },
    ],
    columns: ['rank', 'author', 'text', 'created_at', 'forwards', 'comments', 'likes', 'url'],
    func: async (page, kwargs) => {
        const limit = Math.floor(Number(kwargs.limit));
        if (!Number.isFinite(limit) || limit < 1) {
            throw new ArgumentError('xueqiu hot received an invalid limit: ' + kwargs.limit);
        }
        const scrolls = Math.floor(Number(kwargs.scrolls ?? 3));
        if (!Number.isFinite(scrolls) || scrolls < 1) {
            throw new ArgumentError('xueqiu hot received an invalid scrolls: ' + kwargs.scrolls);
        }
        const maxScrolls = Math.min(MAX_SCROLLS, scrolls);

        await page.goto('https://xueqiu.com');
        const guard = await page.evaluate(BLOCK_GUARD);
        if (guard === 'BLOCKED') {
            throw new CommandExecutionError(
                '风控验证页（滑动验证 / 访问频繁）——这不是"没有数据"',
                '请在已连上 opencli 的 Chrome 里打开雪球完成滑块验证，然后重跑',
            );
        }
        await page.wait(3);
        await page.evaluate(CLICK_HOT_TAB_JS);
        await page.wait(3);

        const raw = await page.evaluate(buildExtractJs(limit + 2, maxScrolls));
        let payload = null;
        try {
            payload = JSON.parse(typeof raw === 'string' ? raw : 'null');
        } catch {
            payload = null;
        }
        const rows = Array.isArray(payload?.items) ? payload.items : [];
        if (!rows.length) {
            if (payload?.login_link) {
                throw new AuthRequiredError('xueqiu.com', 'Hot timeline requires login');
            }
            throw new CommandExecutionError(
                '首页「热门」时间线没有提取到任何帖子——页面结构可能变了，或登录态已失效',
                '先跑 opencli xueqiu whoami 确认登录态；登录有效则在 Chrome 里打开 xueqiu.com 检查时间线结构',
            );
        }

        // analytics-data 带 tab 标记时只认「热门」——点错 tab 绝不能把别的列表当热门返回。
        // 老页面结构没有标记时才退回全量（并保底下一条错误路径区分「空结果」）。
        const hotRows = rows.filter((row) => row.tab === '热门');
        const sourceRows = hotRows.length ? hotRows : rows.filter((row) => !row.tab);
        if (rows.length && !sourceRows.length) {
            throw new CommandExecutionError(
                '首页时间线有内容但没有「热门」标记——可能点到了别的 tab（页面结构变了）',
                '在 Chrome 里打开 xueqiu.com 检查「热门」tab 的 DOM 结构，必要时更新 CLICK_HOT_TAB_JS',
            );
        }
        const nowMs = Date.now();
        const out = [];
        sourceRows.forEach((row, index) => {
            const createdAt = parseRelativeTimeToIso(row.time_text, nowMs);
            if (!createdAt) return;
            out.push({
                rank: out.length + 1,
                author: row.author,
                author_id: row.author_id,
                status_id: row.status_id,
                url: String(row.url || '').replace('//www.xueqiu.com', '//xueqiu.com'),
                text: row.text,
                created_at: createdAt,
                forwards: row.forwards,
                comments: row.comments,
                likes: row.likes,
                position: row.position ?? index + 1,
            });
        });
        return out.slice(0, limit);
    },
});
