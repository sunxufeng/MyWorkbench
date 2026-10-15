'use strict';
/**
 * My Workbench —— 微信读书（weread）集成（主进程）
 *
 * 两条数据通道：
 *  1) Agent 网关（只读，11 项能力）：用 skil 提供的 wrk- API Key 调
 *     POST https://i.weread.qq.com/api/agent/gateway
 *     → 书架 / 搜索 / 书籍信息 / 章节目录 / 阅读进度 / 笔记划线 / 书评 / 阅读统计 / 推荐
 *  2) 网页正文通道（用于内嵌阅读器，需用户网页 Cookie，有封号风险）：
 *     POST https://weread.qq.com/web/book/chapter/e_0..e_3 | t_0/t_1
 *     → 拉加密片段 → chk 验头 → decrypt 去混淆 → base64 解码 → 章节 HTML/文本
 *
 * 解密/签名算法移植自开源项目 aprpure/wereadx（MIT），仅做技术研究用途。
 */

const https = require('node:https');
const crypto = require('node:crypto');
const { encryptJSON, decryptJSON } = require('./feishu');

const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
const WEB_BASE = 'https://weread.qq.com/web/book';
const SKILL_VERSION = '1.0.4';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 章节请求回退用的常量签名（wereadx resolveChapterPsPc 的默认值）
const PS_FALLBACK = 'a2b325707a19e580g0186a2';
const PC_FALLBACK = '430321207a19e581g013ab0';

/* ---------------- 加密存储（复用 feishu 的 AES-256-GCM） ---------------- */

function saveCreds(cfg, apiKey, cookie) {
  const out = {};
  if (apiKey) out.apiKey = encryptJSON({ v: apiKey }, 'weread');
  if (cookie) out.cookie = encryptJSON({ v: cookie }, 'weread');
  cfg.weread = out;
  return out;
}

function readCreds(cfg) {
  const w = cfg.weread || {};
  let apiKey = null, cookie = null;
  if (w.apiKey) { const d = decryptJSON(w.apiKey, 'weread'); if (d) apiKey = d.v; }
  if (w.cookie) { const d = decryptJSON(w.cookie, 'weread'); if (d) cookie = d.v; }
  return { apiKey, cookie };
}

function credsStatus(cfg) {
  const { apiKey, cookie } = readCreds(cfg);
  // 真实 weread 网页 Cookie 含 wr_skey 等字段且较长；仅判断“非空”会误导用户把 API Key 错当 Cookie
  const cookieOk = !!cookie && cookie.length >= 40 && /wr_skey=/.test(cookie);
  return { hasApiKey: !!apiKey, hasCookie: !!cookie, cookieOk, cookieLen: cookie ? cookie.length : 0 };
}

/* ---------------- 通用 https POST（JSON 或 文本回包） ---------------- */

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, 'Accept': 'application/json' }, headers || {}) },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = res.headers['content-type'] || '';
          if (ct.includes('application/json')) {
            try { resolve({ status: res.statusCode, json: JSON.parse(buf.toString('utf8')) }); }
            catch (e) { reject(e); }
          } else {
            resolve({ status: res.statusCode, text: buf.toString('utf8'), contentType: ct });
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

/* ---------------- Agent 网关（只读能力） ---------------- */

async function gateway(apiKey, apiName, params) {
  if (!apiKey) return { errcode: -1, errmsg: '未配置微信读书 API Key' };
  const body = Object.assign({ api_name: apiName, skill_version: SKILL_VERSION }, params || {});
  const r = await postJson(GATEWAY, body, { Authorization: `Bearer ${apiKey}` });
  if (r.json) return r.json;
  return { errcode: r.status || -2, errmsg: '网关返回异常', raw: r.text };
}

/* ---------------- 网页章节正文（内嵌阅读器用） ---------------- */

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function calcHash(data) {
  if (typeof data === 'number') data = String(data);
  if (typeof data !== 'string') return data;
  const dataMd5 = md5(data);
  let out = dataMd5.substr(0, 3);
  let tag, arr;
  if (/^\d*$/.test(data)) {
    const dataLen = data.length;
    const parts = [];
    for (let i = 0; i < dataLen; i += 9) {
      parts.push(parseInt(data.slice(i, Math.min(i + 9, dataLen)), 10).toString(16));
    }
    tag = '3'; arr = parts;
  } else {
    let hex = '';
    for (let i = 0; i < data.length; i++) hex += data.charCodeAt(i).toString(16);
    tag = '4'; arr = [hex];
  }
  out += tag;
  out += '2' + dataMd5.substr(dataMd5.length - 2, 2);
  for (let i = 0; i < arr.length; i++) {
    let lenHex = arr[i].length.toString(16);
    if (lenHex.length === 1) lenHex = '0' + lenHex;
    out += lenHex + arr[i];
    if (i < arr.length - 1) out += 'g';
  }
  if (out.length < 20) out += dataMd5.substr(0, 20 - out.length);
  out += md5(out).substr(0, 3);
  return out;
}

function _stringify(data, keys) {
  const all = !keys || keys.length === 0;
  const objKeys = Object.keys(data).sort();
  let result = '';
  for (const key of objKeys) {
    if (all || keys.indexOf(key) !== -1) {
      result += key + '=' + encodeURIComponent(data[key]) + '&';
    }
  }
  if (result.length > 0 && result.charAt(result.length - 1) === '&') result = result.slice(0, -1);
  return result;
}

function _sign(data) {
  let n1 = 0x15051505, n2 = 0x15051505;
  const strlen = data.length;
  for (let i = strlen - 1; i > 0; i -= 2) {
    n1 = 0x7fffffff & (n1 ^ (data.charCodeAt(i) << ((strlen - i) % 30)));
    n2 = 0x7fffffff & (n2 ^ (data.charCodeAt(i - 1) << (i % 30)));
  }
  return (n1 + n2).toString(16).toLowerCase();
}

function sign(data) { return _sign(_stringify(data)); }

function chk(data) {
  if (!data || data.length <= 32) return data;
  const header = data.slice(0, 32);
  const body = data.slice(32);
  return header === md5(body).toUpperCase() ? body : '';
}

function decrypt(data) {
  if (!data || typeof data !== 'string' || data.length <= 1) return '';
  let result = data.slice(1);
  const idx = (function () {
    const len = result.length;
    if (len < 4) return [];
    if (len < 11) return [0, 2];
    const n = Math.min(4, Math.ceil(len / 10));
    let bits = '';
    for (let i = len - 1; i > len - 1 - n; i--) {
      bits += parseInt(result.charCodeAt(i).toString(2), 4);
    }
    const mod = len - n - 2;
    const w = mod.toString().length;
    const arr = [];
    for (let i = 0; arr.length < 10 && i + w < bits.length; i += w) {
      let a = parseInt(bits.slice(i, i + w));
      arr.push(a % mod);
      a = parseInt(bits.slice(i + 1, i + 1 + w));
      arr.push(a % mod);
    }
    return arr;
  })();
  const chars = result.split('');
  for (let i = idx.length - 1; i >= 0; i -= 2) {
    for (let j = 1; j >= 0; j--) {
      const tmp = chars[idx[i] + j];
      chars[idx[i] + j] = chars[idx[i - 1] + j];
      chars[idx[i - 1] + j] = tmp;
    }
  }
  result = chars.join('');
  try { return Buffer.from(result, 'base64').toString('utf8'); }
  catch (e) { return ''; }
}

async function fetchSegment(cookie, bookId, chapterUid, seg) {
  // seg: 'e_0' | 'e_1' | 'e_2' | 'e_3' | 't_0' | 't_1'
  const st = (seg === 'e_2' || seg === 't_1') ? 1 : 0;
  const payload = {
    b: calcHash(bookId),
    c: calcHash(String(chapterUid)),
    r: Math.pow(Math.floor(10000 * Math.random()), 2),
    st,
    ct: Math.floor(Date.now() / 1000),
    ps: PS_FALLBACK,
    pc: PC_FALLBACK,
  };
  payload.s = sign(payload);
  const r = await postJson(`${WEB_BASE}/chapter/${seg}`, payload, { Cookie: cookie, Referer: 'https://weread.qq.com/' });
  if (r.text) {
    const body = chk(r.text);
    const empty = r.text.trim() === '{}' || body.length === 0;
    return { body, empty };
  }
  if (r.json && r.json.errcode) throw new Error(r.json.errmsg || '章节拉取失败');
  return { body: '', empty: true };
}

/**
 * 拉取并解密一个章节，返回 { title?, html, format }
 * 先尝试 EPUB（e_0..e_3），若正文为空则回退 TXT（t_0/t_1）。
 */
async function readChapter(cookie, bookId, chapterUid) {
  if (!cookie) return { err: '未配置微信读书网页 Cookie（请到「设置 → 微信读书」粘贴网页 Cookie）' };
  if (cookie.length < 40 || !/wr_skey=/.test(cookie)) {
    return { err: `网页 Cookie 似乎不完整（长度 ${cookie.length}，缺少 wr_skey 等字段）。请复制 weread.qq.com 登录后的【完整】Cookie，不要填 API Key（wrk-…）。` };
  }
  let html = '';
  let format = 'epub';
  let gotData = false;
  try {
    const [e0, e1, e3] = await Promise.all([
      fetchSegment(cookie, bookId, chapterUid, 'e_0'),
      fetchSegment(cookie, bookId, chapterUid, 'e_1'),
      fetchSegment(cookie, bookId, chapterUid, 'e_3'),
    ]);
    if (e0.body || e1.body || e3.body) gotData = true;
    const merged = (e0.body || '') + (e1.body || '') + (e3.body || '');
    html = decrypt(merged);
    if (!html || html.length < 20) {
      // 回退 TXT
      format = 'txt';
      const [t0, t1] = await Promise.all([
        fetchSegment(cookie, bookId, chapterUid, 't_0'),
        fetchSegment(cookie, bookId, chapterUid, 't_1'),
      ]);
      if (t0.body || t1.body) gotData = true;
      html = decrypt((t0.body || '') + (t1.body || ''));
    }
  } catch (e) {
    return { err: e.message || '章节拉取失败' };
  }
  if (!html || html.length < 20) {
    if (gotData) return { err: '正文已返回但解密失败（可能微信读书接口已变，或该书需购买 / 未加入书架）' };
    return { err: '服务器未返回正文：Cookie 可能已失效或为空。请到「设置 → 微信读书」重新复制网页 Cookie。' };
  }
  return { html, format };
}

module.exports = { gateway, readChapter, credsStatus, saveCreds, readCreds, calcHash, sign, decrypt, chk, md5 };
