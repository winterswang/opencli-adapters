/**
 * 台账脱敏（opencli-adapters#2）。
 *
 * 台账 `~/.opencli/adapter-calls.jsonl` 会落 `args` 与 `target` 两个字段，而
 * `web article` 接受任意 URL —— 带签名参数、访问令牌的 URL 会被原样写进去，
 * 连同轮转文件 `adapter-calls.jsonl.1` 一起长期留存在 HOME 下。本模块负责在
 * **写入之前**把这些值遮掉。
 *
 * 设计取舍：
 *   · 保留 key 只遮 value（`token=***`）—— 排查时仍然看得出「这次带了 token」，
 *     否则「为什么这次请求失败」会变成无从下手的谜。
 *   · 域名、路径、非敏感参数**一律保留**：台账的价值就是归因到具体目标。
 *   · fragment 整个丢掉：单页应用常把令牌放在 `#` 后面，而它对归因没有意义。
 *   · 遮不干净也不报错：这是日志路径，脱敏函数抛异常会连带把整行台账吞掉。
 */

/** 参数名命中即遮。比对前统一小写并去掉 `-` / `_`，`access-token` 与 `access_token` 同款。 */
const SENSITIVE_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'signature',
  'sig',
  'key',
  'apikey',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'session',
  'sessionid',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'ticket',
]);

const MASK = '***';

const normalizeKey = (key) => String(key ?? '').toLowerCase().replace(/[-_\s]/g, '');

export const isSensitiveKey = (key) => SENSITIVE_KEYS.has(normalizeKey(key));

/**
 * 遮掉 URL 里的凭证参数与 fragment。
 *
 * 解析不了的（相对路径、畸形串）走正则兜底，而不是原样放行 —— 放行等于没做脱敏。
 * 没有任何需要遮的内容时**原样返回**，避免 `new URL().toString()` 把非敏感 URL
 * 改写成别的形态（末尾斜杠、默认端口、编码差异），那会让台账和调用方传入的对不上。
 */
export function redactUrl(raw) {
  const s = String(raw ?? '');
  if (!s) return s;

  let url;
  try {
    url = new URL(s);
  } catch {
    return redactLoose(s);
  }

  let touched = false;
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveKey(key) && url.searchParams.get(key) !== MASK) {
      url.searchParams.set(key, MASK);
      touched = true;
    }
  }
  if (url.hash) {
    url.hash = '';
    touched = true;
  }
  return touched ? url.toString() : s;
}

/** 解析失败时的兜底：按 `?a=…&b=…` 的形态直接替换敏感值。 */
function redactLoose(s) {
  let out = s.replace(/([?&#])([^=&#?]+)=([^&#]*)/g, (match, sep, key, value) =>
    isSensitiveKey(key) && value !== MASK ? `${sep}${key}=${MASK}` : match,
  );
  // 兜底路径没有可靠的 fragment 边界（不是合法 URL），只截掉明显的锚点尾巴。
  const hash = out.indexOf('#');
  if (hash >= 0) out = out.slice(0, hash);
  return out;
}

/**
 * 递归遮一组调用参数。
 *
 * 除了 URL，参数本身也可能直接带凭证（`--token xxx`），所以 key 命中同样遮掉。
 * 数组与嵌套对象都走一遍 —— `stripInternalArgs` 只去掉 `__` 前缀，不去嵌套。
 */
export function redactArgs(args) {
  if (!args || typeof args !== 'object') return args;
  if (Array.isArray(args)) return args.map((item) => redactArgs(item));

  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (isSensitiveKey(key)) {
      out[key] = MASK;
    } else if (typeof value === 'string') {
      out[key] = redactUrl(value);
    } else if (value && typeof value === 'object') {
      out[key] = redactArgs(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export { MASK, SENSITIVE_KEYS };
