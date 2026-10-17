'use strict';
/* ==========================================================================
   本地电子书库（对标 Calibre）渲染层：书库网格 + 书籍详情 + 内置阅读器
   依赖 app.js 暴露的全局：el / esc / toast / act / API / state / openModal /
   confirmDialog / openUrl / renderDetailBar
   ========================================================================== */

if (!state.eb) {
  state.eb = { books: [], q: '', selId: null, reader: null, loading: false };
}

const EB_READABLE = ['epub', 'pdf', 'txt'];

function ebArchive(url) {
  return 'archive://' + url.replace(/^\/+/, '');
}

/* ---------------------------------------------------------- 中栏：书库 */

function renderEbooksLibrary() {
  const scroll = document.getElementById('listScroll');
  if (!scroll) return;
  scroll.innerHTML = '';
  scroll.classList.add('eb-scroll');

  // 工具条
  const bar = el('div', 'eb-bar');
  const importBtn = el('button', 'tb primary', '＋ 导入书籍');
  importBtn.onclick = ebImport;
  const search = el('input', 'eb-search');
  search.placeholder = '搜索书名 / 作者…';
  search.value = state.eb.q || '';
  search.oninput = () => {
    state.eb.q = search.value.trim();
    ebRenderGrid(grid);
  };
  bar.appendChild(importBtn);
  bar.appendChild(search);
  scroll.appendChild(bar);

  const grid = el('div', 'eb-grid');
  scroll.appendChild(grid);
  ebRenderGrid(grid);
}

function ebRenderGrid(grid) {
  const q = (state.eb.q || '').toLowerCase();
  const books = (state.eb.books || []).filter((b) => {
    if (!q) return true;
    return (
      (b.title || '').toLowerCase().includes(q) ||
      (b.authors || []).join(' ').toLowerCase().includes(q)
    );
  });
  grid.innerHTML = '';
  if (!state.eb.books.length) {
    const empty = el('div', 'eb-empty');
    empty.innerHTML =
      '<div class="eb-empty-ico">📚</div><h3>书库还是空的</h3>' +
      '<p>点上方「导入书籍」把本地 EPUB / PDF / TXT / MOBI 等文件加进来。<br>' +
      'EPUB / PDF / TXT 可直接在应用内阅读；MOBI 等会调用本机 Calibre 或系统默认程序打开。</p>';
    grid.appendChild(empty);
    return;
  }
  if (!books.length) {
    grid.appendChild(el('div', 'eb-empty', '没有匹配的书。'));
    return;
  }
  for (const b of books) grid.appendChild(ebCard(b));
}

function ebCard(b) {
  const card = el('div', 'eb-card');
  const coverWrap = el('div', 'eb-cover');
  if (b.cover) {
    const img = el('img', 'eb-cover-img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = ebArchive(b.cover);
    img.onerror = () => { coverWrap.classList.add('eb-cover-fallback'); coverWrap.textContent = (b.title || '?').slice(0, 1); };
    coverWrap.appendChild(img);
  } else {
    coverWrap.classList.add('eb-cover-fallback');
    coverWrap.textContent = (b.title || '?').slice(0, 1);
  }
  card.appendChild(coverWrap);

  const info = el('div', 'eb-info');
  info.appendChild(el('div', 'eb-title', b.title || '(无标题)'));
  info.appendChild(el('div', 'eb-author', (b.authors || []).join('、') || '未知作者'));
  const meta = el('div', 'eb-meta');
  meta.appendChild(el('span', 'eb-badge', (b.format || '?').toUpperCase()));
  meta.appendChild(el('span', 'eb-size', b.sizeLabel || ''));
  info.appendChild(meta);
  if (b.progress && b.progress.percent > 0) {
    const pb = el('div', 'eb-progress');
    const fill = el('div', 'eb-progress-fill');
    fill.style.width = Math.min(100, Math.round(b.progress.percent)) + '%';
    pb.appendChild(fill);
    info.appendChild(pb);
  }
  card.appendChild(info);

  card.onclick = () => ebOpenBook(b.id);
  return card;
}

async function ebLoadBooks() {
  try {
    const list = await act(API.ebooks.list());
    state.eb.books = Array.isArray(list) ? list : [];
  } catch (e) {
    state.eb.books = [];
    toast('加载书库失败：' + (e.message || e), 'err');
  }
}

async function ebImport() {
  const r = await API.pickFiles('ebook');
  if (!r || r.canceled || !r.paths || !r.paths.length) return;
  state.eb.loading = true;
  toast('正在导入…', 'ok');
  try {
    const res = await act(API.ebooks.import(r.paths));
    const ok = (res || []).filter((x) => x && x.ok).length;
    const fail = (res || []).filter((x) => x && !x.ok);
    await ebLoadBooks();
    if (ok) toast(`已导入 ${ok} 本${fail.length ? `，${fail.length} 本失败` : ''}`, 'ok');
    else toast('导入失败：' + ((fail[0] && fail[0].error) || '未知错误'), 'err');
  } finally {
    state.eb.loading = false;
  }
}

/* ---------------------------------------------------------- 右栏：详情 / 阅读器 */

function renderEbooksDetail() {
  const detail = document.getElementById('detailScroll');
  if (!detail) return;
  detail.innerHTML = '';
  detail.classList.remove('ed-mode');

  const id = state.eb.selId;
  if (!id) {
    detail.appendChild(ebDetailEmpty());
    renderDetailBar([]);
    return;
  }
  // 阅读器优先
  if (state.eb.reader && state.eb.reader.id === id) {
    ebRenderReader(detail, state.eb.reader);
    renderDetailBar([]);
    return;
  }
  const book = state.eb.books.find((b) => b.id === id) || null;
  if (!book) {
    detail.appendChild(ebDetailEmpty());
    renderDetailBar([]);
    return;
  }
  ebRenderBookDetail(detail, book);
}

function ebDetailEmpty() {
  const d = el('div', 'eb-detail-empty');
  d.innerHTML = '<div class="eb-empty-ico">📖</div><p>从左侧选择一本书查看详情或开始阅读。</p>';
  return d;
}

function ebOpenBook(id) {
  state.eb.selId = id;
  state.eb.reader = null;
  renderEbooksDetail();
  renderEbooksLibrary(); // 刷新选中态
}

function ebRenderBookDetail(detail, book) {
  const wrap = el('div', 'eb-detail');
  // 头部
  const head = el('div', 'eb-detail-head');
  const coverWrap = el('div', 'eb-detail-cover');
  if (book.cover) {
    const img = el('img', 'eb-cover-img');
    img.src = ebArchive(book.cover);
    img.onerror = () => { coverWrap.classList.add('eb-cover-fallback'); coverWrap.textContent = (book.title || '?').slice(0, 1); };
    coverWrap.appendChild(img);
  } else {
    coverWrap.classList.add('eb-cover-fallback');
    coverWrap.textContent = (book.title || '?').slice(0, 1);
  }
  head.appendChild(coverWrap);
  const hinfo = el('div', 'eb-detail-info');
  hinfo.appendChild(el('h2', 'eb-detail-title', book.title || '(无标题)'));
  hinfo.appendChild(el('div', 'eb-detail-author', (book.authors || []).join('、') || '未知作者'));
  const m = el('div', 'eb-detail-meta');
  m.appendChild(el('span', 'eb-badge', (book.format || '?').toUpperCase()));
  if (book.meta && book.meta.language) m.appendChild(el('span', 'eb-tag', '语言 ' + book.meta.language));
  if (book.meta && book.meta.publisher) m.appendChild(el('span', 'eb-tag', book.meta.publisher));
  m.appendChild(el('span', 'eb-tag', book.sizeLabel || ''));
  if (book.addedDate) m.appendChild(el('span', 'eb-tag', '入库 ' + book.addedDate));
  hinfo.appendChild(m);
  if (book.tags && book.tags.length) {
    const tagRow = el('div', 'eb-detail-tags');
    book.tags.forEach((t) => tagRow.appendChild(el('span', 'eb-tag', '#' + t)));
    hinfo.appendChild(tagRow);
  }
  head.appendChild(hinfo);
  wrap.appendChild(head);

  if (book.meta && book.meta.description) {
    const desc = el('div', 'eb-detail-desc');
    desc.textContent = book.meta.description;
    wrap.appendChild(desc);
  }

  // 操作区
  const acts = el('div', 'eb-actions');
  const readable = EB_READABLE.includes((book.format || '').toLowerCase());
  const readBtn = el('button', 'tb primary', readable ? '开始阅读' : '打开 / 转换');
  readBtn.onclick = () => ebStartRead(book);
  acts.appendChild(readBtn);

  const editBtn = el('button', 'tb', '编辑元数据');
  editBtn.onclick = () => ebEditMeta(book);
  acts.appendChild(editBtn);

  const txtBtn = el('button', 'tb', '导出 TXT');
  txtBtn.onclick = () => ebExportTxt(book);
  acts.appendChild(txtBtn);

  if (readable) {
    const prog = el('button', 'tb', '清除进度');
    prog.onclick = async () => {
      await act(API.ebooks.progress(book.id, { href: '', percent: 0 }));
      book.progress = { href: '', percent: 0 };
      toast('已清除阅读进度', 'ok');
      ebRenderBookDetail(detail, book);
    };
    acts.appendChild(prog);
  } else {
    const convBtn = el('button', 'tb', '用 Calibre 转换…');
    convBtn.onclick = () => ebConvert(book);
    acts.appendChild(convBtn);
  }

  const delBtn = el('button', 'tb danger', '删除');
  delBtn.onclick = () => ebDelete(book);
  acts.appendChild(delBtn);
  wrap.appendChild(acts);

  // 目录（EPUB）
  if (book.format === 'epub' && book.meta && book.meta.toc && book.meta.toc.length) {
    const tocBox = el('div', 'eb-detail-toc');
    tocBox.appendChild(el('div', 'eb-detail-toc-h', '目录'));
    const list = el('div', 'eb-toc-list');
    book.meta.toc.forEach((t) => {
      const row = el('div', 'eb-toc-item');
      row.style.paddingLeft = 10 + (t.level || 0) * 16 + 'px';
      row.textContent = t.title || '(无标题)';
      row.onclick = () => { state.eb.selId = book.id; ebStartRead(book, t.href); };
      list.appendChild(row);
    });
    tocBox.appendChild(list);
    wrap.appendChild(tocBox);
  }

  detail.appendChild(wrap);
  renderDetailBar([]);
}

/* ---------------------------------------------------------- 开始阅读 */

async function ebStartRead(book, jumpHref) {
  const fmt = (book.format || '').toLowerCase();
  if (!EB_READABLE.includes(fmt)) {
    // 非内置可读：优先 Calibre 转换，否则系统打开
    const cal = await act(API.ebooks.calibre());
    if (cal && cal.available) {
      ebConvert(book);
    } else {
      const r = await act(API.ebooks.open(book.id));
      if (r && r.err) toast(r.err, 'err');
      else toast('已用系统默认程序打开', 'ok');
    }
    return;
  }
  // 进入阅读器
  state.eb.reader = {
    id: book.id,
    format: fmt,
    title: book.title,
    spine: (book.meta && book.meta.spine) || [],
    toc: (book.meta && book.meta.toc) || [],
    href: jumpHref || (book.progress && book.progress.href) || (book.meta && book.meta.spine && book.meta.spine[0] && book.meta.spine[0].href),
    index: 0,
    theme: state.eb.reader ? state.eb.reader.theme : 'sepia',
    fontScale: state.eb.reader ? state.eb.reader.fontScale : 1,
  };
  if (fmt === 'epub' && !state.eb.reader.href && state.eb.reader.spine.length) {
    state.eb.reader.href = state.eb.reader.spine[0].href;
  }
  // 计算起始索引
  if (fmt === 'epub' && state.eb.reader.href) {
    const i = state.eb.reader.spine.findIndex((s) => s.href === state.eb.reader.href);
    if (i >= 0) state.eb.reader.index = i;
  }
  renderEbooksDetail();
  renderEbooksLibrary();
}

/* ---------------------------------------------------------- 阅读器渲染 */

function ebRenderReader(detail, reader) {
  const fmt = reader.format;
  if (fmt === 'pdf') return ebRenderPdf(detail, reader);
  if (fmt === 'txt') return ebRenderTxt(detail, reader);
  return ebRenderEpub(detail, reader);
}

/* ---------- EPUB 阅读器 ---------- */
function ebRenderEpub(detail, reader) {
  const wrap = el('div', 'eb-reader');
  // 顶栏
  const top = el('div', 'eb-reader-top');
  const back = el('button', 'tb', '← 书库');
  back.onclick = () => { state.eb.reader = null; renderEbooksDetail(); renderEbooksLibrary(); };
  top.appendChild(back);
  const title = el('div', 'eb-reader-title', reader.title || '');
  top.appendChild(title);
  // 章节选择
  const chapSel = el('select', 'eb-chap-sel');
  reader.spine.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    const tocHit = reader.toc.find((t) => t.href === s.href);
    opt.textContent = (tocHit && tocHit.title) || `第 ${i + 1} 节`;
    chapSel.appendChild(opt);
  });
  chapSel.value = String(reader.index);
  chapSel.onchange = () => ebEpubGo(detail, reader, parseInt(chapSel.value, 10));
  top.appendChild(chapSel);
  const prev = el('button', 'tb', '上一节');
  prev.onclick = () => { if (reader.index > 0) ebEpubGo(detail, reader, reader.index - 1); };
  const next = el('button', 'tb', '下一节');
  next.onclick = () => { if (reader.index < reader.spine.length - 1) ebEpubGo(detail, reader, reader.index + 1); };
  top.appendChild(prev);
  top.appendChild(next);
  // 主题
  const themeBtn = el('button', 'tb', reader.theme === 'night' ? '☀' : '🌙');
  themeBtn.title = '切换主题';
  themeBtn.onclick = () => {
    reader.theme = reader.theme === 'night' ? 'sepia' : 'night';
    ebEpubApplyTheme(reader);
  };
  top.appendChild(themeBtn);
  // 字号
  const small = el('button', 'tb', 'A−');
  small.onclick = () => { reader.fontScale = Math.max(0.8, reader.fontScale - 0.1); ebEpubApplyFont(reader); };
  const big = el('button', 'tb', 'A＋');
  big.onclick = () => { reader.fontScale = Math.min(1.8, reader.fontScale + 0.1); ebEpubApplyFont(reader); };
  top.appendChild(small);
  top.appendChild(big);
  wrap.appendChild(top);

  const progress = el('div', 'eb-reader-progress');
  const pfill = el('div', 'eb-reader-progress-fill');
  pfill.style.width = Math.round(((reader.index + 1) / Math.max(1, reader.spine.length)) * 100) + '%';
  progress.appendChild(pfill);
  progress.appendChild(el('div', 'eb-reader-progress-label', `${reader.index + 1} / ${reader.spine.length}`));
  wrap.appendChild(progress);

  const frame = el('iframe', 'eb-reader-frame');
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups');
  wrap.appendChild(frame);
  detail.appendChild(wrap);

  reader._frame = frame;
  reader._pfill = pfill;
  reader._chapSel = chapSel;
  ebEpubApplyTheme(reader);
  ebEpubApplyFont(reader);
  ebEpubLoad(detail, reader, reader.index);
}

function ebEpubApplyTheme(reader) {
  const frame = reader._frame;
  if (!frame) return;
  const doc = frame.contentDocument;
  if (!doc) return;
  const body = doc.body;
  if (!body) return;
  if (reader.theme === 'night') {
    body.style.background = '#1b1b1b';
    body.style.color = '#cfcfcf';
  } else {
    body.style.background = '#f4ecd8';
    body.style.color = '#3a3026';
  }
}

function ebEpubApplyFont(reader) {
  const frame = reader._frame;
  if (!frame) return;
  const doc = frame.contentDocument;
  if (!doc) return;
  const body = doc.body;
  if (!body) return;
  body.style.fontSize = (17 * reader.fontScale).toFixed(1) + 'px';
  body.style.lineHeight = '1.8';
  body.style.padding = '28px 32px';
  body.style.margin = '0';
}

async function ebEpubGo(detail, reader, index) {
  if (index < 0 || index >= reader.spine.length) return;
  reader.index = index;
  reader.href = reader.spine[index].href;
  if (reader._chapSel) reader._chapSel.value = String(index);
  if (reader._pfill) reader._pfill.style.width = Math.round(((index + 1) / Math.max(1, reader.spine.length)) * 100) + '%';
  if (reader._pfill) reader._pfill.nextSibling.textContent = `${index + 1} / ${reader.spine.length}`;
  ebEpubLoad(detail, reader, index);
}

async function ebEpubLoad(detail, reader, index) {
  const s = reader.spine[index];
  if (!s) return;
  const r = await API.ebooks.chapter(reader.id, s.href);
  const frame = reader._frame;
  if (!frame) return;
  if (r && r.err) {
    frame.srcdoc = '<p style="color:#c0392b;padding:24px">无法读取章节：' + esc(r.err) + '</p>';
    return;
  }
  // 注入 <base> 让相对资源（图片/CSS/字体）从 archive:// 加载
  let html = r.html || '';
  const base = r.base || '';
  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `<base href="${base}"></head>`);
  } else {
    html = `<base href="${base}">` + html;
  }
  frame.srcdoc = html;
  // 等 iframe 加载后应用主题/字号 + 滚动进度 + 滚动监听
  frame.onload = () => {
    ebEpubApplyTheme(reader);
    ebEpubApplyFont(reader);
    const doc = frame.contentDocument;
    if (doc) {
      doc.addEventListener('scroll', () => {
        const max = doc.documentElement.scrollHeight - doc.documentElement.clientHeight;
        const pct = max > 0 ? (doc.documentElement.scrollTop / max) * 100 : 0;
        // 综合章节进度
        const overall = ((index + Math.min(1, pct / 100)) / Math.max(1, reader.spine.length)) * 100;
        API.ebooks.progress(reader.id, { href: s.href, percent: Math.round(overall * 10) / 10 }).catch(() => {});
      }, { passive: true });
      // 恢复阅读进度（按章节内百分比）—— 简化：回到顶部
      doc.documentElement.scrollTop = 0;
    }
  };
}

/* ---------- PDF 阅读器（Chromium 内置 PDF 视图） ---------- */
function ebRenderPdf(detail, reader) {
  const book = state.eb.books.find((b) => b.id === reader.id);
  const wrap = el('div', 'eb-reader');
  const top = el('div', 'eb-reader-top');
  const back = el('button', 'tb', '← 书库');
  back.onclick = () => { state.eb.reader = null; renderEbooksDetail(); renderEbooksLibrary(); };
  top.appendChild(back);
  top.appendChild(el('div', 'eb-reader-title', reader.title || ''));
  const ext = book ? book.fileName : '';
  const src = ebArchive(`books/${reader.id}/${ext}`);
  top.appendChild(el('div', 'eb-reader-progress-label', 'PDF（用内置视图阅读，进度不跨设备同步）'));
  wrap.appendChild(top);
  const frame = el('iframe', 'eb-reader-frame');
  frame.src = src;
  wrap.appendChild(frame);
  detail.appendChild(wrap);
  API.ebooks.progress(reader.id, { href: 'pdf', percent: 1 }).catch(() => {});
}

/* ---------- TXT 阅读器 ---------- */
function ebRenderTxt(detail, reader) {
  const wrap = el('div', 'eb-reader');
  const top = el('div', 'eb-reader-top');
  const back = el('button', 'tb', '← 书库');
  back.onclick = () => { state.eb.reader = null; renderEbooksDetail(); renderEbooksLibrary(); };
  top.appendChild(back);
  top.appendChild(el('div', 'eb-reader-title', reader.title || ''));
  const small = el('button', 'tb', 'A−');
  small.onclick = () => { reader.fontScale = Math.max(0.8, reader.fontScale - 0.1); body.style.fontSize = (17 * reader.fontScale).toFixed(1) + 'px'; };
  const big = el('button', 'tb', 'A＋');
  big.onclick = () => { reader.fontScale = Math.min(1.8, reader.fontScale + 0.1); body.style.fontSize = (17 * reader.fontScale).toFixed(1) + 'px'; };
  top.appendChild(small);
  top.appendChild(big);
  wrap.appendChild(top);
  const body = el('div', 'eb-txt-body');
  body.style.fontSize = (17 * reader.fontScale).toFixed(1) + 'px';
  wrap.appendChild(body);
  detail.appendChild(wrap);

  API.ebooks.txt(reader.id).then((r) => {
    if (r && r.err) { body.textContent = '无法读取：' + r.err; return; }
    body.textContent = r.text || '';
    body.onscroll = () => {
      const max = body.scrollHeight - body.clientHeight;
      const pct = max > 0 ? (body.scrollTop / max) * 100 : 0;
      API.ebooks.progress(reader.id, { href: 'txt', percent: Math.round(pct * 10) / 10 }).catch(() => {});
    };
  }).catch(() => { body.textContent = '读取失败'; });
}

/* ---------------------------------------------------------- 元数据编辑 / 删除 / 导出 / 转换 */

function ebEditMeta(book) {
  const body = el('div', 'eb-edit');
  const fTitle = el('input', 'eb-input'); fTitle.value = book.title || '';
  const fAuthor = el('input', 'eb-input'); fAuthor.value = (book.authors || []).join('、');
  const fTags = el('input', 'eb-input'); fTags.value = (book.tags || []).join('，');
  const row = (label, input) => {
    const d = el('div', 'eb-edit-row');
    d.appendChild(el('label', 'eb-edit-label', label));
    d.appendChild(input);
    return d;
  };
  body.appendChild(row('书名', fTitle));
  body.appendChild(row('作者（、分隔）', fAuthor));
  body.appendChild(row('标签（，分隔）', fTags));
  openModal({
    title: '编辑元数据',
    body,
    footer: [
      { label: '取消' },
      {
        label: '保存', primary: true, onclick: async (close) => {
          const r = await act(API.ebooks.meta(book.id, {
            title: fTitle.value, authors: fAuthor.value, tags: fTags.value,
          }));
          if (r && r.book) {
            Object.assign(book, r.book);
            toast('已保存', 'ok');
            close();
            renderEbooksDetail();
            renderEbooksLibrary();
          }
        },
      },
    ],
  });
}

async function ebDelete(book) {
  const ok = await confirmDialog({
    title: '删除这本书？',
    message: `确定从书库删除《${book.title || ''}》吗？`,
    detail: '书籍文件与元数据都会被移除，且不可恢复。',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  const r = await act(API.ebooks.delete(book.id));
  if (r && r.ok) {
    state.eb.books = state.eb.books.filter((b) => b.id !== book.id);
    state.eb.selId = null;
    state.eb.reader = null;
    toast('已删除', 'ok');
    renderEbooksDetail();
    renderEbooksLibrary();
  }
}

async function ebExportTxt(book) {
  const r = await act(API.ebooks.exportTxt(book.id));
  if (r && r.err) { toast(r.err, 'err'); return; }
  if (!r || !r.text) { toast('没有可导出的正文', 'err'); return; }
  // 用 Blob + a[download] 触发本机下载
  const blob = new Blob([r.text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (r.name || (book.title + '.txt'));
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  toast('已导出 TXT（开始下载）', 'ok');
}

async function ebConvert(book) {
  const cal = await act(API.ebooks.calibre());
  if (!cal || !cal.available) {
    openModal({
      title: '未检测到 Calibre',
      body: el('div', 'eb-edit',
        '本机没有安装 Calibre（ebook-convert），无法转换 MOBI / AZW 等格式。<br><br>' +
        '请先安装 Calibre：<br><a href="https://calibre-ebook.com/download" target="_blank" rel="noopener">https://calibre-ebook.com/download</a><br><br>' +
        '装好后重启 My Workbench，即可在此转换并阅读这些格式。'),
      footer: [{ label: '知道了' }],
    });
    return;
  }
  openModal({
    title: '用 Calibre 转换',
    body: (() => {
      const d = el('div', 'eb-edit');
      d.appendChild(el('div', 'eb-edit-row', `《${book.title || ''}》· ${book.format.toUpperCase()} →`));
      const sel = el('select', 'eb-input');
      ['epub', 'pdf', 'mobi', 'azw3', 'txt', 'docx'].forEach((f) => {
        if (f !== book.format) { const o = document.createElement('option'); o.value = f; o.textContent = f.toUpperCase(); sel.appendChild(o); }
      });
      d.appendChild(sel);
      return d;
    })(),
    footer: [
      { label: '取消' },
      {
        label: '转换', primary: true, onclick: async (close) => {
          const to = sel.value;
          toast('正在用 Calibre 转换（可能需要一会儿）…', 'ok');
          const r = await act(API.ebooks.convert(book.id, to));
          if (r && r.ok) {
            const idx = state.eb.books.findIndex((b) => b.id === book.id);
            if (idx >= 0) state.eb.books[idx] = await act(API.ebooks.get(book.id));
            toast('转换完成：' + (r.name || ''), 'ok');
            close();
            renderEbooksDetail();
            renderEbooksLibrary();
          } else if (r && r.err) {
            toast(r.err, 'err');
          }
        },
      },
    ],
  });
}
