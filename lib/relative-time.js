/**
 * 雪球时间线的相对时间 → ISO 8601（北京时间）解析。
 *
 * 为什么单独成模块：与 xueqiu-symbol.js 同理——解析规则琐碎，错了是静默的
 * （解析失败的条目会被 hot.js 整条丢弃），必须能被测试钉住；放 lib/ 还能让
 * 测试用裸 node 探测（不 import opencli 包，CI 没有 node_modules 也能跑）。
 *
 * 形态来源：2026-10-17 首页「热门」tab 实测（`a.date-and-source` 文本）：
 *   · 刚刚 / N秒前 / N分钟前 / N小时前 / N天前
 *   · HH:MM —— 当天；比当前时刻晚的裸 HH:MM 按昨天算（跨零点兜底）
 *   · 今天 HH:MM / 昨天 HH:MM
 *   · MM-DD [HH:MM] —— 今年；落在明天之后按去年算（跨年）
 *   · YYYY-MM-DD [HH:MM]
 *   · 上述任意形态前带 `修改于` —— 编辑过的帖子只显示编辑时间，DOM 里没有
 *     原发时间可用，取编辑时间
 *
 * 输出形如 `2026-10-17T21:30:00+08:00`；解析失败返回空串，调用方丢弃该条目。
 */

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

function pad2(value) {
    return String(value).padStart(2, '0');
}

function beijingDateParts(utcMs) {
    const shifted = new Date(utcMs + BEIJING_OFFSET_MS);
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth(),
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
    };
}

function utcMsFromBeijing(year, month, day, hour, minute) {
    return Date.UTC(year, month, day, hour, minute, 0) - BEIJING_OFFSET_MS;
}

function formatBeijingIso(utcMs) {
    const parts = beijingDateParts(utcMs);
    return parts.year + '-' + pad2(parts.month + 1) + '-' + pad2(parts.day)
        + 'T' + pad2(parts.hour) + ':' + pad2(parts.minute) + ':00+08:00';
}

/**
 * @param {string} raw 雪球时间线上的相对时间文本
 * @param {number} nowMs 参考当前时间（毫秒）；测试里固定以获得确定输出
 * @returns {string} ISO 8601（含 +08:00 偏移）；解析失败为空串
 */
export function parseRelativeTimeToIso(raw, nowMs = Date.now()) {
    const text = String(raw ?? '').trim().replace(/^修改于/, '');
    if (!text) return '';
    const agoMatch = text.match(/^(\d+)\s*(秒|分钟|小时|天)前$/);
    if (agoMatch) {
        const unitMs = { 秒: 1000, 分钟: 60 * 1000, 小时: 3600 * 1000, 天: DAY_MS }[agoMatch[2]];
        return formatBeijingIso(nowMs - Number(agoMatch[1]) * unitMs);
    }
    if (text === '刚刚') return formatBeijingIso(nowMs);
    const hmMatch = text.match(/^(?:(今天|昨天)\s*)?(\d{1,2}):(\d{2})$/);
    if (hmMatch) {
        const today = beijingDateParts(nowMs);
        let dayShift = 0;
        if (hmMatch[1] === '昨天') {
            dayShift = 1;
        } else if (!hmMatch[1]) {
            const isEarlierToday = Number(hmMatch[2]) * 60 + Number(hmMatch[3])
                <= today.hour * 60 + today.minute;
            dayShift = isEarlierToday ? 0 : 1;
        }
        return formatBeijingIso(utcMsFromBeijing(
            today.year, today.month, today.day - dayShift,
            Number(hmMatch[2]), Number(hmMatch[3]),
        ));
    }
    const fullMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (fullMatch) {
        return formatBeijingIso(utcMsFromBeijing(
            Number(fullMatch[1]), Number(fullMatch[2]) - 1, Number(fullMatch[3]),
            Number(fullMatch[4] ?? 0), Number(fullMatch[5] ?? 0),
        ));
    }
    const mdMatch = text.match(/^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (mdMatch) {
        const today = beijingDateParts(nowMs);
        let year = today.year;
        const candidateMs = utcMsFromBeijing(
            year, Number(mdMatch[1]) - 1, Number(mdMatch[2]),
            Number(mdMatch[3] ?? 0), Number(mdMatch[4] ?? 0),
        );
        if (candidateMs > nowMs + DAY_MS) year -= 1;
        return formatBeijingIso(utcMsFromBeijing(
            year, Number(mdMatch[1]) - 1, Number(mdMatch[2]),
            Number(mdMatch[3] ?? 0), Number(mdMatch[4] ?? 0),
        ));
    }
    return '';
}
