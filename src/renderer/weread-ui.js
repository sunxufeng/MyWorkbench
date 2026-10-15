'use strict';
/* ==========================================================================
   微信读书（weread）渲染层：数据看板 + 内嵌阅读器
   依赖 app.js 暴露的全局：el / esc / toast / act / API / state / openModal /
   confirmDialog / openUrl / mdToHtml
   ========================================================================== */

/* ---------------------------------------------------------- 接口助手 */

async function wrApi(apiName, params) {
  const r = await API.weread.call(apiName, params || {});
  if (!r || r.ok === false) throw new Error((r && r.error) || '微信读书接口调用失败');
  if (r.errcode && r.errcode !== 0) throw new Error(r.errmsg || '接口错误 ' + r.errcode);
  return r;
}

function wrData(r) {
  return r && r.data != null ? r.data : r;
}

function wrErrMsg(e) {
  return (e && e.message) || String(e);
}

/** 轻量净化：去掉 <script>/<iframe> 与所有 on* 属性，降低本地注入风险 */
function wrSanitize(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<\s*(script|iframe|object|embed|link|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*(script|iframe|object|embed)\b[^>]*>/gi, '');
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/javascript:/gi, '');
  return s;
}

async function wrEnsureConfig() {
  if (state.wr.ready && state.wr.status) return state.wr.status;
  const r = await act(API.weread.status());
  state.wr.ready = true;
  state.wr.status = r ? r : null;
  return state.wr.status;
}

/* ---------------------------------------------------------- 中栏：书架 / 搜索 / 推荐 */

function wrSetupCard() {
  const box = el('div', 'wr-setup');
  box.innerHTML =
    '<div class="wr-setup-ico">📚</div>' +
    '<h3>还没配置微信读书</h3>' +
    '<p>在「设置 → 微信读书」里填入你的 <strong>API Key</strong>（wrk- 开头）即可使用。<br>' +
    '想用内嵌阅读器读正文，还需要填入浏览器登录后的 <strong>网页 Cookie</strong>。</p>';
  const b = el('button', 'tb primary', '打开设置');
  b.onclick = () => openSettings();
  box.appendChild(b);
  return box;
}

function wrTabBtn(key, label) {
  const b = el('button', 'wr-tab' + (state.wr.listTab === key ? ' on' : ''), label);
  b.onclick = () => {
    state.wr.listTab = key;
    if (key === 'recommend' && !state.wr.recommend.length) wrLoadRecommend();
    else renderWereadList();
  };
  return b;
}

function wrBookCard(b) {
  const card = el('div', 'wr-book');
  const cover = el('img', 'wr-cover');
  cover.loading = 'lazy';
  cover.alt = '';
  cover.src = b.cover || '';
  cover.onerror = () => {
    cover.style.display = 'none';
  };
  const ph = el('div', 'wr-cover-ph', '📖');
  card.appendChild(ph);
  card.appendChild(cover);
  const meta = el('div', 'wr-book-meta');
  meta.appendChild(el('div', 'wr-book-title', b.title || '(无题)'));
  meta.appendChild(el('div', 'wr-book-author', b.author || ''));
  card.appendChild(meta);
  if (b.finished) card.appendChild(el('span', 'wr-badge fin', '已读完'));
  else if (b.progress != null && b.progress > 0)
    card.appendChild(el('span', 'wr-badge', '在读 ' + Math.round(b.progress) + '%'));
  card.onclick = () => wrOpenBook(b);
  return card;
}

function wrShelfView() {
  const box = el('div');
  if (!state.wr.books.length) {
    if (state.wr.loading) return wrLoading(state.wr.loadingMsg || '正在拉取书架…');
    if (state.wr.loadErr) return wrErr(state.wr.loadErr);
    box.appendChild(wrEmpty('书架是空的，或加载失败。'));
  } else {
    const grid = el('div', 'wr-grid');
    const sorted = state.wr.books
      .slice()
      .sort((a, b) => (b.progress || 0) - (a.progress || 0));
    sorted.forEach((b) => grid.appendChild(wrBookCard(b)));
    box.appendChild(grid);
  }
  return box;
}

function wrRecommendView() {
  const box = el('div');
  if (!state.wr.recommend.length) {
    if (state.wr.loading) return wrLoading(state.wr.loadingMsg || '正在获取推荐…');
    if (state.wr.loadErr) return wrErr(state.wr.loadErr);
    box.appendChild(wrEmpty('暂无推荐。'));
  } else {
    const grid = el('div', 'wr-grid');
    state.wr.recommend.forEach((b) => grid.appendChild(wrBookCard(b)));
    box.appendChild(grid);
  }
  return box;
}

function wrResultsView() {
  const box = el('div');
  if (state.wr.loading) return wrLoading(state.wr.loadingMsg || '正在搜索…');
  if (!state.wr.results.length) {
    box.appendChild(wrEmpty('没有匹配「' + esc(state.wr.query) + '」的结果。'));
    return box;
  }
  const grid = el('div', 'wr-grid');
  state.wr.results.forEach((b) => grid.appendChild(wrBookCard(b)));
  box.appendChild(grid);
  return box;
}

function wrLoading(msg) {
  return el('div', 'wr-loading', msg || '加载中…');
}

function wrErr(msg) {
  return el('div', 'wr-err', '⚠️ ' + esc(msg));
}

function wrEmpty(msg) {
  return el('div', 'wr-empty', msg || '这里还什么都没有。');
}

function renderWereadList() {
  const scroll = $('#listScroll');
  if (!scroll) return;
  scroll.innerHTML = '';
  const wrap = el('div', 'wr-list');

  // 尚未确认配置：先去拿配置；拿到后重绘
  if (!state.wr.ready || !state.wr.status) {
    wrEnsureConfig().then(() => renderWereadList());
    wrap.appendChild(wrLoading('正在初始化…'));
    scroll.appendChild(wrap);
    return;
  }

  if (!state.wr.status.hasApiKey) {
    wrap.appendChild(wrSetupCard());
    scroll.appendChild(wrap);
    return;
  }

  if (!state.wr.books.length && !state.wr.loading && !state.wr.loadErr) {
    wrLoadShelf(false);
  }

  const bar = el('div', 'wr-toolbar');
  const search = el('input', 'wr-search');
  search.type = 'text';
  search.placeholder = '搜索书名 / 作者…';
  search.value = state.wr.query;
  search.oninput = (e) => {
    clearTimeout(renderWereadList._t);
    renderWereadList._t = setTimeout(() => {
      state.wr.query = e.target.value.trim();
      if (state.wr.query) wrSearch(state.wr.query);
      else renderWereadList();
    }, 300);
  };
  const tabs = el('div', 'wr-tabs');
  tabs.appendChild(wrTabBtn('shelf', '书架(' + state.wr.books.length + ')'));
  tabs.appendChild(wrTabBtn('recommend', '推荐'));
  const refresh = el('button', 'tb', '↻ 刷新');
  refresh.onclick = () => wrLoadShelf(true);
  bar.append(search, tabs, refresh);
  wrap.appendChild(bar);

  if (state.wr.query) wrap.appendChild(wrResultsView());
  else if (state.wr.listTab === 'recommend') wrap.appendChild(wrRecommendView());
  else wrap.appendChild(wrShelfView());

  scroll.appendChild(wrap);
}

/* ---------------------------------------------------------- 右栏：首页 / 书籍详情 / 阅读器 */

function wrHomeDetail() {
  const scroll = $('#detailScroll');
  if (!scroll) return;
  scroll.innerHTML = '';
  renderDetailBar([]);
  const wrap = el('div', 'wr-home');

  const h = el('div', 'wr-home-h');
  h.innerHTML =
    '<div class="wr-home-ico">📚</div><div><h2>微信读书</h2>' +
    '<p>在 My Workbench 里看你的书架、笔记与想法，还能内嵌阅读正文。</p></div>';
  wrap.appendChild(h);

  if (!state.wr.status || !state.wr.status.hasApiKey) {
    const need = el('div', 'wr-note wr-note-warn');
    need.textContent = '尚未配置 API Key。点击左侧「设置 → 微信读书」填入 wrk- 开头的 Key。';
    wrap.appendChild(need);
  } else {
    const total = state.wr.books.length || 0;
    const grid = el('div', 'wr-kv');
    [
      ['书架藏书', total + ' 本'],
      ['内嵌阅读器', state.wr.status.hasCookie ? '已就绪（可离线读正文）' : '需填网页 Cookie'],
      ['数据来源', '微信读书只读网关'],
    ].forEach(([k, v]) => {
      const r = el('div', 'wr-kv-row');
      r.appendChild(el('span', 'wr-kv-k', k));
      r.appendChild(el('span', 'wr-kv-v', v));
      grid.appendChild(r);
    });
    wrap.appendChild(grid);
  }

  const acts = el('div', 'wr-acts');
  const openWeb = el('button', 'tb', '打开微信读书网页版');
  openWeb.onclick = () => openUrl('https://weread.qq.com/');
  acts.appendChild(openWeb);
  if (state.wr.status && state.wr.status.hasApiKey && !state.wr.books.length) {
    const load = el('button', 'tb primary', '拉取书架');
    load.onclick = () => wrLoadShelf(true);
    acts.appendChild(load);
  }
  wrap.appendChild(acts);

  const note = el('div', 'wr-note');
  note.innerHTML =
    '<strong>关于「同步读书记录给微信读书」与活动功能：</strong><br>' +
    '· 微信读书开放能力（Agent 网关 + 网页正文通道）为<strong>只读</strong>：本应用可读取书架 / 进度 / 笔记 / 想法 / 书评，' +
    '但<strong>无法把阅读记录写回微信读书</strong>，也<strong>无法复刻「会员抽奖 / 每周阅读奖励 / 翻一翻」</strong>' +
    '（这些都是微信读书 App 内活动，官方开放接口未提供）。<br>' +
    '· 内嵌阅读器仅在<strong>本机</strong>渲染你账号的正文，不修改微信读书端的阅读进度。';
  wrap.appendChild(note);

  if (state.wr.status && state.wr.status.hasApiKey && state.wr.books.length) {
    const tip = el('div', 'wr-tip', '👈 从左侧书架或搜索挑一本书开始');
    wrap.appendChild(tip);
  }

  scroll.appendChild(wrap);
}

function wrBookDetail() {
  const b = state.wr.selectedBook;
  const scroll = $('#detailScroll');
  if (!scroll) return;
  scroll.innerHTML = '';

  const tabs = el('div', 'wr-dtabs');
  const tabBtn = (key, label) => {
    const t = el('button', 'wr-dtab' + (state.wr.tab === key ? ' on' : ''), label);
    t.onclick = () => {
      state.wr.tab = key;
      wrBookDetail();
    };
    return t;
  };
  tabs.append(tabBtn('detail', '详情'), tabBtn('chapters', '目录'), tabBtn('notes', '笔记'),
    tabBtn('reviews', '书评'), tabBtn('mine', '我的想法'));
  renderDetailBar([tabs]);

  const wrap = el('div', 'wr-detail-inner');

  const head = el('div', 'wr-bk-head');
  const cover = el('img', 'wr-bk-cover');
  cover.src = b.cover || '';
  cover.alt = '';
  cover.onerror = () => (cover.style.display = 'none');
  head.appendChild(cover);
  const info = el('div', 'wr-bk-info');
  info.appendChild(el('h2', 'wr-bk-title', b.title || ''));
  if (b.author) info.appendChild(el('div', 'wr-bk-author', b.author));
  if (b.publisher) info.appendChild(el('div', 'wr-bk-pub', b.publisher));
  if (b.progress != null) {
    const pct = Math.max(0, Math.min(100, Math.round(b.progress)));
    const pb = el('div', 'wr-progress');
    const fill = el('div', 'wr-progress-fill');
    fill.style.width = pct + '%';
    pb.appendChild(fill);
    info.appendChild(pb);
    info.appendChild(el('div', 'wr-progress-label', pct + '%' + (b.readingTime ? ' · 已读 ' + wrFmtDur(b.readingTime) : '')));
  }
  const acts = el('div', 'wr-bk-acts');
  if (b.deepLink) {
    const open = el('button', 'tb primary', '在微信读书打开');
    open.onclick = () => openUrl(b.deepLink);
    acts.appendChild(open);
  }
  const read = el('button', 'tb', '开始阅读 / 继续阅读');
  read.onclick = () => wrOpenReader(b.curChapterUid != null ? b.curChapterUid : null);
  acts.appendChild(read);
  info.appendChild(acts);
  head.appendChild(info);
  wrap.appendChild(head);

  if (b.intro) {
    const sec = el('div', 'wr-dsec');
    sec.appendChild(el('h4', null, '简介'));
    const c = el('div', 'wr-intro');
    c.textContent = b.intro;
    sec.appendChild(c);
    wrap.appendChild(sec);
  }

  const sec = el('div', 'wr-dsec');
  if (state.wr.tab === 'detail') {
    sec.appendChild(el('div', 'wr-note', '在上方「在微信读书打开」可直接跳读；「开始阅读」会用内嵌阅读器在右侧阅读正文（需网页 Cookie）。'));
  } else if (state.wr.tab === 'chapters') {
    wrRenderChapters(sec);
  } else if (state.wr.tab === 'notes') {
    wrRenderBookmarks(sec);
  } else if (state.wr.tab === 'reviews') {
    wrRenderReviews(sec, false);
  } else if (state.wr.tab === 'mine') {
    wrRenderReviews(sec, true);
  }
  wrap.appendChild(sec);

  scroll.appendChild(wrap);
}

function wrFmtDur(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.round(s / 60) + ' 分钟';
  return (s / 3600).toFixed(1) + ' 小时';
}

/* ---------------------------------------------------------- 章节目录 / 笔记 / 书评 */

function wrRenderChapters(sec) {
  if (!state.wr.chapters.length) {
    if (state.wr.loading) {
      sec.appendChild(wrLoading('正在拉取目录…'));
      return;
    }
    sec.appendChild(wrEmpty('暂无章节。'));
    return;
  }
  const list = el('div', 'wr-chapters');
  state.wr.chapters.forEach((c) => {
    const row = el('button', 'wr-ch-row' + (state.wr.chapterUid === c.chapterUid ? ' on' : ''));
    row.innerHTML =
      '<span class="wr-ch-title">' + esc(c.title || '') + '</span>' +
      (c.wordCount ? '<span class="wr-ch-words">' + c.wordCount + ' 字</span>' : '');
    row.onclick = () => wrOpenReader(c.chapterUid);
    list.appendChild(row);
  });
  sec.appendChild(list);
}

function wrRenderBookmarks(sec) {
  const bm = state.wr.bookmarks;
  if (bm === null) {
    sec.appendChild(wrLoading('正在拉取划线…'));
    wrLoadBookmarks();
    return;
  }
  const chapters = (bm.chapters || []).filter((x) => (x.bookmarks || []).length);
  const all = [];
  chapters.forEach((ch) => {
    (ch.bookmarks || []).forEach((m) => all.push({ title: ch.title, text: m.markText || m.content || '' }));
  });
  if (!all.length) {
    sec.appendChild(wrEmpty('这本书还没有划线笔记。'));
    return;
  }
  const list = el('div', 'wr-notes');
  all.forEach((n) => {
    const item = el('div', 'wr-note-item');
    if (n.title) item.appendChild(el('div', 'wr-note-ch', n.title));
    const t = el('div', 'wr-note-text');
    t.textContent = n.text;
    item.appendChild(t);
    list.appendChild(item);
  });
  sec.appendChild(list);
}

function wrRenderReviews(sec, mine) {
  const data = mine ? state.wr.mine : state.wr.reviews;
  if (data === null) {
    sec.appendChild(wrLoading(mine ? '正在拉取我的想法…' : '正在拉取书评…'));
    wrLoadReviews(mine);
    return;
  }
  const list = (data.list || []).filter(Boolean);
  if (!list.length) {
    sec.appendChild(wrEmpty(mine ? '你还没有在这本书上写想法。' : '这本书还没有公开书评。'));
    return;
  }
  const box = el('div', 'wr-reviews');
  list.slice(0, 30).forEach((rv) => {
    const item = el('div', 'wr-review');
    const top = el('div', 'wr-review-top');
    if (rv.author) top.appendChild(el('span', 'wr-review-author', rv.author));
    if (rv.chapterTitle) top.appendChild(el('span', 'wr-review-ch', rv.chapterTitle));
    if (rv.likeCount != null) top.appendChild(el('span', 'wr-review-like', '👍 ' + rv.likeCount));
    item.appendChild(top);
    const c = el('div', 'wr-review-content');
    c.textContent = rv.content || rv.review || '';
    item.appendChild(c);
    box.appendChild(item);
  });
  sec.appendChild(box);
}

/* ---------------------------------------------------------- 阅读器 */

function wrOpenReader(chapterUid) {
  const b = state.wr.selectedBook;
  if (!b) return;
  if (!state.wr.status || !state.wr.status.hasCookie) {
    toast('需要先配置网页 Cookie 才能内嵌阅读（设置 → 微信读书）', 'err');
    openSettings();
    return;
  }
  if (!state.wr.chapters.length) {
    wrLoadChapters().then(() => {
      const first = chapterUid != null ? chapterUid : (state.wr.chapters[0] && state.wr.chapters[0].chapterUid);
      if (first != null) wrLoadReader(first);
      else toast('这本书没有可读取的章节', 'err');
    });
    return;
  }
  const target = chapterUid != null ? chapterUid : (state.wr.chapters[0] && state.wr.chapters[0].chapterUid);
  if (target != null) wrLoadReader(target);
  else toast('这本书没有可读取的章节', 'err');
}

function wrLoadReader(chapterUid) {
  const b = state.wr.selectedBook;
  state.wr.chapterUid = chapterUid;
  state.wr.readerLoading = true;
  state.wr.readerErr = '';
  state.wr.readerHtml = '';
  wrRenderReader();
  API.weread
    .chapter(b.bookId, chapterUid)
    .then((r) => {
      state.wr.readerLoading = false;
      if (!r || r.ok === false) {
        state.wr.readerErr = (r && r.error) || '章节拉取失败';
      } else if (r.err) {
        state.wr.readerErr = r.err;
      } else {
        state.wr.readerHtml = wrSanitize(r.html || '');
      }
      wrRenderReader();
    })
    .catch((e) => {
      state.wr.readerLoading = false;
      state.wr.readerErr = wrErrMsg(e);
      wrRenderReader();
    });
}

function wrRenderReader() {
  const scroll = $('#detailScroll');
  if (!scroll) return;
  scroll.innerHTML = '';
  renderDetailBar([]);
  const wrap = el('div', 'wr-reader');

  const head = el('div', 'wr-reader-head');
  const title = el('div', 'wr-reader-book');
  title.textContent = (state.wr.selectedBook && state.wr.selectedBook.title) || '';
  head.appendChild(title);
  const nav = el('div', 'wr-reader-nav');
  const idx = state.wr.chapters.findIndex((c) => c.chapterUid === state.wr.chapterUid);
  const prev = el('button', 'tb', '‹ 上一章');
  prev.disabled = idx <= 0;
  prev.onclick = () => {
    if (idx > 0) wrLoadReader(state.wr.chapters[idx - 1].chapterUid);
  };
  const chName = el('span', 'wr-reader-chname', (state.wr.chapters[idx] && state.wr.chapters[idx].title) || '');
  const next = el('button', 'tb', '下一章 ›');
  next.disabled = idx < 0 || idx >= state.wr.chapters.length - 1;
  next.onclick = () => {
    if (idx >= 0 && idx < state.wr.chapters.length - 1) wrLoadReader(state.wr.chapters[idx + 1].chapterUid);
  };
  nav.append(prev, chName, next);
  head.appendChild(nav);
  wrap.appendChild(head);

  const body = el('div', 'wr-reader-body');
  if (state.wr.readerLoading) {
    body.appendChild(wrLoading('正在拉取正文（解密中）…'));
  } else if (state.wr.readerErr) {
    const e = el('div', 'wr-reader-err');
    e.innerHTML =
      '⚠️ ' + esc(state.wr.readerErr) +
      '<div class="wr-note" style="margin-top:12px">可能是 Cookie 失效、该书需购买，或微信读书接口已变。' +
      '可到「设置 → 微信读书」更新网页 Cookie，或用「在微信读书打开」前往官方阅读。</div>';
    body.appendChild(e);
  } else {
    const art = el('div', 'wr-article');
    art.innerHTML = state.wr.readerHtml || '';
    body.appendChild(art);
  }
  wrap.appendChild(body);

  if (!state.wr.readerErr && !state.wr.readerLoading && !state.wr.readerHtml) {
    wrap.appendChild(wrEmpty('这一章没有可读的正文。'));
  }

  const foot = el('div', 'wr-reader-foot');
  foot.innerHTML =
    '<span class="wr-note-inline">本机阅读，仅渲染你账号的正文，不会写回微信读书的阅读进度。</span>';
  wrap.appendChild(foot);

  scroll.appendChild(wrap);
}

/* ---------------------------------------------------------- 加载数据 */

async function wrLoadShelf(force) {
  if (!force && state.wr.books.length) return;
  state.wr.loading = true;
  state.wr.loadingMsg = '正在拉取书架…';
  state.wr.loadErr = '';
  try {
    const r = await wrApi('/shelf/sync');
    const data = wrData(r);
    state.wr.books = (data.books || []).filter((b) => b && b.bookId);
  } catch (e) {
    state.wr.loadErr = wrErrMsg(e);
  } finally {
    state.wr.loading = false;
    renderWereadList();
  }
}

async function wrSearch(keyword) {
  state.wr.loading = true;
  state.wr.loadingMsg = '正在搜索…';
  state.wr.loadErr = '';
  try {
    const r = await wrApi('/store/search', { keyword, scope: 'book', count: 30 });
    const data = wrData(r);
    const groups = data.results || [];
    const books = [];
    for (const grp of groups) {
      const bs = grp.books || [];
      for (const b of bs) {
        const info = b.bookInfo || b;
        if (!info.bookId) continue;
        books.push({
          bookId: info.bookId,
          title: info.title || '',
          author: info.author || '',
          cover: info.cover || '',
        });
      }
    }
    state.wr.results = books;
  } catch (e) {
    state.wr.loadErr = wrErrMsg(e);
    state.wr.results = [];
  } finally {
    state.wr.loading = false;
    renderWereadList();
  }
}

async function wrLoadRecommend() {
  state.wr.loading = true;
  state.wr.loadingMsg = '正在获取推荐…';
  state.wr.loadErr = '';
  try {
    const r = await wrApi('/book/recommend', { count: 24 });
    const data = wrData(r);
    const books = (data.books || []).filter((b) => b && b.bookId);
    state.wr.recommend = books.map((b) => ({
      bookId: b.bookId,
      title: b.title || '',
      author: b.author || '',
      cover: b.cover || '',
    }));
  } catch (e) {
    state.wr.loadErr = wrErrMsg(e);
    state.wr.recommend = [];
  } finally {
    state.wr.loading = false;
    renderWereadList();
  }
}

async function wrOpenBook(b) {
  state.wr.selectedBook = {
    bookId: b.bookId,
    title: b.title,
    author: b.author,
    cover: b.cover,
    publisher: b.publisher || '',
    intro: b.intro || '',
    deepLink: b.deepLink || 'https://weread.qq.com/web/book/' + b.bookId,
    progress: b.progress != null ? b.progress : null,
    readingTime: b.readingTime != null ? b.readingTime : null,
    curChapterUid: b.chapterUid != null ? b.chapterUid : null,
  };
  state.wr.tab = 'detail';
  state.wr.chapters = [];
  state.wr.bookmarks = null;
  state.wr.reviews = null;
  state.wr.mine = null;
  state.wr.chapterUid = null;
  state.wr.readerHtml = '';
  renderWereadDetail();

  try {
    const info = await wrApi('/book/info', { bookId: b.bookId });
    const id = wrData(info);
    state.wr.selectedBook.intro = id.intro || state.wr.selectedBook.intro;
    state.wr.selectedBook.publisher = id.publisher || state.wr.selectedBook.publisher;
    state.wr.selectedBook.deepLink = id.deepLink || state.wr.selectedBook.deepLink;
    state.wr.selectedBook.author = id.author || state.wr.selectedBook.author;
    state.wr.selectedBook.cover = id.cover || state.wr.selectedBook.cover;
  } catch (_) {}
  try {
    const prog = await wrApi('/book/getprogress', { bookId: b.bookId });
    const pb = (wrData(prog).book) || {};
    if (pb.progress != null) state.wr.selectedBook.progress = pb.progress;
    if (pb.readingTime != null) state.wr.selectedBook.readingTime = pb.readingTime;
    if (pb.chapterUid != null) state.wr.selectedBook.curChapterUid = pb.chapterUid;
  } catch (_) {}
  try {
    await wrLoadChapters();
  } catch (_) {}
  renderWereadDetail();
}

async function wrLoadChapters() {
  const b = state.wr.selectedBook;
  const r = await wrApi('/book/chapterinfo', { bookId: b.bookId });
  const data = wrData(r);
  state.wr.chapters = (data.chapters || []).filter((c) => c && c.chapterUid != null);
  return state.wr.chapters;
}

async function wrLoadBookmarks() {
  const b = state.wr.selectedBook;
  try {
    const r = await wrApi('/book/bookmarklist', { bookId: b.bookId });
    state.wr.bookmarks = wrData(r);
  } catch (e) {
    state.wr.bookmarks = { chapters: [], err: wrErrMsg(e) };
  }
  if (state.wr.tab === 'notes') wrBookDetail();
}

async function wrLoadReviews(mine) {
  const b = state.wr.selectedBook;
  try {
    const r = mine
      ? await wrApi('/review/list/mine', { bookid: b.bookId, count: 30 })
      : await wrApi('/review/list', { bookId: b.bookId, count: 30 });
    const data = wrData(r);
    const reviews = (data.reviews || []).filter(Boolean);
    const mapped = reviews.map((rv) => ({
      author: rv.author || rv.nickname || (rv.user && rv.user.name) || '',
      chapterTitle: rv.chapterTitle || (rv.chapter && rv.chapter.title) || '',
      content: rv.content || rv.review || '',
      likeCount: rv.likeCount != null ? rv.likeCount : 0,
    }));
    if (mine) state.wr.mine = { list: mapped };
    else state.wr.reviews = { list: mapped };
  } catch (e) {
    const fallback = { list: [], err: wrErrMsg(e) };
    if (mine) state.wr.mine = fallback;
    else state.wr.reviews = fallback;
  }
  if ((mine && state.wr.tab === 'mine') || (!mine && state.wr.tab === 'reviews')) wrBookDetail();
}

/* ---------------------------------------------------------- 入口分发 */

function renderWereadDetail() {
  if (!state.wr.ready || !state.wr.status || !state.wr.status.hasApiKey) {
    return wrHomeDetail();
  }
  if (!state.wr.selectedBook) {
    return wrHomeDetail();
  }
  return wrBookDetail();
}
