'use strict';
/**
 * My Workbench —— AI 资讯聚合（分层信源 + 身份订阅）
 *
 * 设计要点：
 *  - 零依赖：RSS / Atom 用自带极简 XML 解析；JSON / API 源用自带 transform。
 *  - 分层信源：
 *      primary   一手信源（arXiv 多分类、HF Papers、实验室 Blog/Changelog、GitHub Trending、
 *                Hacker News、r/LocalLLaMA、r/MachineLearning）—— 用来「定事实」。
 *      secondary 二手信源（TLDR AI、The Rundown AI、Import AI、机器之心、量子位、36氪）—— 用来「定优先级」。
 *      reference X/Twitter 私有 List 与短视频 —— 仅作风向 / 娱乐参考，不自动抓取（手动登记）。
 *  - 身份订阅：开发者 / 产品运营 / 投资战略 / 纯兴趣 四套默认信源组合，可切换；切换后再手动勾选即进入「自定义」。
 *  - 每日节奏：进面板时若缓存超过 6 小时（或为空）自动刷新；另有手动「刷新」与「今日 / 全部」视图。
 *  - 订阅导出：把勾选的 RSS 源导出成 OPML，可放进任意 RSS 阅读器。
 *  - 数据落在本机资料库目录下的 ai-news-cache.json / ai-news-prefs.json，不联网也能看上次缓存。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CACHE_FILE = 'ai-news-cache.json';
const PREFS_FILE = 'ai-news-prefs.json';
const FETCH_TIMEOUT = 9000; // 单个信源抓取超时（毫秒）
const STALE_MS = 6 * 3600 * 1000; // 缓存超过 6 小时视为过期
const PER_SOURCE_CAP = 30; // 每个信源最多保留条数
const TOTAL_CAP = 900; // 总条数上限

/* =========================================================================
 * 信源目录（纯数据，可序列化；抓取逻辑在 FETCHERS / fetchSource）
 *   type: rss | atom | json | api | manual
 *   layer: primary | secondary | reference
 *   region: global | cn
 *   identities: 哪些身份默认勾选该信源
 * ========================================================================= */

const LAYERS = [
  { id: 'primary', label: '一手信源', sub: '定事实', desc: '官方与社区原始发布，优先看这里确认事实' },
  { id: 'secondary', label: '二手信源', sub: '定优先级', desc: 'Newsletter 与中文媒体，用来判断哪些事值得跟进' },
  { id: 'reference', label: '风向参考', sub: 'X / 短视频', desc: '仅作风向与娱乐参考，不自动抓取，需你手动登记' },
];

const SOURCES = [
  // ----------------------------- 一手信源 -----------------------------
  { id: 'arxiv-ai', name: 'arXiv · Artificial Intelligence', layer: 'primary', type: 'rss', region: 'global', url: 'https://rss.arxiv.org/rss/cs.AI', identities: ['dev', 'product', 'investor', 'hobby'] },
  { id: 'arxiv-lg', name: 'arXiv · Machine Learning', layer: 'primary', type: 'rss', region: 'global', url: 'https://rss.arxiv.org/rss/cs.LG', identities: ['dev', 'investor'] },
  { id: 'arxiv-cl', name: 'arXiv · Computation & Language', layer: 'primary', type: 'rss', region: 'global', url: 'https://rss.arxiv.org/rss/cs.CL', identities: ['dev', 'product'] },
  { id: 'arxiv-cv', name: 'arXiv · Computer Vision', layer: 'primary', type: 'rss', region: 'global', url: 'https://rss.arxiv.org/rss/cs.CV', identities: ['dev'] },
  { id: 'arxiv-statml', name: 'arXiv · Statistics ML', layer: 'primary', type: 'rss', region: 'global', url: 'https://rss.arxiv.org/rss/stat.ML', identities: ['dev'] },
  { id: 'hf-papers', name: 'Hugging Face Papers', layer: 'primary', type: 'json', region: 'global', url: 'https://huggingface.co/api/daily_papers', identities: ['dev', 'product', 'investor', 'hobby'] },
  { id: 'github-trending', name: 'GitHub Trending · AI', layer: 'primary', type: 'api', region: 'global', url: 'https://api.github.com/search/repositories', identities: ['dev', 'investor', 'hobby'] },
  { id: 'hacker-news', name: 'Hacker News', layer: 'primary', type: 'json', region: 'global', url: 'https://hn.algolia.com/api/v1/search', identities: ['dev', 'product', 'investor', 'hobby'] },
  { id: 'reddit-localllama', name: 'Reddit · r/LocalLLaMA', layer: 'primary', type: 'json', region: 'global', url: 'https://www.reddit.com/r/LocalLLaMA/hot.json', identities: ['dev', 'product', 'hobby'] },
  { id: 'reddit-ml', name: 'Reddit · r/MachineLearning', layer: 'primary', type: 'json', region: 'global', url: 'https://www.reddit.com/r/MachineLearning/hot.json', identities: ['dev', 'hobby'] },
  { id: 'openai', name: 'OpenAI Blog', layer: 'primary', type: 'rss', region: 'global', url: 'https://openai.com/blog/rss.xml', identities: ['dev', 'product', 'investor'] },
  { id: 'anthropic', name: 'Anthropic News', layer: 'primary', type: 'rss', region: 'global', url: 'https://www.anthropic.com/news/rss.xml', identities: ['dev', 'product', 'investor'] },
  { id: 'google-research', name: 'Google Research Blog', layer: 'primary', type: 'rss', region: 'global', url: 'https://research.google/blog/rss/', identities: ['dev', 'investor'] },
  { id: 'deepmind', name: 'Google DeepMind Blog', layer: 'primary', type: 'rss', region: 'global', url: 'https://deepmind.google/blog/rss.xml', identities: ['dev', 'investor'] },
  { id: 'microsoft', name: 'Microsoft Research', layer: 'primary', type: 'rss', region: 'global', url: 'https://www.microsoft.com/en-us/research/feed/', identities: ['dev', 'investor'] },
  { id: 'meta-ai', name: 'Meta AI Blog', layer: 'primary', type: 'rss', region: 'global', url: 'https://ai.meta.com/blog/rss/', identities: ['dev', 'investor'] },
  { id: 'nvidia', name: 'NVIDIA Blog', layer: 'primary', type: 'rss', region: 'global', url: 'https://blogs.nvidia.com/feed/', identities: ['dev'] },

  // ----------------------------- 二手信源 -----------------------------
  { id: 'tldr-ai', name: 'TLDR AI', layer: 'secondary', type: 'rss', region: 'global', url: 'https://tldr.tech/ai/rss', identities: ['dev', 'product', 'investor', 'hobby'] },
  { id: 'the-rundown', name: 'The Rundown AI', layer: 'secondary', type: 'rss', region: 'global', url: 'https://www.therundown.ai/rss', identities: ['product', 'investor'] },
  { id: 'import-ai', name: 'Import AI', layer: 'secondary', type: 'rss', region: 'global', url: 'https://importai.substack.com/feed', identities: ['dev', 'investor'] },
  { id: 'jiqizhixin', name: '机器之心', layer: 'secondary', type: 'rss', region: 'cn', url: 'https://www.jiqizhixin.com/rss', identities: ['product', 'investor', 'hobby'] },
  { id: 'qbitai', name: '量子位', layer: 'secondary', type: 'rss', region: 'cn', url: 'https://www.qbitai.com/feed', identities: ['product', 'hobby'] },
  { id: 'kr36', name: '36氪 · AI', layer: 'secondary', type: 'rss', region: 'cn', url: 'https://36kr.com/feed', identities: ['investor', 'product'] },

  // ----------------------------- 风向参考（手动登记，不抓取） -----------------------------
  { id: 'x-list', name: 'X / Twitter 私有 List', layer: 'reference', type: 'manual', region: 'global', url: '', identities: ['product', 'investor', 'hobby'], note: '在 X 上把你关注的 AI 账号编成私有 List，把 List 链接记到下方「我的风向登记」。' },
  { id: 'short-video', name: '短视频账号（抖音 / B站 / YouTube）', layer: 'reference', type: 'manual', region: 'global', url: '', identities: ['product', 'hobby'], note: '把常看的 AI 短视频博主账号记到下方「我的风向登记」，仅作娱乐参考。' },
];

const IDENTITIES = [
  { id: 'dev', label: '开发者', desc: '一手论文 / 代码 / 社区为主，二手只要 TLDR 与 Import AI' },
  { id: 'product', label: '产品运营', desc: '实验室动态 + 中文媒体 +  Newsletter，把握产品与功能走向' },
  { id: 'investor', label: '投资战略', desc: 'Newsletter + 实验室战略信号 + GitHub 牵引力 + HN 情绪' },
  { id: 'hobby', label: '纯兴趣', desc: '轻松均衡，多看社区与中文媒体，适当掺一点风向娱乐' },
];

const SOURCE_BY_ID = {};
SOURCES.forEach((s) => (SOURCE_BY_ID[s.id] = s));

/** 某身份默认勾选的信源 id 集合 */
function defaultSourcesFor(identityId) {
  const iden = IDENTITIES.find((x) => x.id === identityId);
  if (!iden) return SOURCES.filter((s) => s.layer !== 'reference').map((s) => s.id);
  return SOURCES.filter((s) => s.identities && s.identities.includes(identityId)).map((s) => s.id);
}

/* =========================================================================
 * 抓取与解析
 * ========================================================================= */

function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function matchAll(s, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s))) out.push(m[1] != null ? m[1] : m[0]);
  return out;
}

function tagText(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m) return '';
  return stripHtml(m[1]).trim();
}

function atomLink(entry) {
  const links = matchAll(entry, /<link\b([^>]*)\/?>/g);
  for (const attrs of links) {
    const rel = /rel=["']([^"']*)["']/i.exec(attrs);
    const href = /href=["']([^"']*)["']/i.exec(attrs);
    if (href && (!rel || /alternate/.test(rel[1]))) return href[1];
  }
  return '';
}

/** 解析 RSS 2.0 或 Atom，返回 [{ title, link, summary, date, author }] */
function parseFeed(xml) {
  if (!xml) return [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = isAtom
    ? matchAll(xml, /<entry>([\s\S]*?)<\/entry>/g)
    : matchAll(xml, /<item>([\s\S]*?)<\/item>/g);
  const items = [];
  for (const b of blocks) {
    const title = tagText(b, 'title');
    let link;
    if (isAtom) link = atomLink(b);
    else link = tagText(b, 'link') || tagText(b, 'guid');
    const summary =
      tagText(b, 'description') ||
      tagText(b, 'summary') ||
      tagText(b, 'content') ||
      tagText(b, isAtom ? 'content' : 'encoded');
    const date = tagText(b, 'pubDate') || tagText(b, 'updated') || tagText(b, 'published') || tagText(b, 'dc:date');
    let author = tagText(b, 'dc:creator') || tagText(b, 'author');
    if (!author && isAtom) {
      const a = /<author>([\s\S]*?)<\/author>/i.exec(b);
      if (a) author = stripHtml(a[1]).trim();
    }
    if (!title && !link) continue;
    items.push({ title: title || '(无标题)', link: (link || '').trim(), summary: summary.slice(0, 400), date: date || '', author: author || '' });
  }
  return items;
}

/** JSON / API 源各自的结果转换 */
const FETCHERS = {
  'hf-papers': (json) => {
    const list = Array.isArray(json) ? json : json && json.daily_papers ? json.daily_papers : [];
    return list.slice(0, PER_SOURCE_CAP).map((it) => {
      const p = it.paper || it;
      return {
        title: (p.title || '').trim() || '(无标题)',
        link: 'https://huggingface.co/papers/' + (p.id || it.id || ''),
        summary: stripHtml(p.summary || '').slice(0, 400),
        date: it.publishedAt || p.publishedAt || '',
        author: ((it.paperAuthors || []).map((a) => a.name).join(', ') || ''),
        upvotes: typeof p.upvotes === 'number' ? p.upvotes : undefined,
      };
    });
  },
  'hacker-news': (json) => {
    const hits = (json && json.hits) || [];
    return hits.slice(0, PER_SOURCE_CAP).map((h) => ({
      title: h.title || '(无标题)',
      link: h.url || 'https://news.ycombinator.com/item?id=' + h.objectID,
      summary: `▲ ${h.points || 0} 分 · 💬 ${h.num_comments || 0} 评`,
      date: h.created_at || '',
      author: h.author || '',
      upvotes: typeof h.points === 'number' ? h.points : undefined,
    }));
  },
  'reddit-localllama': redditFetcher,
  'reddit-ml': redditFetcher,
  'github-trending': (json, src) => {
    const items = (json && json.items) || [];
    const since = src._since || '';
    return items.slice(0, PER_SOURCE_CAP).map((it) => ({
      title: it.full_name || it.name || '(无标题)',
      link: it.html_url || '',
      summary: stripHtml(it.description || '').slice(0, 400),
      date: it.pushed_at || it.updated_at || '',
      author: it.owner ? it.owner.login : '',
      upvotes: typeof it.stargazers_count === 'number' ? it.stargazers_count : undefined,
      meta: it.language ? it.language : '',
    }));
  },
};

function redditFetcher(json) {
  const children = (json && json.data && json.data.children) || [];
  return children.slice(0, PER_SOURCE_CAP).map((c) => {
    const d = c.data || {};
    return {
      title: d.title || '(无标题)',
      link: 'https://www.reddit.com' + (d.permalink || ''),
      summary: stripHtml(d.selftext || '').slice(0, 400),
      date: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
      author: d.author || '',
      upvotes: typeof d.ups === 'number' ? d.ups : undefined,
    };
  });
}

async function fetchText(url) {
  if (typeof fetch !== 'function') throw new Error('当前运行环境不支持 fetch');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MyWorkbench/1.4 AI-news-reader',
        Accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

/** 抓取单个信源，返回 { ok, count, error, fetchedAt, items } */
async function fetchSource(src) {
  const fetchedAt = new Date().toISOString();
  if (src.type === 'manual') {
    return { ok: true, count: 0, error: '', fetchedAt, items: [], manual: true };
  }
  try {
    let items = [];
    if (src.type === 'rss' || src.type === 'atom') {
      const xml = await fetchText(src.url);
      items = parseFeed(xml);
    } else if (src.type === 'json' && FETCHERS[src.id]) {
      const json = await fetchJson(src.url);
      items = FETCHERS[src.id](json, src);
    } else if (src.type === 'api') {
      const json = await fetchJson(buildApiUrl(src));
      items = (FETCHERS[src.id] || ((j) => []))(json, src);
    }
    return { ok: true, count: items.length, error: '', fetchedAt, items };
  } catch (e) {
    return { ok: false, count: 0, error: (e && e.message) || String(e), fetchedAt, items: [] };
  }
}

/** GitHub Trending 用「近期 push + 高星」近似 trending（官方无 RSS） */
function buildApiUrl(src) {
  if (src.id === 'github-trending') {
    const d = new Date(Date.now() - 30 * 86400000);
    const since = d.toISOString().slice(0, 10);
    src._since = since;
    const q = encodeURIComponent(`topic:llm stars:>200 pushed:>=${since}`);
    return `${src.url}?q=${q}&sort=stars&order=desc&per_page=20`;
  }
  return src.url;
}

/* =========================================================================
 * 聚合与去重
 * ========================================================================= */

function normKey(link, title) {
  const base = (link || title || '').toLowerCase().replace(/\/$/, '');
  // 同一文章的不同 utm / 锚点视为重复
  const cleaned = base.split('#')[0].replace(/[?&](utm_[^=&]*|ref=[^&]*)=[^&]*/g, '');
  return cleaned || 't:' + crypto.createHash('md5').update(title || '').digest('hex').slice(0, 12);
}

function toIso(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function aggregate(results, sourcesMeta) {
  const byKey = new Map();
  for (const r of results) {
    for (const it of r.items || []) {
      const key = normKey(it.link, it.title);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        id: key.slice(0, 40),
        layer: sourcesMeta[r.id].layer,
        sourceId: r.id,
        sourceName: sourcesMeta[r.id].name,
        region: sourcesMeta[r.id].region,
        title: it.title || '(无标题)',
        link: it.link || '',
        summary: it.summary || '',
        author: it.author || '',
        date: toIso(it.date),
        upvotes: typeof it.upvotes === 'number' ? it.upvotes : undefined,
        meta: it.meta || '',
      });
    }
  }
  let items = Array.from(byKey.values());
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (items.length > TOTAL_CAP) items = items.slice(0, TOTAL_CAP);
  return items;
}

/* =========================================================================
 * 服务类
 * ========================================================================= */

class AiNewsService {
  constructor(libraryPath) {
    this.libraryPath = libraryPath;
    this.cacheFile = path.join(libraryPath, CACHE_FILE);
    this.prefsFile = path.join(libraryPath, PREFS_FILE);
    this.cache = { updatedAt: '', perSource: {}, items: [] };
    this.prefs = { identity: 'dev', enabledSources: defaultSourcesFor('dev'), readLater: [] };
  }

  async ensureDir() {
    await this.loadCache();
    await this.loadPrefs();
  }

  async loadCache() {
    try {
      const txt = await fsp.readFile(this.cacheFile, 'utf8');
      const j = JSON.parse(txt);
      if (j && Array.isArray(j.items)) this.cache = j;
    } catch {
      this.cache = { updatedAt: '', perSource: {}, items: [] };
    }
  }

  async saveCache() {
    await fsp.writeFile(this.cacheFile, JSON.stringify(this.cache), 'utf8');
  }

  async loadPrefs() {
    try {
      const txt = await fsp.readFile(this.prefsFile, 'utf8');
      const j = JSON.parse(txt);
      if (j && typeof j === 'object') {
        this.prefs = Object.assign({ identity: 'dev', enabledSources: [], readLater: [] }, j);
        // 兼容：enabledSources 缺失时按当前身份补全
        if (!Array.isArray(this.prefs.enabledSources) || !this.prefs.enabledSources.length) {
          this.prefs.enabledSources = defaultSourcesFor(this.prefs.identity);
        }
      }
    } catch {
      this.prefs = { identity: 'dev', enabledSources: defaultSourcesFor('dev'), readLater: [] };
    }
  }

  async savePrefs() {
    await fsp.writeFile(this.prefsFile, JSON.stringify(this.prefs), 'utf8');
  }

  getCatalog() {
    return {
      sources: SOURCES.map((s) => ({
        id: s.id,
        name: s.name,
        layer: s.layer,
        type: s.type,
        region: s.region,
        url: s.url,
        note: s.note || '',
      })),
      layers: LAYERS,
      identities: IDENTITIES,
    };
  }

  getPrefs() {
    return Object.assign({}, this.prefs);
  }

  /** 切换身份：用该身份的默认信源集合覆盖 enabledSources，并把 identity 记下 */
  async setIdentity(identityId) {
    this.prefs.identity = identityId;
    this.prefs.enabledSources = defaultSourcesFor(identityId);
    await this.savePrefs();
    return this.getPrefs();
  }

  /** 勾选 / 取消某个信源；任何手动改动都进入「自定义」身份 */
  async toggleSource(sourceId, enabled) {
    const set = new Set(this.prefs.enabledSources);
    if (enabled) set.add(sourceId);
    else set.delete(sourceId);
    this.prefs.enabledSources = Array.from(set);
    this.prefs.identity = 'custom';
    await this.savePrefs();
    return this.getPrefs();
  }

  async toggleReadLater(item) {
    const list = this.prefs.readLater || [];
    const key = normKey(item.link, item.title);
    const idx = list.findIndex((x) => normKey(x.link, x.title) === key);
    if (idx >= 0) list.splice(idx, 1);
    else list.unshift(Object.assign({ savedAt: new Date().toISOString() }, item));
    this.prefs.readLater = list;
    await this.savePrefs();
    return this.getPrefs();
  }

  /** 刷新：只抓 enabledSources；并行 + 每源超时；返回最新缓存 */
  async refresh() {
    const enabled = (this.prefs.enabledSources || []).filter((id) => SOURCE_BY_ID[id]);
    const sourcesMeta = {};
    const sources = enabled.map((id) => {
      const s = Object.assign({}, SOURCE_BY_ID[id]);
      sourcesMeta[id] = s;
      return s;
    });
    const settled = await Promise.allSettled(sources.map((s) => fetchSource(s)));
    const perSource = {};
    const results = [];
    settled.forEach((r, i) => {
      const s = sources[i];
      if (r.status === 'fulfilled') {
        const res = r.value;
        perSource[s.id] = { ok: res.ok, count: res.count, error: res.error, fetchedAt: res.fetchedAt, manual: !!res.manual };
        if (res.items && res.items.length) results.push(Object.assign({ id: s.id }, res));
      } else {
        perSource[s.id] = { ok: false, count: 0, error: String(r.reason), fetchedAt: new Date().toISOString(), manual: false };
      }
    });
    const items = aggregate(results, sourcesMeta);
    this.cache = { updatedAt: new Date().toISOString(), perSource, items };
    await this.saveCache();
    return this.cache;
  }

  /** 缓存是否过期（用于进面板时自动刷新判断） */
  isStale() {
    if (!this.cache.updatedAt) return true;
    const dt = Date.now() - new Date(this.cache.updatedAt).getTime();
    return Number.isNaN(dt) || dt > STALE_MS;
  }

  getCache() {
    return this.cache;
  }
}

module.exports = { AiNewsService, SOURCES, LAYERS, IDENTITIES, parseFeed, stripHtml };
