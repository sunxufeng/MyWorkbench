'use strict';
/**
 * My Workbench —— 本地电子书库（对标 Calibre 的本地化、离线化核心能力）
 *
 * 设计要点：
 *  - 书文件与元数据都放在资料库目录下的 books/<id>/ 子目录，复用 archive:// 协议安全访问。
 *  - EPUB 在导入时整体解压到 books/<id>/extracted/，章节正文与图片/CSS/字体由渲染层直接通过
 *    archive:// 加载，无需把整本书塞进 IPC。
 *  - 元数据 / 进度记录在资料库根目录的 books.json（与 archive.json 解耦，互不污染）。
 *  - MOBI/AZW3 等无法在本机直接渲染的格式：检测本机是否安装 Calibre（ebook-convert），
 *    装了就走 Calibre 打开 / 转换；没装则退回「系统默认程序打开」并提示安装。
 *  - 任意格式都能「导出为 TXT」（EPUB 抽正文、TXT 直出），无需外部依赖。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const JSZip = require('jszip');

const BOOKS_FILE = 'books.json';
const READABLE = ['epub', 'pdf', 'txt']; // 本应用内置阅读器可直接读的格式
const CONVERTIBLE = ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'fb2', 'docx', 'rtf', 'html', 'lit', 'txt'];

function uid(prefix = 'b_') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function safeName(name) {
  return String(name || 'book')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 120);
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** 把 EPUB/OPF 里的相对 href 解析成 zip 内（也是 extracted 目录内）的标准相对路径 */
function resolveHref(baseDir, href) {
  // 去掉 fragment
  const clean = (href || '').split('#')[0];
  if (!clean) return '';
  const joined = path.posix.join(baseDir.replace(/\\/g, '/'), clean);
  // 规范化（去 ./ 与 ../）
  const parts = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** 极简 XML 标签提取：取第一个匹配标签的内部文本（用于 OPF 元数据） */
function tagText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m) return '';
  return stripTags(m[1]).trim();
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析 EPUB 的目录（优先 nav.xhtml，回退 NCX），返回扁平 [{ title, href, level }]（href 为 zip 相对路径） */
async function parseToc(opfDir, zip, rootXml) {
  // 1) nav.xhtml（EPUB3）：nav 通常在独立文件里，先按 manifest 定位再读其内容
  const navHref = findManifestHref(zip, rootXml, opfDir, 'nav');
  if (navHref) {
    const navDir = path.posix.dirname(navHref);
    const navXml = await readZipText(zip, navHref);
    if (navXml) {
      const navMatch = /<nav[^>]*epub:type=["']toc["'][^>]*>([\s\S]*?)<\/nav>/i.exec(navXml);
      const navInner = navMatch ? navMatch[1] : navXml;
      const items = [];
      parseNavOl(navInner, navDir, 0, items);
      if (items.length) return items;
    }
  }
  // 2) NCX（EPUB2）
  const ncxHref = findManifestHref(zip, rootXml, opfDir, 'ncx') || findNcx(zip);
  if (ncxHref) {
    const ncxXml = await readZipText(zip, ncxHref);
    if (ncxXml) {
      const items = [];
      parseNcx(ncxXml, opfDir, items);
      if (items.length) return items;
    }
  }
  return [];
}

function findManifestHref(zip, opfXml, opfDir, prop) {
  // 在 manifest 里找 properties 含 prop 的 item，或在 media-type 为 ncx 的 item
  const itemRe = /<item\s+([^>]*?)\/?>/gi;
  let m;
  while ((m = itemRe.exec(opfXml))) {
    const attrs = m[1];
    const href = /href=["']([^"']+)["']/i.exec(attrs);
    const props = /properties=["']([^"']+)["']/i.exec(attrs);
    const mt = /media-type=["']([^"']+)["']/i.exec(attrs);
    if (!href) continue;
    if (prop === 'nav' && props && /nav/.test(props[1])) return resolveHref(opfDir, href[1]);
    if (prop === 'ncx') {
      const isNcx = (mt && /ncx/.test(mt[1])) || /\.ncx$/i.test(href[1]);
      if (isNcx) return resolveHref(opfDir, href[1]);
    }
  }
  return null;
}

function findNcx(zip) {
  const names = Object.keys(zip.files).filter((n) => /toc\.ncx$/i.test(n));
  return names[0] || null;
}

function parseNavOl(xml, baseDir, level, out) {
  const olRe = /<ol[^>]*>([\s\S]*?)<\/ol>/gi;
  let m;
  while ((m = olRe.exec(xml))) {
    const olInner = m[1];
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRe.exec(olInner))) {
      const liInner = li[1];
      const a = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(liInner);
      if (a) {
        out.push({ title: stripTags(a[2]) || '(无标题)', href: resolveHref(baseDir, a[1]), level });
        // 处理嵌套 ol（子目录）
        const childOl = /<ol[^>]*>([\s\S]*?)<\/ol>/i.exec(liInner);
        if (childOl) parseNavOl(childOl[1], baseDir, level + 1, out);
      }
    }
  }
}

function parseNcx(xml, baseDir, out, level = 0) {
  const npRe = /<navPoint[^>]*>([\s\S]*?)<\/navPoint>/gi;
  let m;
  while ((m = npRe.exec(xml))) {
    const inner = m[1];
    const text = /<text>([\s\S]*?)<\/text>/i.exec(inner);
    const content = /<content\s+src=["']([^"']+)["']/i.exec(inner);
    if (text && content) {
      out.push({ title: stripTags(text[1]) || '(无标题)', href: resolveHref(baseDir, content[1]), level });
    }
    // 嵌套 navPoint
    const child = /<navPoint[^>]*>([\s\S]*?)<\/navPoint>/i.exec(inner);
    if (child) parseNcx(inner, baseDir, out, level + 1);
  }
}

function readZipText(zip, relPath) {
  const f = zip.file(relPath);
  if (!f) return '';
  return f.async('string');
}

function findManifestCover(opfXml) {
  // 1) <item properties="cover-image" href="...">
  const itemRe = /<item\s+([^>]*?)\/?>/gi;
  let m;
  while ((m = itemRe.exec(opfXml))) {
    const attrs = m[1];
    const props = /properties=["']([^"']+)["']/i.exec(attrs);
    const href = /href=["']([^"']+)["']/i.exec(attrs);
    if (props && /cover-image/.test(props[1]) && href) return href[1];
  }
  // 2) <meta name="cover" content="ID"/> 再找该 ID 的 item href
  const metaRe = /<meta\s+name=["']cover["']\s+content=["']([^"']+)["']/i.exec(opfXml);
  if (metaRe) {
    const id = metaRe[1];
    const itRe2 = /<item\s+([^>]*?)\/?>/gi;
    while ((m = itRe2.exec(opfXml))) {
      const attrs = m[1];
      const iid = /id=["']([^"']+)["']/i.exec(attrs);
      const href = /href=["']([^"']+)["']/i.exec(attrs);
      if (iid && iid[1] === id && href) return href[1];
    }
  }
  return null;
}

function getSpine(opfXml) {
  const spineRe = /<spine[^>]*>([\s\S]*?)<\/spine>/i.exec(opfXml);
  if (!spineRe) return [];
  const ids = [];
  const itemRefRe = /<itemref\s+idref=["']([^"']+)["'][^>]*\/?>/gi;
  let m;
  while ((m = itemRefRe.exec(spineRe[1]))) ids.push(m[1]);
  // id → href
  const map = {};
  const itemRe = /<item\s+([^>]*?)\/?>/gi;
  while ((m = itemRe.exec(opfXml))) {
    const attrs = m[1];
    const id = /id=["']([^"']+)["']/i.exec(attrs);
    const href = /href=["']([^"']+)["']/i.exec(attrs);
    if (id && href) map[id[1]] = href[1];
  }
  return ids.map((id) => ({ id, href: map[id] || '' })).filter((x) => x.href);
}

class EbookService {
  constructor(libraryPath) {
    this.libraryPath = libraryPath;
    this.booksDir = path.join(libraryPath, 'books');
    this.booksFile = path.join(libraryPath, BOOKS_FILE);
    this.prefsFile = path.join(libraryPath, 'ebooks-prefs.json');
    this.data = { books: [] };
    this.prefs = {};
  }

  async ensureBooksDir() {
    await fsp.mkdir(this.booksDir, { recursive: true });
    await this.load();
    await this.loadPrefs();
  }

  async load() {
    try {
      const txt = await fsp.readFile(this.booksFile, 'utf8');
      const j = JSON.parse(txt);
      if (j && Array.isArray(j.books)) this.data = j;
      else this.data = { books: [] };
    } catch {
      this.data = { books: [] };
    }
  }

  async save() {
    await fsp.writeFile(this.booksFile, JSON.stringify(this.data, null, 2), 'utf8');
  }

  /* ---- 偏好（视图模式等，与 books.json 解耦） ---- */
  async loadPrefs() {
    try {
      const txt = await fsp.readFile(this.prefsFile, 'utf8');
      const j = JSON.parse(txt);
      this.prefs = j && typeof j === 'object' ? j : {};
    } catch {
      this.prefs = {};
    }
  }

  async savePrefs() {
    await fsp.writeFile(this.prefsFile, JSON.stringify(this.prefs, null, 2), 'utf8');
  }

  getAllPrefs() {
    return Object.assign({}, this.prefs);
  }

  async setPref(key, val) {
    this.prefs[key] = val;
    await this.savePrefs();
    return this.getAllPrefs();
  }

  list() {
    return this.data.books.slice().sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  }

  get(id) {
    return this.data.books.find((b) => b.id === id) || null;
  }

  bookDir(id) {
    return path.join(this.booksDir, id);
  }

  /** 返回书籍在 archive:// 下的根路径（渲染层拼接资源用） */
  bookArchiveRoot(id) {
    return `books/${id}`;
  }

  async importBooks(paths) {
    const results = [];
    for (const p of paths || []) {
      try {
        results.push(await this.importOne(p));
      } catch (e) {
        results.push({ ok: false, path: p, error: e.message || String(e) });
      }
    }
    await this.save();
    return { ok: true, items: results };
  }

  async importOne(p) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('文件不存在');
    const ext = extOf(p);
    const id = uid();
    const dir = this.bookDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const originalName = safeName(path.basename(p));
    const storedName = originalName; // 保留原扩展名
    const dest = path.join(dir, storedName);
    await fsp.copyFile(p, dest);
    const stat = fs.statSync(dest);

    const book = {
      id,
      title: path.basename(p, '.' + ext) || originalName,
      authors: [],
      format: ext,
      fileName: storedName,
      size: stat.size,
      sizeLabel: humanSize(stat.size),
      addedAt: new Date().toISOString(),
      addedDate: todayStr(),
      cover: null,
      tags: [],
      progress: { href: '', percent: 0, updatedAt: '' },
      meta: {},
      bookmarks: [],
    };

    if (ext === 'epub') {
      await this.parseEpub(book, dest);
    }
    // pdf / txt / mobi 等：无内置元数据解析，标题用文件名（用户可改）

    this.data.books.push(book);
    return { ok: true, book };
  }

  async parseEpub(book, epubPath) {
    const buf = await fsp.readFile(epubPath);
    const zip = await JSZip.loadAsync(buf);
    // container.xml → opf 路径
    const container = await readZipText(zip, 'META-INF/container.xml');
    const opfMatch = /full-path=["']([^"']+)["']/i.exec(container || '');
    if (!opfMatch) throw new Error('EPUB 缺少 OPF（非标准文件）');
    const opfRel = opfMatch[1];
    const opfDir = path.posix.dirname(opfRel);
    const opfXml = await readZipText(zip, opfRel);
    if (!opfXml) throw new Error('无法读取 OPF');

    // 元数据
    const title = tagText(opfXml, 'dc:title') || tagText(opfXml, 'title');
    if (title) book.title = title;
    const creator = tagText(opfXml, 'dc:creator') || tagText(opfXml, 'creator');
    if (creator) book.authors = creator.split(/[;,&]/).map((s) => s.trim()).filter(Boolean);
    book.meta.language = tagText(opfXml, 'dc:language');
    book.meta.publisher = tagText(opfXml, 'dc:publisher');
    book.meta.description = tagText(opfXml, 'dc:description');

    // 封面
    const coverHref = findManifestCover(opfXml);
    if (coverHref) {
      const coverRel = resolveHref(opfDir, coverHref);
      const coverFile = zip.file(coverRel);
      if (coverFile) {
        const cext = extOf(coverRel) || 'jpg';
        const coverName = 'cover.' + (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(cext) ? cext : 'jpg');
        const cdest = path.join(this.bookDir(book.id), coverName);
        await fsp.writeFile(cdest, await coverFile.async('nodebuffer'));
        book.cover = `books/${book.id}/${coverName}`;
      }
    }

    // 整包解压到 extracted/（章节与其图片/CSS/字体一并保留）
    const extDir = path.join(this.bookDir(book.id), 'extracted');
    await fsp.mkdir(extDir, { recursive: true });
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (entry.dir) continue;
      const target = path.join(extDir, name);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, await entry.async('nodebuffer'));
    }

    // 阅读顺序 + 目录
    const spine = getSpine(opfXml).map((s) => ({ id: s.id, href: resolveHref(opfDir, s.href) }));
    book.meta.spine = spine;
    const toc = (await parseToc(opfDir, zip, opfXml)).map((t) => ({ title: t.title, href: t.href, level: t.level }));
    book.meta.toc = toc.length ? toc : spine.map((s, i) => ({ title: `第 ${i + 1} 节`, href: s.href, level: 0 }));
    // 首章
    if (spine.length) book.progress.href = spine[0].href;
  }

  async updateMeta(id, patch) {
    const b = this.get(id);
    if (!b) return { ok: false, error: '未找到书籍' };
    if (patch.title != null) b.title = String(patch.title).trim() || b.title;
    if (patch.authors != null) {
      b.authors = Array.isArray(patch.authors)
        ? patch.authors.map((s) => String(s).trim()).filter(Boolean)
        : String(patch.authors).split(/[;,&]/).map((s) => s.trim()).filter(Boolean);
    }
    if (patch.tags != null) {
      b.tags = Array.isArray(patch.tags)
        ? patch.tags.map((s) => String(s).trim()).filter(Boolean)
        : String(patch.tags).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
    if (patch.format != null) b.format = String(patch.format).toLowerCase();
    await this.save();
    return { ok: true, book: b };
  }

  async deleteBook(id) {
    const idx = this.data.books.findIndex((b) => b.id === id);
    if (idx < 0) return { ok: false, error: '未找到书籍' };
    this.data.books.splice(idx, 1);
    await this.save();
    await fsp.rm(this.bookDir(id), { recursive: true, force: true }).catch(() => {});
    return { ok: true };
  }

  async setProgress(id, progress) {
    const b = this.get(id);
    if (!b) return { ok: false };
    b.progress = Object.assign({}, b.progress, progress, { updatedAt: new Date().toISOString() });
    await this.save();
    return { ok: true, book: b };
  }

  /** 读取 EPUB 某一章节正文（zip 相对路径），返回 { html, base, contentType } */
  async readChapter(id, href) {
    const b = this.get(id);
    if (!b || b.format !== 'epub') return { err: '不是 EPUB 或书籍不存在' };
    const abs = path.join(this.bookDir(id), 'extracted', href);
    if (!abs.startsWith(this.bookDir(id))) return { err: '非法路径' };
    if (!fs.existsSync(abs)) return { err: '章节文件不存在' };
    const html = await fsp.readFile(abs, 'utf8');
    const base = `archive://books/${id}/extracted/${path.posix.dirname(href)}/`;
    return { html, base, contentType: 'application/xhtml+xml' };
  }

  /** 读取 TXT 正文 */
  async readTxt(id) {
    const b = this.get(id);
    if (!b) return { err: '书籍不存在' };
    const abs = path.join(this.bookDir(id), b.fileName);
    if (!fs.existsSync(abs)) return { err: '文件不存在' };
    let text = await fsp.readFile(abs, 'utf8');
    // 探测编码（极简）：若含大量乱码特征则尝试 gbk？Node 无 gbk，跳过。
    return { text, name: b.fileName };
  }

  /** 导出为 TXT：EPUB 抽取全部章节正文并清洗；TXT 直出；其余返回 null */
  async exportTxt(id) {
    const b = this.get(id);
    if (!b) return { err: '书籍不存在' };
    if (b.format === 'txt') {
      const r = await this.readTxt(id);
      return { text: r.text, name: b.title + '.txt' };
    }
    if (b.format === 'epub' && b.meta && b.meta.spine) {
      const parts = [];
      for (const s of b.meta.spine) {
        const abs = path.join(this.bookDir(id), 'extracted', s.href);
        if (fs.existsSync(abs)) {
          let h = await fsp.readFile(abs, 'utf8');
          // 去脚本/样式，保留文本与段落
          h = h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
          h = h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n').replace(/<[^>]+>/g, '');
          h = h.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
          h = h.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
          if (h) parts.push(h);
        }
      }
      return { text: parts.join('\n\n'), name: b.title + '.txt' };
    }
    return { err: '该格式暂不支持内置导出 TXT（可安装 Calibre 后转换）' };
  }

  /** 检测本机是否安装 Calibre 的 ebook-convert */
  calibreAvailable() {
    return new Promise((resolve) => {
      const bins = ['ebook-convert', '/Applications/calibre.app/Contents/MacOS/ebook-convert'];
      let done = false;
      for (const bin of bins) {
        execFile(bin, ['--version'], { timeout: 4000 }, (err) => {
          if (!done) {
            done = true;
            resolve(!err);
          }
        });
      }
      setTimeout(() => { if (!done) { done = true; resolve(false); } }, 4200);
    });
  }

  /** 用 Calibre 转换书籍到目标格式（需已安装 Calibre） */
  async convertBook(id, to) {
    const b = this.get(id);
    if (!b) return { err: '书籍不存在' };
    const avail = await this.calibreAvailable();
    if (!avail) return { err: '未检测到 Calibre（ebook-convert）。请先安装 Calibre：https://calibre-ebook.com/download' };
    const src = path.join(this.bookDir(id), b.fileName);
    const outPath = path.join(this.bookDir(id), b.title.replace(/[\\/:*?"<>|]/g, '_') + '.' + to);
    const bin = 'ebook-convert';
    return new Promise((resolve) => {
      execFile(bin, [src, outPath], { timeout: 120000 }, async (err) => {
        if (err) return resolve({ err: '转换失败：' + (err.message || err) });
        await this.updateMeta(id, { format: to });
        // 记录转换产物文件名，便于后续打开
        b.convertedName = path.basename(outPath);
        await this.save();
        resolve({ ok: true, outPath, name: path.basename(outPath) });
      });
    });
  }

  /** 在系统默认程序中打开（用于 PDF / MOBI 等本应用不直接渲染的格式） */
  async openInSystem(id) {
    const b = this.get(id);
    if (!b) return { err: '书籍不存在' };
    const abs = path.join(this.bookDir(id), b.convertedName || b.fileName);
    if (!fs.existsSync(abs)) return { err: '文件不存在' };
    const { shell } = require('electron');
    shell.openPath(abs);
    return { ok: true };
  }

  /* ----------------------------- 书签 ----------------------------- */

  async addBookmark(id, payload = {}) {
    const b = this.get(id);
    if (!b) return { ok: false, error: '未找到书籍' };
    if (!Array.isArray(b.bookmarks)) b.bookmarks = [];
    const bm = {
      id: uid('bm_'),
      href: payload.href || (b.progress && b.progress.href) || '',
      percent: Math.max(0, Math.min(100, Number(payload.percent) || 0)),
      note: String(payload.note || '').slice(0, 200),
      addedAt: new Date().toISOString(),
    };
    b.bookmarks.push(bm);
    await this.save();
    return { ok: true, book: b, bookmark: bm };
  }

  async deleteBookmark(id, bmId) {
    const b = this.get(id);
    if (!b) return { ok: false, error: '未找到书籍' };
    if (!Array.isArray(b.bookmarks)) return { ok: true, book: b };
    b.bookmarks = b.bookmarks.filter((x) => x.id !== bmId);
    await this.save();
    return { ok: true, book: b };
  }

  /* --------------------------- 全文搜索 --------------------------- */

  /** 抽取单章纯文本（去脚本/样式/标签 + 实体解码） */
  async chapterText(id, href) {
    const b = this.get(id);
    if (!b) return '';
    const abs = path.join(this.bookDir(id), 'extracted', href);
    if (!abs.startsWith(this.bookDir(id))) return '';
    if (!fs.existsSync(abs)) return '';
    let h = await fsp.readFile(abs, 'utf8');
    h = h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    h = h.replace(/<[^>]+>/g, ' ');
    h = h.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    h = h.replace(/[ \t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return h;
  }

  /** 全书搜索：遍历 spine 每章抽文本做不区分大小写匹配，返回含摘要的结果 */
  async search(id, q) {
    const b = this.get(id);
    if (!b) return { err: '书籍不存在' };
    if (b.format !== 'epub') return { err: '仅 EPUB 支持全文搜索' };
    const term = String(q || '').trim().toLowerCase();
    if (!term) return { results: [] };
    const results = [];
    const spine = (b.meta && b.meta.spine) || [];
    const toc = (b.meta && b.meta.toc) || [];
    for (let i = 0; i < spine.length; i++) {
      const s = spine[i];
      const txt = await this.chapterText(id, s.href);
      if (!txt) continue;
      const lower = txt.toLowerCase();
      const hit = lower.indexOf(term);
      if (hit < 0) continue;
      const start = Math.max(0, hit - 30);
      const end = Math.min(txt.length, hit + term.length + 90);
      let snippet = txt.slice(start, end).replace(/\s+/g, ' ');
      if (start > 0) snippet = '…' + snippet;
      if (end < txt.length) snippet = snippet + '…';
      const tocHit = toc.find((t) => t.href === s.href);
      results.push({
        href: s.href,
        chapterIndex: i,
        title: (tocHit && tocHit.title) || `第 ${i + 1} 节`,
        snippet,
      });
    }
    return { results };
  }
}

module.exports = { EbookService, READABLE, CONVERTIBLE };
