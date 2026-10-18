'use strict';
/* ==========================================================================
   AI 资讯聚合（分层信源 + 身份订阅）渲染层
   依赖 app.js 全局：el / esc / toast / act / API / state / openUrl / relTime /
   renderDetailBar / confirmDialog / openModal
   ========================================================================== */

if (!state.ain) {
  state.ain = {
    catalog: null, // { sources, layers, identities }
    identity: 'dev',
    enabled: new Set(),
    items: [],
    perSource: {},
    readLater: [],
    cacheAt: '',
    loading: false,
    q: '',
    sel: null, // 当前选中的条目（右栏详情）
    tab: 'today', // today | all
    reading: null, // 当前进入内嵌阅读的文章
    noteDraft: '', // 当前阅读文章的笔记草稿
    noteSaving: false,
    prefsLoaded: false,
    _loadSeq: 0,
  };
}

const AIN_LAYER_CLS = { primary: 'an-l-primary', secondary: 'an-l-secondary', reference: 'an-l-reference' };
const AIN_LAYER_TAG = { primary: '一手', secondary: '二手', reference: '参考' };

/* ---------------------------------------------------------- 数据加载 */

async function ainEnsureLoaded() {
  const seq = ++state.ain._loadSeq;
  if (!state.ain.catalog) {
    const cat = await act(API.ainews.catalog());
    if (cat && cat.sources) state.ain.catalog = cat;
  }
  if (!state.ain.prefsLoaded) {
    const p = await act(API.ainews.prefs());
    if (p) {
      state.ain.identity = p.identity || 'dev';
      state.ain.enabled = new Set(p.enabledSources || []);
      state.ain.readLater = p.readLater || [];
    }
    state.ain.prefsLoaded = true;
  }
  const c = await act(API.ainews.cache());
  if (c) {
    state.ain.items = c.items || [];
    state.ain.perSource = c.perSource || {};
    state.ain.cacheAt = c.updatedAt || '';
  }
  // 进面板时若缓存过期，静默触发一次刷新（网络不通会优雅失败，保留旧缓存）
  if (ainIsStale() && !state.ain.loading) {
    ainRefresh().catch(() => {});
  }
  if (seq !== state.ain._loadSeq) return; // 已有更新的加载，放弃本次重绘
  if (state.view === 'ainews') {
    renderAiNewsList();
    renderAiNewsDetail();
  }
}

function ainIsStale() {
  if (!state.ain.cacheAt) return true;
  const dt = Date.now() - new Date(state.ain.cacheAt).getTime();
  return Number.isNaN(dt) || dt > 6 * 3600 * 1000;
}

async function ainRefresh() {
  if (state.ain.loading) return;
  state.ain.loading = true;
  renderAiNewsList();
  try {
    const c = await act(API.ainews.refresh());
    if (c) {
      state.ain.items = c.items || [];
      state.ain.perSource = c.perSource || {};
      state.ain.cacheAt = c.updatedAt || '';
    }
    toast('AI 资讯已更新', 'ok');
  } catch (e) {
    /* act 已提示 */
  } finally {
    state.ain.loading = false;
    if (state.view === 'ainews') {
      renderAiNewsList();
      renderAiNewsDetail();
    }
  }
}

/* ---------------------------------------------------------- 中栏：列表 */

function renderAiNewsList() {
  const scroll = document.getElementById('listScroll');
  if (!scroll) return;
  scroll.innerHTML = '';
  scroll.classList.add('an-scroll');

  const cat = state.ain.catalog;

  // 工具条
  const bar = el('div', 'an-bar');

  const idSeg = el('div', 'an-id-seg');
  const ids = (cat && cat.identities) || [
    { id: 'dev', label: '开发者' },
    { id: 'product', label: '产品运营' },
    { id: 'investor', label: '投资战略' },
    { id: 'hobby', label: '纯兴趣' },
  ];
  ids.concat(state.ain.identity === 'custom' ? [{ id: 'custom', label: '自定义' }] : []).forEach((iden) => {
    const b = el('button', 'an-id-btn' + (state.ain.identity === iden.id ? ' active' : ''), iden.label);
    b.onclick = () => ainSetIdentity(iden.id);
    idSeg.appendChild(b);
  });
  bar.appendChild(idSeg);

  const right = el('div', 'an-bar-right');
  const refreshBtn = el('button', 'tb' + (state.ain.loading ? ' loading' : ''), state.ain.loading ? '刷新中…' : '↻ 刷新');
  refreshBtn.onclick = ainRefresh;
  right.appendChild(refreshBtn);
  const mgrBtn = el('button', 'tb', '⚙ 订阅管理');
  mgrBtn.onclick = ainOpenSourceManager;
  right.appendChild(mgrBtn);
  const opmlBtn = el('button', 'tb', '⇩ 导出 OPML');
  opmlBtn.onclick = ainExportOpml;
  right.appendChild(opmlBtn);
  bar.appendChild(right);
  scroll.appendChild(bar);

  // 搜索 + 今日/全部 切换
  const sub = el('div', 'an-sub');
  const search = el('input', 'an-search');
  search.placeholder = '搜索标题 / 摘要 / 来源…';
  search.value = state.ain.q || '';
  search.oninput = () => {
    state.ain.q = search.value.trim();
    renderAiNewsList();
  };
  sub.appendChild(search);

  const tabSeg = el('div', 'an-tab-seg');
  [
    { v: 'today', l: '今日' },
    { v: 'all', l: '全部' },
  ].forEach((t) => {
    const b = el('button', 'an-tab-btn' + (state.ain.tab === t.v ? ' active' : ''), t.l);
    b.onclick = () => {
      state.ain.tab = t.v;
      renderAiNewsList();
    };
    tabSeg.appendChild(b);
  });
  sub.appendChild(tabSeg);
  const rlBtn = el('button', 'tb an-rl-btn', `★ 稍后读 (${state.ain.readLater.length})`);
  rlBtn.onclick = () => ainOpenReadLater();
  sub.appendChild(rlBtn);
  scroll.appendChild(sub);

  // 缓存时间提示
  const meta = el('div', 'an-cache-meta');
  meta.textContent = state.ain.cacheAt
    ? `缓存更新于 ${relTime(state.ain.cacheAt)}${ainIsStale() ? '（已过期，点刷新拉取最新）' : ''}`
    : '还没有缓存，点「刷新」拉取最新资讯';
  scroll.appendChild(meta);

  if (!cat) {
    scroll.appendChild(el('div', 'an-empty', '正在加载信源目录…'));
    return;
  }

  // 按层分组渲染
  const q = (state.ain.q || '').toLowerCase();
  const tab = state.ain.tab;
  let anyShown = false;

  cat.layers.forEach((layer) => {
    const layerItems = state.ain.items.filter((it) => it.layer === layer.id);
    if (tab === 'today') {
      const todayItems = layerItems.filter(ainIsToday);
      if (!todayItems.length) return; // 今日视图下，该层无今日条目则跳过
      renderLayerSection(scroll, layer, todayItems, q);
      anyShown = true;
    } else {
      if (!layerItems.length) return;
      renderLayerSection(scroll, layer, layerItems, q);
      anyShown = true;
    }
  });

  if (!anyShown) {
    scroll.appendChild(
      el('div', 'an-empty', tab === 'today' ? '今日还没有抓到新资讯，点「刷新」或切到「全部」。' : '还没有内容，点「刷新」拉取。')
    );
  }
}

function renderLayerSection(scroll, layer, items, q) {
  const section = el('div', 'an-section ' + AIN_LAYER_CLS[layer.id]);
  const head = el('div', 'an-layer-head');
  head.innerHTML =
    `<span class="an-layer-dot"></span><span class="an-layer-label">${esc(layer.label)}</span>` +
    `<span class="an-layer-sub">${esc(layer.sub)}</span><span class="an-layer-count">${items.length}</span>`;
  section.appendChild(head);

  // 来源是否过滤
  const visible = items.filter((it) => {
    if (!q) return true;
    return (
      (it.title || '').toLowerCase().includes(q) ||
      (it.summary || '').toLowerCase().includes(q) ||
      (it.sourceName || '').toLowerCase().includes(q) ||
      (it.author || '').toLowerCase().includes(q)
    );
  });

  if (layer.id === 'reference') {
    // 参考层：手动登记的风向入口
    section.appendChild(renderReferenceBlock());
  } else if (!visible.length) {
    section.appendChild(el('div', 'an-noitem', q ? '没有匹配。' : '（暂无内容）'));
  } else {
    // 按来源分组
    const bySource = {};
    visible.forEach((it) => {
      (bySource[it.sourceId] = bySource[it.sourceId] || []).push(it);
    });
    Object.keys(bySource).forEach((sid) => {
      const srcMeta = (state.ain.catalog.sources || []).find((s) => s.id === sid) || {};
      const st = state.ain.perSource[sid] || {};
      const sh = el('div', 'an-src-head');
      sh.innerHTML =
        `<span class="an-src-name">${esc(srcMeta.name || sid)}</span>` +
        (st.error ? `<span class="an-src-err" title="${esc(st.error)}">抓取失败</span>` : `<span class="an-src-count">${bySource[sid].length}</span>`);
      if (srcMeta.region === 'cn') sh.appendChild(el('span', 'an-region', '中文'));
      section.appendChild(sh);
      bySource[sid].forEach((it) => section.appendChild(ainItemCard(it)));
    });
  }
  scroll.appendChild(section);
}

function ainItemCard(it) {
  const card = el('div', 'an-card' + (state.ain.sel && state.ain.sel.id === it.id ? ' sel' : ''));
  const top = el('div', 'an-card-top');
  top.appendChild(el('span', 'an-tag ' + AIN_LAYER_CLS[it.layer], AIN_LAYER_TAG[it.layer] || ''));
  if (it.upvotes != null) top.appendChild(el('span', 'an-up', '▲ ' + it.upvotes));
  top.appendChild(el('span', 'an-time', it.date ? relTime(it.date) : ''));
  card.appendChild(top);
  const title = el('div', 'an-card-title', it.title || '(无标题)');
  if (it.link) {
    title.style.cursor = 'pointer';
    title.onclick = () => ainSelect(it);
  }
  card.appendChild(title);
  if (it.summary) card.appendChild(el('div', 'an-card-sum', it.summary));
  const foot = el('div', 'an-card-foot');
  foot.appendChild(el('span', 'an-src', it.sourceName || ''));
  if (it.author) foot.appendChild(el('span', 'an-author', it.author));
  const saved = state.ain.readLater.some((x) => normKeyLocal(x.link, x.title) === normKeyLocal(it.link, it.title));
  const star = el('button', 'an-star' + (saved ? ' on' : ''), saved ? '★' : '☆');
  star.title = saved ? '取消稍后读' : '稍后读';
  star.onclick = (e) => {
    e.stopPropagation();
    ainToggleReadLater(it);
  };
  foot.appendChild(star);
  card.appendChild(foot);

  if (it.link) {
    card.onclick = () => ainSelect(it);
  }
  return card;
}

function renderReferenceBlock() {
  const wrap = el('div', 'an-ref');
  (state.ain.catalog.sources || [])
    .filter((s) => s.layer === 'reference')
    .forEach((s) => {
      const box = el('div', 'an-ref-src');
      box.appendChild(el('div', 'an-ref-name', s.name));
      if (s.note) box.appendChild(el('div', 'an-ref-note', s.note));
      const key = 'ainews:reg:' + s.id;
      let links = [];
      try { links = JSON.parse(localStorage.getItem(key) || '[]'); } catch { links = []; }
      const list = el('div', 'an-ref-links');
      links.forEach((lk, i) => {
        const row = el('div', 'an-ref-link');
        const a = el('a', 'an-ref-a', lk);
        a.href = '#';
        a.onclick = (e) => { e.preventDefault(); openUrl(lk); };
        row.appendChild(a);
        const del = el('button', 'an-ref-del', '✕');
        del.onclick = () => {
          links.splice(i, 1);
          localStorage.setItem(key, JSON.stringify(links));
          renderAiNewsList();
        };
        row.appendChild(del);
        list.appendChild(row);
      });
      box.appendChild(list);
      const add = el('button', 'tb an-ref-add', '＋ 添加链接');
      add.onclick = () => {
        const v = window.prompt('粘贴你的 ' + s.name + ' 链接（X 私有 List / 短视频主页等）：');
        if (!v) return;
        links.push(v.trim());
        localStorage.setItem(key, JSON.stringify(links));
        renderAiNewsList();
      };
      box.appendChild(add);
      wrap.appendChild(box);
    });
  return wrap;
}

function normKeyLocal(link, title) {
  const base = (link || title || '').toLowerCase().replace(/\/$/, '');
  const cleaned = base.split('#')[0].replace(/[?&](utm_[^=&]*|ref=[^&]*)=[^&]*/g, '');
  return cleaned || 't:' + (title || '').slice(0, 12);
}

/* ---------------------------------------------------------- 右栏：速览 / 详情 */

function renderAiNewsDetail() {
  const detail = document.getElementById('detailScroll');
  if (!detail) return;
  detail.innerHTML = '';
  detail.classList.remove('ed-mode');

  if (state.ain.reading) return ainRenderReader(detail, state.ain.reading);
  if (state.ain.sel) return ainRenderArticle(detail, state.ain.sel);

  // 默认：今日速览
  const todayItems = state.ain.items.filter(ainIsToday);
  const inner = el('div', 'detail-inner an-detail');

  inner.appendChild(el('div', 'd-title an-digest-title', '今日 AI 资讯速览'));
  const sub = el('div', 'an-digest-sub');
  sub.textContent = state.ain.cacheAt
    ? `共 ${state.ain.items.length} 条在缓存中 · 今日新增 ${todayItems.length} 条 · 更新于 ${relTime(state.ain.cacheAt)}`
    : '还没有缓存，去左侧点「刷新」。';
  inner.appendChild(sub);

  // 各层占比
  const counts = { primary: 0, secondary: 0, reference: 0 };
  state.ain.items.forEach((it) => { if (counts[it.layer] != null) counts[it.layer]++; });
  const kv = el('div', 'kv-list an-kv');
  [
    ['一手信源', counts.primary + ' 条'],
    ['二手信源', counts.secondary + ' 条'],
    ['风向参考', counts.reference + ' 条（手动）'],
    ['身份', ((state.ain.catalog && state.ain.catalog.identities
      ? state.ain.catalog.identities.find((x) => x.id === state.ain.identity)
      : null) || {}).label || '自定义'],
  ].forEach(([k, v]) => {
    const r = el('div', 'row');
    r.appendChild(el('span', 'k', k));
    r.appendChild(el('span', 'v', v));
    kv.appendChild(r);
  });
  inner.appendChild(kv);

  // 今日重点：按 upvotes 或时间挑 Top
  const highlight = pickHighlights(todayItems.length ? todayItems : state.ain.items);
  if (highlight.length) {
    const sec = el('div', 'd-section');
    sec.appendChild(el('h4', null, todayItems.length ? '今日重点' : '近期重点'));
    highlight.forEach((it) => {
      const row = el('div', 'an-hl');
      row.onclick = () => ainSelect(it);
      const t = el('div', 'an-hl-title', it.title || '(无标题)');
      row.appendChild(t);
      const m = el('div', 'an-hl-meta');
      m.appendChild(el('span', 'an-src', it.sourceName || ''));
      if (it.upvotes != null) m.appendChild(el('span', 'an-up', '▲ ' + it.upvotes));
      m.appendChild(el('span', 'an-time', it.date ? relTime(it.date) : ''));
      row.appendChild(m);
      sec.appendChild(row);
    });
    inner.appendChild(sec);
  }

  // 稍后读
  if (state.ain.readLater.length) {
    const sec = el('div', 'd-section');
    sec.appendChild(el('h4', null, `稍后读 · ${state.ain.readLater.length}`));
    const list = el('div', 'an-hl-list');
    state.ain.readLater.forEach((it) => {
      const row = el('div', 'an-hl');
      row.onclick = () => ainSelect(it);
      row.appendChild(el('div', 'an-hl-title', it.title || '(无标题)'));
      row.appendChild(el('div', 'an-hl-meta', el('span', 'an-src', it.sourceName || '')));
      const del = el('button', 'an-ref-del', '✕');
      del.onclick = (e) => { e.stopPropagation(); ainToggleReadLater(it); };
      row.appendChild(del);
      list.appendChild(row);
    });
    sec.appendChild(list);
    inner.appendChild(sec);
  }

  detail.appendChild(inner);
}

function pickHighlights(pool) {
  if (!pool.length) return [];
  const withUp = pool.filter((it) => typeof it.upvotes === 'number');
  let top;
  if (withUp.length >= 5) {
    top = withUp.slice().sort((a, b) => b.upvotes - a.upvotes);
  } else {
    top = pool.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }
  return top.slice(0, 10);
}

function ainRenderArticle(detail, it) {
  const bar = [];
  if (it.link) {
    bar.push(
      mkTb('内嵌阅读', 'primary', () => { state.ain.reading = it; state.ain.noteDraft = ''; ainLoadNote(it); renderAiNewsDetail(); }, '在 Workbench 内打开原文并做笔记')
    );
    bar.push(
      mkTb('在浏览器打开', null, () => { if (it.link) openUrl(it.link); }, '用系统默认浏览器打开原文')
    );
  }
  const saved = state.ain.readLater.some((x) => normKeyLocal(x.link, x.title) === normKeyLocal(it.link, it.title));
  bar.push(
    mkTb(saved ? '★ 已收藏' : '☆ 稍后读', null, () => ainToggleReadLater(it))
  );
  bar.push(mkTb('复制链接', null, async () => {
    if (!it.link) return;
    await act(API.copyText(it.link));
    toast('链接已复制', 'ok');
  }));
  const sp = el('span');
  sp.className = 'spacer';
  bar.push(sp);
  renderDetailBar(bar);

  const inner = el('div', 'detail-inner an-detail');
  const h = el('div', 'd-title', it.title || '(无标题)');
  inner.appendChild(h);

  const meta = el('div', 'd-meta');
  const kv = (k, v) => {
    const w = el('div', 'kv');
    w.appendChild(el('span', 'k', k));
    w.appendChild(el('span', 'v', v));
    return w;
  };
  meta.appendChild(kv('来源', it.sourceName || ''));
  meta.appendChild(kv('分层', (AIN_LAYER_TAG[it.layer] || '') + '信源'));
  if (it.author) meta.appendChild(kv('作者', it.author));
  if (it.date) meta.appendChild(kv('时间', relTime(it.date)));
  if (it.meta) meta.appendChild(kv('语言', it.meta));
  inner.appendChild(meta);

  if (it.summary) {
    const sec = el('div', 'd-section');
    sec.appendChild(el('h4', null, '摘要'));
    const c = el('div', 'an-article-sum');
    c.textContent = it.summary;
    sec.appendChild(c);
    inner.appendChild(sec);
  } else {
    inner.appendChild(el('div', 'd-content empty-hint', '这条资讯没有摘要（多为链接型，点「在浏览器打开」看原文）。'));
  }

  detail.appendChild(inner);
}

/* ---------------------------------------------------------- 内嵌阅读 + 笔记 */

function ainRenderReader(detail, it) {
  const bar = [];
  bar.push(mkTb('← 返回摘要', null, () => { state.ain.reading = null; state.ain.noteDraft = ''; renderAiNewsDetail(); }, '回到文章摘要'));
  if (it.link) {
    bar.push(mkTb('在浏览器打开', null, () => openUrl(it.link), '用系统默认浏览器打开原文'));
  }
  const saved = state.ain.readLater.some((x) => normKeyLocal(x.link, x.title) === normKeyLocal(it.link, it.title));
  bar.push(mkTb(saved ? '★ 已收藏' : '☆ 稍后读', null, () => ainToggleReadLater(it)));
  const sp = el('span'); sp.className = 'spacer'; bar.push(sp);
  renderDetailBar(bar);

  const wrap = el('div', 'an-reader');

  // 左侧：webview
  const webviewWrap = el('div', 'an-webview-wrap');
  const webview = document.createElement('webview');
  webview.className = 'an-webview';
  webview.setAttribute('src', it.link || 'about:blank');
  webview.setAttribute('partition', 'persist:ainews'); // 独立 storage 分区，避免污染主站登录态
  webview.addEventListener('new-window', (e) => {
    e.preventDefault();
    if (e.url) openUrl(e.url);
  });
  webviewWrap.appendChild(webview);
  wrap.appendChild(webviewWrap);

  // 右侧：笔记面板
  const notes = el('div', 'an-notes');
  notes.appendChild(el('div', 'an-notes-title', '📝 阅读笔记'));
  notes.appendChild(el('div', 'an-notes-sub', it.title || '(无标题)'));

  const status = el('div', 'an-notes-status', '加载中…');
  notes.appendChild(status);

  const ta = el('textarea', 'an-notes-ta');
  ta.placeholder = '边读边记…\n按 Ctrl+Enter 快速保存';
  ta.value = state.ain.noteDraft;
  ta.oninput = () => { state.ain.noteDraft = ta.value; status.textContent = '未保存'; };
  ta.onkeydown = (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      ainSaveNote(it, ta.value, status);
    }
  };
  notes.appendChild(ta);

  const foot = el('div', 'an-notes-foot');
  const saveBtn = el('button', 'tb primary', '保存笔记');
  saveBtn.onclick = () => ainSaveNote(it, ta.value, status);
  foot.appendChild(saveBtn);
  notes.appendChild(foot);

  // 自动保存（停止输入 1.5 秒后）
  let debounce;
  ta.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (state.ain.noteDraft.trim()) ainSaveNote(it, state.ain.noteDraft, status);
    }, 1500);
  });

  wrap.appendChild(notes);
  detail.appendChild(wrap);

  // 加载已有笔记
  ainLoadNote(it).then((n) => {
    if (n && n.text != null) {
      state.ain.noteDraft = n.text;
      ta.value = n.text;
      status.textContent = '已加载 · ' + (n.updatedAt ? relTime(n.updatedAt) : '本地');
    } else {
      status.textContent = '暂无笔记';
    }
  });
}

async function ainLoadNote(it) {
  if (!it || !it.link) return null;
  try {
    const n = await act(API.ainews.noteGet(it.link, it.title || ''));
    return n;
  } catch (e) { return null; }
}

async function ainSaveNote(it, text, statusEl) {
  if (!it || !it.link || state.ain.noteSaving) return;
  state.ain.noteSaving = true;
  if (statusEl) statusEl.textContent = '保存中…';
  try {
    const n = await act(API.ainews.noteSet(it.link, it.title || '', text));
    if (statusEl) statusEl.textContent = n ? '已保存 · ' + (n.updatedAt ? relTime(n.updatedAt) : '刚刚') : '已清空';
  } finally {
    state.ain.noteSaving = false;
  }
}

/* ---------------------------------------------------------- 交互 */

function ainIsToday(item) {
  const d = item.date ? new Date(item.date) : null;
  if (!d || Number.isNaN(d.getTime())) return false;
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d >= startToday;
}

function ainSelect(it) {
  state.ain.sel = it;
  renderAiNewsDetail();
  renderAiNewsList();
}

async function ainSetIdentity(id) {
  if (id === 'custom') return;
  const p = await act(API.ainews.setIdentity(id));
  if (p) {
    state.ain.identity = p.identity;
    state.ain.enabled = new Set(p.enabledSources || []);
    const idLabel = (state.ain.catalog && state.ain.catalog.identities
      ? state.ain.catalog.identities.find((x) => x.id === id)
      : null) || {};
    toast('已切换到「' + (idLabel.label || id) + '」订阅组合', 'ok');
  }
  renderAiNewsList();
  renderAiNewsDetail();
}

async function ainToggleReadLater(it) {
  const p = await act(API.ainews.toggleReadLater(it));
  if (p) state.ain.readLater = p.readLater || [];
  renderAiNewsDetail();
  renderAiNewsList();
}

async function ainOpenSourceManager() {
  const cat = state.ain.catalog;
  if (!cat) return;
  const body = el('div', 'an-mgr');
  body.appendChild(el('p', 'an-mgr-tip', '勾选要订阅的信源；任何改动都会切换为「自定义」组合。'));

  cat.layers.forEach((layer) => {
    const sec = el('div', 'an-mgr-sec ' + AIN_LAYER_CLS[layer.id]);
    sec.appendChild(el('div', 'an-mgr-sec-h', `${layer.label} · ${layer.sub}`));
    cat.sources
      .filter((s) => s.layer === layer.id)
      .forEach((s) => {
        const row = el('label', 'an-mgr-row');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = state.ain.enabled.has(s.id);
        cb.onchange = async () => {
          await ainToggleSource(s.id, cb.checked);
        };
        row.appendChild(cb);
        const txt = el('div', 'an-mgr-txt');
        txt.appendChild(el('div', 'an-mgr-name', s.name));
        if (s.note) txt.appendChild(el('div', 'an-mgr-note', s.note));
        else if (s.url) txt.appendChild(el('div', 'an-mgr-note', s.url));
        row.appendChild(txt);
        if (s.region === 'cn') row.appendChild(el('span', 'an-region', '中文'));
        sec.appendChild(row);
      });
    body.appendChild(sec);
  });

  const foot = el('div');
  foot.style.cssText = 'display:flex;gap:8px;width:100%';
  const sp = el('span');
  sp.style.flex = '1';
  const close = el('button', 'tb', '完成');
  foot.append(sp, close);
  const { close: doClose } = openModal({ title: '订阅管理 · 信源', body, footer: foot, wide: true });
  close.onclick = doClose;
}

async function ainToggleSource(id, enabled) {
  const p = await act(API.ainews.toggleSource(id, enabled));
  if (p) {
    state.ain.identity = p.identity;
    state.ain.enabled = new Set(p.enabledSources || []);
  }
  renderAiNewsList();
  renderAiNewsDetail();
}

function ainOpenReadLater() {
  state.ain.sel = null;
  renderAiNewsDetail();
}

/* ---------------------------------------------------------- 导出 OPML */

function ainExportOpml() {
  const cat = state.ain.catalog;
  if (!cat) return;
  const subs = cat.sources.filter((s) => state.ain.enabled.has(s.id) && s.url && s.type !== 'manual');
  if (!subs.length) {
    toast('当前没有可订阅的 RSS 源', 'err');
    return;
  }
  const webMap = {
    'hf-papers': { html: 'https://huggingface.co/papers', title: 'Hugging Face Papers' },
    'hacker-news': { html: 'https://news.ycombinator.com', title: 'Hacker News' },
    'reddit-localllama': { html: 'https://www.reddit.com/r/LocalLLaMA', title: 'Reddit · r/LocalLLaMA' },
    'reddit-ml': { html: 'https://www.reddit.com/r/MachineLearning', title: 'Reddit · r/MachineLearning' },
    'github-trending': { html: 'https://github.com/topics/llm', title: 'GitHub Trending · LLM' },
  };
  let outlines = '';
  subs.forEach((s) => {
    const web = webMap[s.id];
    const xml = s.type === 'rss' || s.type === 'atom' ? `xmlUrl="${esc(s.url)}" ` : '';
    const html = web ? `htmlUrl="${esc(web.html)}" ` : s.url ? `htmlUrl="${esc(s.url)}" ` : '';
    const title = web ? web.title : s.name;
    outlines += `    <outline text="${esc(title)}" title="${esc(title)}" ${xml}${html}type="rss"/>\n`;
  });
  const opml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<opml version="2.0">\n  <head>\n    <title>My Workbench · AI 资讯订阅</title>\n  </head>\n  <body>\n` +
    outlines +
    `  </body>\n</opml>`;
  const blob = new Blob([opml], { type: 'text/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'My Workbench AI 资讯订阅.opml';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  toast('已导出 OPML（' + subs.length + ' 个源）', 'ok');
}
