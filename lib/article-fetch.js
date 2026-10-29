/**
 * `web article` 的协议升级与回退（opencli-adapters#3）。
 *
 * 契约接受绝对 http(s) URL，但实现会把 `http://` 无条件升级成 `https://` ——
 * 对 cninfo 这类支持 HTTPS 的公告站点是对的（沿用 xueqiu-monitor detail_fetcher
 * 的既有行为），对**只支持 HTTP** 的站点则直接把地址改成不可访问的形态：
 * `page.goto()` 把地址原样交给浏览器，不会替我们换回原协议。
 *
 * 所以升级只当**首选**：HTTPS 导航失败时回退到原始地址再试一次。
 *
 * 约束：
 *   · 只回退一次，不重试成环。
 *   · 只对「http 输入且升级过」的调用回退；https 输入没有可回退的形态。
 *   · 两种协议都失败时抛 **HTTPS 那次**的错误：调用方要看到的瓶颈是首选路径。
 *   · 风控页不在这里判断——那是 goto 之后的 BLOCK_GUARD 的职责，风控是确定性信号，
 *     不该被重试掩盖。
 */

const HTTP_PREFIX = /^http:\/\//i;

/** 升级后的首选地址。https 输入与非 URL 串原样返回。 */
export function preferredUrlFor(rawUrl) {
    return String(rawUrl ?? '').replace(HTTP_PREFIX, 'https://');
}

/**
 * 导航并返回**实际使用的**地址。
 *
 * @param {{goto: (url: string) => Promise<unknown>}} page opencli 的 page 对象
 * @param {string} rawUrl 调用方传入的地址
 * @returns {Promise<string>} 实际导航成功的地址
 */
export async function gotoArticle(page, rawUrl) {
    const preferred = preferredUrlFor(rawUrl);
    if (preferred === rawUrl) {
        await page.goto(preferred);
        return preferred;
    }
    try {
        await page.goto(preferred);
        return preferred;
    } catch (httpsError) {
        try {
            await page.goto(rawUrl);
            return rawUrl;
        } catch {
            throw httpsError;
        }
    }
}
