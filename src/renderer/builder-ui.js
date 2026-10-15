'use strict';
/* ==========================================================================
   My Workbench —— 设计模式（参考 Webflow 的可视化建站器）
   左侧面板（Elements / Navigator 切换）/ 画布（iframe）/ 检查器（Style/Settings）
   在画布里点选元素 → 右侧可视化改 CSS → 实时回写源码。
   复用 editor-ui.js 暴露的：edActivePath / edActiveContent / edRebuild /
   edExtractBody / edSaveActive / mkTb / renderDetailBar / renderEditorList /
   edUpdateStatus / el / esc / toast / act / API / $
   ========================================================================== */

const WB_BP = { desktop: null, tablet: 991, mobile: 767 };
const WB_DEVICES = [
  { bp: 'desktop', label: '桌面', icon: '🖥', width: '100%' },
  { bp: 'tablet', label: '平板', icon: '💻', width: '768px' },
  { bp: 'mobile', label: '手机', icon: '📱', width: '375px' },
];
const WB_TEXT_TAGS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'BUTTON', 'LI', 'LABEL', 'SPAN'];
const WB_CONTAINER_TAGS = ['BODY', 'DIV', 'SECTION', 'HEADER', 'FOOTER', 'MAIN', 'ARTICLE', 'ASIDE', 'NAV', 'UL', 'OL', 'FORM', 'TABLE'];
const WB_TAG_ICONS = {
  body: '◎', section: '▭', header: '▭', footer: '▭', main: '▭', article: '▭', aside: '▭', nav: '▭',
  div: '▢', container: '▢',
  h1: 'H', h2: 'H', h3: 'H', h4: 'H', h5: 'H', h6: 'H',
  p: '¶', span: 'T', a: '🔗', button: '⬚', img: '🖼',
  ul: '☰', ol: '☰', li: '•', form: '✓', input: '⊞', label: '🏷',
  table: '▦', tr: '▦', td: '▦',
};

function wbState() {
  if (!state.ed.builderState) {
    state.ed.builderState = {
      selId: null, bp: 'desktop', inspectTab: 'style', bpStyles: {},
      handleCounter: 0, tabId: null, leftTab: 'navigator', collapsed: new Set(),
    };
  }
  return state.ed.builderState;
}
function wbFrame() { return document.getElementById('wbFrame'); }
function wbActiveTab() {
  const p = edActivePath();
  return p ? state.ed.tabs[p] : null;
}

/* 把任意片段规整成带 <html>/<head>/<body> 的完整文档 */
function wbNormalizeDoc(src) {
  src = String(src || '');
  if (!/^<!doctype/i.test(src)) src = '<!DOCTYPE html>\n' + src;
  if (!/<html[\s>]/i.test(src)) src = '<html lang="zh-CN">' + src + '</html>';
  if (!/<head[\s>]/i.test(src)) src = src.replace(/<html[^>]*>/i, '$&\n<head></head>');
  if (!/<body[\s>]/i.test(src)) {
    if (/<\/head>/i.test(src)) src = src.replace(/<\/head>/i, '</head>\n<body></body>');
    else src = src.replace(/<html[^>]*>/i, '$&\n<body></body>');
  }
  return src;
}

/* -------------------------------------------------------------- 主入口 */

function renderBuilder() {
  const bs = wbState();
  const path = edActivePath();
  const isHtml = !!path && /\.html?$/i.test(path);

  /* 顶栏：Elements 切换 / breadcrumb / 断点 / 保存 / 切代码 */
  const bar = [];
  const elBtn = mkTb('+ Elements', bs.leftTab === 'elements' ? 'on' : '', () => wbToggleLeft('elements'), '打开元素面板');
  const navBtn = mkTb('⧉ Navigator', bs.leftTab === 'navigator' ? 'on' : '', () => wbToggleLeft('navigator'), '打开图层树');
  bar.push(elBtn, navBtn);
  bar.push(el('span', 'spacer'));
  bar.push(el('div', 'wb-breadcrumb', '<span>Body</span>'));
  bar.push(el('span', 'spacer'));
  const bpGroup = el('div', 'wb-bp-group');
  WB_DEVICES.forEach((d) => {
    const b = el('button', 'tb' + (bs.bp === d.bp ? ' on' : ''), `${d.icon} ${d.label}`);
    b.title = `${d.label}（${d.width}）`;
    b.onclick = () => wbSetBp(d.bp);
    bpGroup.appendChild(b);
  });
  bar.push(bpGroup);
  if (isHtml) bar.push(mkTb('💾 保存', 'primary', edSaveActive, '⌘S'));
  bar.push(mkTb('⟨⟩ 代码', '', edToggleVisual, '切回源码编辑'));
  renderDetailBar(bar);

  const detail = $('#detailScroll');
  detail.innerHTML = '';
  if (!isHtml) {
    detail.appendChild(el('div', 'wb-empty', '打开一个 HTML 文件后，点顶栏「🎨 设计」即可进入可视化建站。'));
    return;
  }

  const wrap = el('div', 'wb');
  wrap.innerHTML = `
    <aside class="wb-left" id="wbLeftPanel"><div class="wb-left-body" id="wbLeftBody"></div></aside>
    <main class="wb-canvas-wrap">
      <div class="wb-canvas-bar" id="wbCanvasBar"></div>
      <div class="wb-canvas" id="wbCanvas"><iframe id="wbFrame"></iframe></div>
    </main>
    <aside class="wb-inspect" id="wbInspect"><div class="wb-inspect-tabs" id="wbInspectTabs"></div><div class="wb-inspect-body" id="wbInspectBody"></div></aside>
  `;
  detail.appendChild(wrap);

  wbRenderLeftPanel();
  wbRenderInspectTabs();
  wbLoadCanvas();

  // Navigator Delete/Backspace 删除选中元素（不在输入框内时）
  detail.onkeydown = (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target.isContentEditable) return;
    e.preventDefault();
    wbDeleteSelected();
  };
}

/* -------------------------------------------------------------- 左侧面板切换 */

function wbToggleLeft(tab) {
  const bs = wbState();
  bs.leftTab = tab;
  wbRenderLeftPanel();
}

function wbRenderLeftPanel() {
  const bs = wbState();
  const body = document.getElementById('wbLeftBody');
  if (!body) return;
  body.innerHTML = '';
  if (bs.leftTab === 'elements') {
    body.innerHTML = `
      <header><span>Elements</span><button class="wb-close" data-close>✕</button></header>
      <div class="wb-add-list" id="wbAddList"></div>`;
    body.querySelector('[data-close]').onclick = () => wbToggleLeft('navigator');
    wbRenderAddList();
  } else {
    body.innerHTML = `
      <header><span>Navigator</span><button class="wb-close" data-close>✕</button></header>
      <div class="wb-layer-tree" id="wbLayerTree"></div>`;
    body.querySelector('[data-close]').onclick = () => wbToggleLeft('elements');
    wbBuildLayers();
  }
}

/* -------------------------------------------------------------- 画布加载 */

function wbLoadCanvas() {
  const tab = wbActiveTab();
  if (!tab) return;
  const bs = wbState();
  bs.tabId = edActivePath();
  bs.selId = null;
  bs.handleCounter = 0;
  let src = wbNormalizeDoc(tab.content);

  const m = src.match(/<style\s+data-wf-bp[^>]*>([\s\S]*?)<\/style>/i);
  if (m) { bs.bpStyles = wbParseBp(m[1]); src = src.replace(m[0], ''); }
  else bs.bpStyles = {};

  const root = state.ed.root ? 'file://' + state.ed.root.replace(/\\/g, '/') + '/' : '';
  if (/<head[^>]*>/i.test(src)) src = src.replace(/<head[^>]*>/i, `$&<base href="${root}">`);

  const frame = wbFrame();
  frame.onload = () => wbOnFrameReady();
  frame.srcdoc = src;
}

function wbOnFrameReady() {
  const frame = wbFrame();
  const doc = frame.contentDocument;
  if (!doc) return;

  const hs = doc.createElement('style');
  hs.setAttribute('data-wf-helper', '');
  hs.textContent = `
    [data-wf-id]{ outline:1px dashed rgba(78,205,196,.35); outline-offset:-1px; }
    .wf-hover{ outline:1.5px solid rgba(78,205,196,.75) !important; outline-offset:-1px; }
    .wf-sel{ outline:2px solid #4ECDC4 !important; outline-offset:-2px; }
    [contenteditable="true"]{ outline:2px solid #FFD700 !important; }
    .wf-tag{ position:absolute; z-index:99999; transform:translateY(-100%);
      background:#4ECDC4; color:#0f2e2b; font:11px/1.4 'JetBrains Mono',monospace;
      padding:2px 6px; border-radius:4px 4px 4px 0; pointer-events:none; white-space:nowrap;
      box-shadow:0 2px 8px rgba(0,0,0,.25); }
  `;
  doc.head.appendChild(hs);

  const bs = wbState();
  let maxH = 0;
  doc.querySelectorAll('[data-wf]').forEach((n) => {
    const v = parseInt(n.getAttribute('data-wf'), 10);
    if (v > maxH) maxH = v;
  });
  bs.handleCounter = maxH;

  doc.addEventListener('mouseover', (e) => {
    const t = e.target.closest && e.target.closest('[data-wf-id]');
    doc.querySelectorAll('.wf-hover').forEach((n) => n.classList.remove('wf-hover'));
    if (t) t.classList.add('wf-hover');
  }, true);

  doc.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('[data-wf-id]');
    if (t) {
      e.preventDefault();
      e.stopPropagation();
      wbSelect(t.getAttribute('data-wf-id'));
    }
  }, true);

  doc.addEventListener('dblclick', (e) => {
    const t = e.target.closest && e.target.closest('[data-wf-id]');
    if (t && WB_TEXT_TAGS.includes(t.tagName)) {
      e.preventDefault();
      t.setAttribute('contenteditable', 'true');
      t.focus();
      const range = doc.createRange();
      range.selectNodeContents(t);
      const sel = frame.contentWindow.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const finish = () => {
        t.removeAttribute('contenteditable');
        t.removeEventListener('blur', finish);
        wbSerializeSoon();
      };
      t.addEventListener('blur', finish);
    }
  }, true);

  wbRenumber();
  wbBuildLayers();
  wbUpdateCanvasInfo();
}

function wbRenumber() {
  const doc = wbFrame().contentDocument;
  if (!doc) return;
  let n = 0;
  doc.body.querySelectorAll('*').forEach((el) => {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    el.setAttribute('data-wf-id', ++n);
  });
}

function wbEl(id) {
  const doc = wbFrame().contentDocument;
  return doc ? doc.querySelector(`[data-wf-id="${id}"]`) : null;
}

/* -------------------------------------------------------------- 断点 */

function wbSetBp(bp) {
  const bs = wbState();
  bs.bp = bp;
  wbUpdateCanvasInfo();
  const group = document.querySelector('.wb-bp-group');
  if (group) group.querySelectorAll('.tb').forEach((x, i) => x.classList.toggle('on', WB_DEVICES[i].bp === bp));
  wbRenderInspector();
}

function wbUpdateCanvasInfo() {
  const bs = wbState();
  const dev = WB_DEVICES.find((d) => d.bp === bs.bp);
  const canvas = document.getElementById('wbCanvas');
  if (canvas) canvas.style.setProperty('--wb-w', dev.width);
}

/* -------------------------------------------------------------- 选择 */

function wbSelect(id) {
  const bs = wbState();
  bs.selId = id || null;
  const doc = wbFrame().contentDocument;
  doc.querySelectorAll('.wf-sel').forEach((n) => n.classList.remove('wf-sel'));
  const elc = id ? wbEl(id) : null;
  if (elc) {
    elc.classList.add('wf-sel');
    wbShowTag(elc);
  } else {
    wbHideTag();
  }
  wbBuildLayers();
  wbRenderBreadcrumb(elc);
  wbRenderInspector();
}

function wbRenderBreadcrumb(elc) {
  const bar = document.getElementById('wbCanvasBar');
  if (!bar) return;
  const bs = wbState();
  const dev = WB_DEVICES.find((d) => d.bp === bs.bp);
  let crumbs = [];
  if (elc) {
    let cur = elc;
    while (cur && cur.tagName !== 'BODY') {
      const name = cur.className ? '.' + String(cur.className).trim().split(/\s+/)[0] : (cur.id ? '#' + cur.id : '');
      crumbs.unshift({ id: cur.getAttribute('data-wf-id'), tag: cur.tagName.toLowerCase(), name });
      cur = cur.parentElement;
    }
  }
  crumbs.unshift({ id: null, tag: 'body', name: '' });
  const html = `<div class="wb-breadcrumb">` + crumbs.map((c) => {
    const label = c.tag + esc(c.name);
    return c.id ? `<button data-id="${c.id}">${label}</button>` : `<span>${label}</span>`;
  }).join('<span class="wb-bc-sep">›</span>') + `</div><div class="wb-canvas-meta">${dev.label} · ${dev.width}${bs.selId ? ' · #' + bs.selId : ''}</div>`;
  bar.innerHTML = html;
  bar.querySelectorAll('button[data-id]').forEach((b) => {
    b.onclick = () => wbSelect(b.dataset.id);
  });
}

function wbShowTag(elm) {
  const doc = wbFrame().contentDocument;
  let tag = doc.querySelector('.wf-tag');
  if (!tag) { tag = doc.createElement('div'); tag.className = 'wf-tag'; doc.body.appendChild(tag); }
  const cls = elm.className ? '.' + String(elm.className).trim().split(/\s+/)[0] : '';
  tag.textContent = elm.tagName.toLowerCase() + esc(cls);
  tag.style.top = Math.max(0, elm.getBoundingClientRect().top) + 'px';
  tag.style.left = Math.max(0, elm.getBoundingClientRect().left) + 'px';
}
function wbHideTag() {
  const doc = wbFrame().contentDocument;
  const t = doc && doc.querySelector('.wf-tag');
  if (t) t.remove();
}

/* -------------------------------------------------------------- Navigator 树 */

function wbBuildLayers() {
  const tree = document.getElementById('wbLayerTree');
  if (!tree) return;
  const doc = wbFrame().contentDocument;
  if (!doc) return;
  tree.innerHTML = '';
  const bs = wbState();
  const walk = (node, depth) => {
    const children = Array.from(node.children).filter((ch) => ch.tagName !== 'SCRIPT' && ch.tagName !== 'STYLE');
    const hasKids = children.length > 0;
    const id = node.getAttribute('data-wf-id');
    const tag = node.tagName.toLowerCase();
    const icon = WB_TAG_ICONS[tag] || WB_TAG_ICONS[node.className && node.className.includes('container') ? 'container' : 'div'] || '▪';
    const cls = node.className ? '.' + String(node.className).trim().split(/\s+/)[0] : '';
    const name = cls || (node.id ? '#' + node.id : '');
    const row = el('div', 'wb-layer' + (id === bs.selId ? ' active' : '') + (hasKids ? ' has-children' : ''));
    row.dataset.id = id;
    row.style.paddingLeft = 8 + depth * 14 + 'px';
    row.innerHTML = `
      <span class="wb-layer-arrow" style="visibility:${hasKids ? 'visible' : 'hidden'}">▾</span>
      <span class="wb-layer-icon">${icon}</span>
      <span class="wb-layer-tag">${esc(tag)}</span>
      <span class="wb-layer-name">${esc(name)}</span>`;
    row.onclick = (e) => {
      if (e.target.classList.contains('wb-layer-arrow')) {
        e.stopPropagation();
        row.classList.toggle('collapsed');
        return;
      }
      wbSelect(id);
    };
    tree.appendChild(row);
    if (!bs.collapsed.has(id)) {
      children.forEach((ch) => walk(ch, depth + 1));
    }
  };
  Array.from(doc.body.children).forEach((ch) => walk(ch, 0));
}

/* -------------------------------------------------------------- 添加元素 */

function wbIsContainer(el) {
  return WB_CONTAINER_TAGS.includes((el.tagName || '').toUpperCase());
}

function wbPlaceholderImg() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#dfe7e6"/><text x="50%" y="50%" font-family="sans-serif" font-size="16" fill="#7a8c88" text-anchor="middle" dominant-baseline="middle">图片占位</text></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function wbCreateNode(type, doc) {
  const tag = { heading: 'h2', text: 'p', image: 'img', link: 'a', button: 'button', list: 'ul', grid: 'div', container: 'div', section: 'section' }[type] || 'div';
  const n = doc.createElement(tag);
  const set = (k, v) => n.style.setProperty(k, v);
  switch (type) {
    case 'section': set('padding', '40px 24px'); set('background', '#f4f7f6'); set('min-height', '120px'); n.innerHTML = '<h2 style="margin:0">新区块</h2>'; break;
    case 'container': n.className = 'container'; set('max-width', '960px'); set('margin', '0 auto'); set('padding', '24px'); n.textContent = '容器内容'; break;
    case 'div': set('padding', '16px'); set('border', '1px solid #ddd'); set('min-height', '40px'); n.textContent = '区块'; break;
    case 'heading': n.textContent = '标题文本'; break;
    case 'text': n.textContent = '在此输入段落文字。双击可编辑。'; break;
    case 'link': n.setAttribute('href', '#'); n.textContent = '链接文字'; set('color', '#1a73e8'); break;
    case 'button': n.textContent = '按钮'; set('padding', '8px 16px'); set('background', '#1A5C56'); set('color', '#fff'); set('border', 'none'); set('border-radius', '6px'); set('cursor', 'pointer'); break;
    case 'image': n.setAttribute('src', wbPlaceholderImg()); n.setAttribute('alt', ''); set('max-width', '100%'); break;
    case 'list': n.innerHTML = '<li>项目一</li><li>项目二</li><li>项目三</li>'; set('padding-left', '1.4em'); break;
    case 'grid': n.style.display = 'grid'; n.style.gridTemplateColumns = '1fr 1fr'; n.style.gap = '12px'; n.innerHTML = '<div style="background:#eef;padding:16px">单元格 1</div><div style="background:#eef;padding:16px">单元格 2</div>'; break;
  }
  return n;
}

function wbAddElement(type) {
  const doc = wbFrame().contentDocument;
  if (!doc) return;
  const bs = wbState();
  // 添加元素时自动回到 Navigator，方便看到新元素并删除
  if (bs.leftTab !== 'navigator') wbToggleLeft('navigator');
  const sel = bs.selId ? wbEl(bs.selId) : null;
  let parent = doc.body;
  if (sel) parent = wbIsContainer(sel) ? sel : (sel.parentElement && sel.parentElement.closest('[data-wf-id]') ? sel.parentElement.closest('[data-wf-id]') : doc.body);
  const node = wbCreateNode(type, doc);
  parent.appendChild(node);
  wbRenumber();
  wbBuildLayers();
  wbSelect(node.getAttribute('data-wf-id'));
  wbSerializeSoon();
  toast('已添加：' + type, 'ok');
}

function wbRenderAddList() {
  const list = document.getElementById('wbAddList');
  if (!list) return;
  const items = [
    ['section', 'Section 区块', '▭'],
    ['container', 'Container 容器', '▢'],
    ['div', 'Div 区块', '▫'],
    ['heading', 'Heading 标题', 'H'],
    ['text', 'Text 段落', '¶'],
    ['link', 'Link 链接', '🔗'],
    ['button', 'Button 按钮', '⬚'],
    ['image', 'Image 图片', '🖼'],
    ['list', 'List 列表', '☰'],
    ['grid', 'Grid 网格', '▦'],
  ];
  list.innerHTML = items.map(([t, label, icon]) => `<button class="wb-add-item" data-type="${t}"><span class="ic">${icon}</span><span>${esc(label)}</span></button>`).join('');
  list.querySelectorAll('.wb-add-item').forEach((b) => { b.onclick = () => wbAddElement(b.dataset.type); });
}

/* -------------------------------------------------------------- 检查器：标签页 */

function wbRenderInspectTabs() {
  const tabs = document.getElementById('wbInspectTabs');
  if (!tabs) return;
  const bs = wbState();
  tabs.innerHTML = `
    <button class="wb-tab ${bs.inspectTab === 'style' ? 'on' : ''}" data-tab="style">Style</button>
    <button class="wb-tab ${bs.inspectTab === 'settings' ? 'on' : ''}" data-tab="settings">Settings</button>`;
  tabs.querySelectorAll('.wb-tab').forEach((b) => {
    b.onclick = () => { bs.inspectTab = b.dataset.tab; wbRenderInspectTabs(); wbRenderInspector(); };
  });
}

function wbRenderInspector() {
  const body = document.getElementById('wbInspectBody');
  if (!body) return;
  const bs = wbState();
  const elc = bs.selId ? wbEl(bs.selId) : null;
  if (!elc) {
    body.innerHTML = '<div class="wb-inspect-empty">在画布中点选一个元素，这里会出现它的样式与设置。<br>也可以从左侧「Elements」添加新元素。</div>';
    return;
  }
  if (bs.inspectTab === 'style') { body.innerHTML = wbStylePanel(elc); wbBindStylePanel(elc); }
  else { body.innerHTML = wbSettingsPanel(elc); wbBindSettingsPanel(elc); }
}

/* -------------------------------------------------------------- 检查器：样式 */

function wbGetStyle(elc, prop) {
  const bs = wbState();
  if (bs.bp === 'desktop') return elc.style.getPropertyValue(prop) || '';
  const h = elc.getAttribute('data-wf');
  if (h && bs.bpStyles[h] && bs.bpStyles[h][bs.bp]) return bs.bpStyles[h][bs.bp][prop] || '';
  return '';
}

function wbHandle(elc) {
  const bs = wbState();
  const h = String(++bs.handleCounter);
  elc.setAttribute('data-wf', h);
  return h;
}

function wbSetStyle(prop, value, bp) {
  const bs = wbState();
  const elc = bs.selId ? wbEl(bs.selId) : null;
  if (!elc) return;
  if (bp === 'desktop') {
    if (value === '' || value == null) elc.style.removeProperty(prop);
    else elc.style.setProperty(prop, value);
  } else {
    let h = elc.getAttribute('data-wf');
    if (!h) h = wbHandle(elc);
    if (!bs.bpStyles[h]) bs.bpStyles[h] = {};
    if (!bs.bpStyles[h][bp]) bs.bpStyles[h][bp] = {};
    if (value === '' || value == null) {
      delete bs.bpStyles[h][bp][prop];
      if (!Object.keys(bs.bpStyles[h][bp]).length) delete bs.bpStyles[h][bp];
      if (!Object.keys(bs.bpStyles[h]).length) delete bs.bpStyles[h];
    } else {
      bs.bpStyles[h][bp][prop] = value;
    }
    wbApplyBpStyles();
  }
  wbSerializeSoon();
}

function wbApplyBpStyles() {
  const doc = wbFrame().contentDocument;
  if (!doc) return;
  const old = doc.querySelector('style[data-wf-bp]');
  if (old) old.remove();
  const css = wbBuildBpCss();
  if (css) {
    const s = doc.createElement('style');
    s.setAttribute('data-wf-bp', '');
    s.textContent = css;
    doc.head.appendChild(s);
  }
}

function wbBuildBpCss() {
  const bs = wbState();
  let out = '';
  for (const k in bs.bpStyles) {
    for (const bp of ['tablet', 'mobile']) {
      const rules = bs.bpStyles[k][bp];
      if (rules && Object.keys(rules).length) {
        out += `@media (max-width:${WB_BP[bp]}px){ [data-wf="${k}"]{`;
        for (const p in rules) out += `${p}:${rules[p]};`;
        out += '} }\n';
      }
    }
  }
  return out;
}

function wbParseBp(css) {
  const out = {};
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{\s*\[data-wf="([^"]+)"\]\s*\{([^}]*)\}/g;
  let mm;
  while ((mm = re.exec(css))) {
    const bp = Number(mm[1]) >= 768 ? 'tablet' : 'mobile';
    const k = mm[2];
    const body = mm[3];
    const rules = {};
    body.split(';').forEach((decl) => {
      const idx = decl.indexOf(':');
      if (idx > 0) { const p = decl.slice(0, idx).trim(); const v = decl.slice(idx + 1).trim(); if (p) rules[p] = v; }
    });
    if (!out[k]) out[k] = {};
    out[k][bp] = rules;
  }
  return out;
}

function wbColorVal(css) {
  if (!css) return '#000000';
  const tmp = document.createElement('div');
  tmp.style.color = css;
  document.body.appendChild(tmp);
  const v = getComputedStyle(tmp).color;
  document.body.removeChild(tmp);
  const m = v.match(/\d+/g);
  if (!m || m.length < 3) return '#000000';
  return '#' + m.slice(0, 3).map((x) => ('0' + Number(x).toString(16)).slice(-2)).join('');
}

function wbSel(opts, cur, attr) {
  return '<select ' + (attr || '') + '>' + opts.map(([v, l]) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}>${l}</option>`).join('') + '</select>';
}
function wbIn(type, prop, val, ph) {
  return `<input type="${type}" data-wf-prop="${prop}" data-wf-kind="css" value="${esc(val || '')}"${ph ? ` placeholder="${ph}"` : ''}>`;
}

function wbStylePanel(elc) {
  const bs = wbState();
  const bp = bs.bp;
  const badge = bp !== 'desktop' ? ` <span class="wb-bp-badge">${bp}</span>` : '';
  const sec = (id, title, inner, open = true) => `<div class="wb-sec" data-sec="${id}"><button class="wb-sec-h" data-sec-h>${esc(title)}${badge}<span class="wb-sec-arrow">${open ? '▾' : '▸'}</span></button><div class="wb-sec-body" ${open ? '' : 'style="display:none"'}>${inner}</div></div>`;

  const tag = elc.tagName.toLowerCase();
  const header = `<div class="wb-el-head"><span class="wb-el-tag">${esc(tag)}</span><button class="tb danger small" id="wbDelElStyle">删除</button></div>`;

  const display = wbGetStyle(elc, 'display') || 'block';
  const layout = `
    <div class="wb-disp-group">
      ${['block','flex','grid','none'].map((d) => `<button class="wb-disp ${display === d ? 'on' : ''}" data-disp="${d}">${{block:'▪ Block',flex:'▭ Flex',grid:'▦ Grid',none:'∅ None'}[d]}</button>`).join('')}
    </div>
    ${display === 'flex' ? wbFlexPanel(elc) : ''}
    ${display === 'grid' ? wbGridPanel(elc) : ''}
    <div class="wb-row2"><label>宽</label>${wbIn('text', 'width', wbGetStyle(elc, 'width'), 'auto')}</div>
    <div class="wb-row2"><label>高</label>${wbIn('text', 'height', wbGetStyle(elc, 'height'), 'auto')}</div>`;

  const spacing = wbBoxModel(elc);

  const size = `
    <div class="wb-row2"><label>Min W</label>${wbIn('text', 'min-width', wbGetStyle(elc, 'min-width'), '0')}</div>
    <div class="wb-row2"><label>Max W</label>${wbIn('text', 'max-width', wbGetStyle(elc, 'max-width'), 'none')}</div>
    <div class="wb-row2"><label>Min H</label>${wbIn('text', 'min-height', wbGetStyle(elc, 'min-height'), '0')}</div>
    <div class="wb-row2"><label>Max H</label>${wbIn('text', 'max-height', wbGetStyle(elc, 'max-height'), 'none')}</div>`;

  const position = wbSel([['', 'Static'], ['relative', 'Relative'], ['absolute', 'Absolute'], ['fixed', 'Fixed'], ['sticky', 'Sticky']], wbGetStyle(elc, 'position') || '', 'data-wf-prop="position" data-wf-kind="css') +
    `<div class="wb-row2"><label>上</label>${wbIn('text', 'top', wbGetStyle(elc, 'top'), '0')}</div>
     <div class="wb-row2"><label>右</label>${wbIn('text', 'right', wbGetStyle(elc, 'right'), '0')}</div>
     <div class="wb-row2"><label>下</label>${wbIn('text', 'bottom', wbGetStyle(elc, 'bottom'), '0')}</div>
     <div class="wb-row2"><label>左</label>${wbIn('text', 'left', wbGetStyle(elc, 'left'), '0')}</div>`;

  const typ = `
    ${wbSel([['', '默认'], ['system-ui, sans-serif', '无衬线'], ['"PingFang SC", sans-serif', '苹方'], ['Georgia, serif', '衬线'], ['monospace', '等宽']], wbGetStyle(elc, 'font-family'), 'data-wf-prop="font-family" data-wf-kind="css"')}
    <div class="wb-row2"><label>字号</label>${wbIn('text', 'font-size', wbGetStyle(elc, 'font-size'), '16px')}</div>
    ${wbSel([['', ''], ['300', '细 300'], ['400', '常规 400'], ['500', '中 500'], ['600', '半粗 600'], ['700', '粗 700']], wbGetStyle(elc, 'font-weight'), 'data-wf-prop="font-weight" data-wf-kind="css"')}
    <div class="wb-row2"><label>行高</label>${wbIn('text', 'line-height', wbGetStyle(elc, 'line-height'), '1.5')}</div>
    <div class="wb-row2"><label>字距</label>${wbIn('text', 'letter-spacing', wbGetStyle(elc, 'letter-spacing'), '0')}</div>
    <div class="wb-disp-group small">
      ${['left','center','right','justify'].map((a) => `<button class="wb-disp ${wbGetStyle(elc, 'text-align') === a ? 'on' : ''}" data-text="${a}">${{left:'◀',center:'≡',right:'▶',justify:'▤'}[a]}</button>`).join('')}
    </div>
    <div class="wb-row2"><label>字色</label><input type="color" data-wf-prop="color" data-wf-kind="css" value="${wbColorVal(wbGetStyle(elc, 'color'))}"></div>`;

  const bg = `<div class="wb-row2"><label>背景</label><input type="color" data-wf-prop="background-color" data-wf-kind="css" value="${wbColorVal(wbGetStyle(elc, 'background-color'))}"><button class="tb small" data-wf-clear="background-color">透明</button></div>`;

  const border = `
    <div class="wb-row2"><label>边宽</label>${wbIn('text', 'border-width', wbGetStyle(elc, 'border-width'), '0')}</div>
    ${wbSel([['', '无'], ['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']], wbGetStyle(elc, 'border-style'), 'data-wf-prop="border-style" data-wf-kind="css"')}
    <div class="wb-row2"><label>边色</label><input type="color" data-wf-prop="border-color" data-wf-kind="css" value="${wbColorVal(wbGetStyle(elc, 'border-color'))}"></div>
    <div class="wb-row2"><label>圆角</label>${wbIn('text', 'border-radius', wbGetStyle(elc, 'border-radius'), '0')}</div>`;

  const eff = `
    <div class="wb-row2"><label>不透明</label><input type="range" min="0" max="1" step="0.05" data-wf-prop="opacity" data-wf-kind="css" value="${wbGetStyle(elc, 'opacity') || '1'}"></div>
    ${wbSel([['', '无'], ['0 1px 3px rgba(0,0,0,.12)', '小 sm'], ['0 4px 12px rgba(0,0,0,.15)', '中 md'], ['0 10px 30px rgba(0,0,0,.18)', '大 lg']], wbGetStyle(elc, 'box-shadow'), 'data-wf-prop="box-shadow" data-wf-kind="css"')}`;

  return header + sec('layout', 'Layout', layout) + sec('spacing', 'Spacing', spacing) + sec('size', 'Size', size) + sec('position', 'Position', position) + sec('typography', 'Typography', typ) + sec('background', 'Background', bg) + sec('border', 'Border', border) + sec('effects', 'Effects', eff);
}

function wbFlexPanel(elc) {
  return `
    <div class="wb-row2"><label>方向</label>${wbSel([['row', '横向 row'], ['column', '纵向 column'], ['row-reverse', 'row-reverse'], ['column-reverse', 'column-reverse']], wbGetStyle(elc, 'flex-direction'), 'data-wf-prop="flex-direction" data-wf-kind="css"')}</div>
    <div class="wb-row2"><label>主轴</label>${wbSel([['flex-start', 'start'], ['center', 'center'], ['flex-end', 'end'], ['space-between', 'between'], ['space-around', 'around'], ['space-evenly', 'evenly']], wbGetStyle(elc, 'justify-content'), 'data-wf-prop="justify-content" data-wf-kind="css"')}</div>
    <div class="wb-row2"><label>交叉轴</label>${wbSel([['stretch', 'stretch'], ['flex-start', 'start'], ['center', 'center'], ['flex-end', 'end']], wbGetStyle(elc, 'align-items'), 'data-wf-prop="align-items" data-wf-kind="css"')}</div>
    <div class="wb-row2"><label>换行</label>${wbSel([['nowrap', '不换行'], ['wrap', '换行'], ['wrap-reverse', '反向']], wbGetStyle(elc, 'flex-wrap'), 'data-wf-prop="flex-wrap" data-wf-kind="css"')}</div>
    <div class="wb-row2"><label>Gap</label>${wbIn('text', 'gap', wbGetStyle(elc, 'gap'), '0')}</div>`;
}

function wbGridPanel(elc) {
  return `
    <div class="wb-row2"><label>列</label>${wbIn('text', 'grid-template-columns', wbGetStyle(elc, 'grid-template-columns'), '1fr 1fr')}</div>
    <div class="wb-row2"><label>行</label>${wbIn('text', 'grid-template-rows', wbGetStyle(elc, 'grid-template-rows'), 'auto')}</div>
    <div class="wb-row2"><label>Gap</label>${wbIn('text', 'gap', wbGetStyle(elc, 'gap'), '0')}</div>`;
}

function wbBoxModel(elc) {
  const g = (p) => wbIn('text', p, wbGetStyle(elc, p), '0');
  return `
    <div class="wb-box-wrap">
      <div class="wb-box-label" style="top:2px;left:6px">margin</div>
      <div class="wb-box-margin">
        <input class="wb-box-top" data-wf-prop="margin-top" data-wf-kind="css" value="${esc(wbGetStyle(elc, 'margin-top') || '')}" placeholder="0">
        <input class="wb-box-right" data-wf-prop="margin-right" data-wf-kind="css" value="${esc(wbGetStyle(elc, 'margin-right') || '')}" placeholder="0">
        <input class="wb-box-bottom" data-wf-prop="margin-bottom" data-wf-kind="css" value="${esc(wbGetStyle(elc, 'margin-bottom') || '')}" placeholder="0">
        <input class="wb-box-left" data-wf-prop="margin-left" data-wf-kind="css" value="${esc(wbGetStyle(elc, 'margin-left') || '')}" placeholder="0">
        <div class="wb-box-label" style="top:2px;left:6px">padding</div>
        <div class="wb-box-padding">
          <input class="wb-box-top" data-wf-prop="padding-top" data-wf-kind="css" value="${esc(wbGetStyle(elc, 'padding-top') || '')}" placeholder="0">
          <input class="wb-box-right" data-wf-prop="padding-right" data-wf-kind="css" value="${esc(wbGetStyle(elc, 'padding-right') || '')}" placeholder="0">
          <input class="wb-box-bottom" data-wf-prop="padding-bottom" data-wf-kind="css" value="${esc(wbGetStyle(elc, 'padding-bottom') || '')}" placeholder="0">
          <input class="wb-box-left" data-wf-prop="padding-left" data-wf-kind="css" value="${esc(wbGetStyle(elc, 'padding-left') || '')}" placeholder="0">
          <div class="wb-box-content">content</div>
        </div>
      </div>
    </div>`;
}

function wbBindStylePanel(elc) {
  const bs = wbState();
  const body = document.getElementById('wbInspectBody');

  // 折叠面板
  body.querySelectorAll('[data-sec-h]').forEach((h) => {
    h.onclick = () => {
      const sec = h.closest('.wb-sec');
      const b = sec.querySelector('.wb-sec-body');
      const arrow = h.querySelector('.wb-sec-arrow');
      const show = b.style.display === 'none';
      b.style.display = show ? '' : 'none';
      arrow.textContent = show ? '▾' : '▸';
    };
  });

  // display 图标按钮
  body.querySelectorAll('[data-disp]').forEach((b) => {
    b.onclick = () => { wbSetStyle('display', b.dataset.disp, bs.bp); wbRenderInspector(); };
  });

  // text-align 图标按钮
  body.querySelectorAll('[data-text]').forEach((b) => {
    b.onclick = () => { wbSetStyle('text-align', b.dataset.text, bs.bp); wbRenderInspector(); };
  });

  // 通用输入
  body.querySelectorAll('[data-wf-prop]').forEach((inp) => {
    const prop = inp.dataset.wfProp;
    inp.addEventListener('input', () => wbSetStyle(prop, inp.value, bs.bp));
    inp.addEventListener('change', () => { wbSetStyle(prop, inp.value, bs.bp); if (prop === 'display') wbRenderInspector(); });
  });

  // 透明按钮
  body.querySelectorAll('[data-wf-clear]').forEach((b) => {
    b.onclick = () => { const p = b.dataset.wfClear; wbSetStyle(p, '', bs.bp); wbRenderInspector(); };
  });

  // Style 面板顶部删除按钮
  const delStyle = body.querySelector('#wbDelElStyle');
  if (delStyle) delStyle.onclick = () => wbDeleteSelected();
}

/* -------------------------------------------------------------- 检查器：设置 */

function wbSettingsPanel(elc) {
  const tag = elc.tagName.toLowerCase();
  let html = '<div class="wb-sec"><button class="wb-sec-h" data-sec-h>Element<span class="wb-sec-arrow">▾</span></button><div class="wb-sec-body">';
  html += `<div class="wb-row2"><label>标签</label><input value="${tag}" disabled></div>`;
  if (WB_TEXT_TAGS.includes(elc.tagName)) {
    html += `<div class="wb-field"><label>文本内容</label><textarea data-wf-text>${esc(elc.textContent)}</textarea></div>`;
  }
  if (tag === 'a') html += `<div class="wb-field"><label>链接 href</label><input type="text" data-wf-attr="href" value="${esc(elc.getAttribute('href') || '')}"></div>`;
  if (tag === 'img') html += `<div class="wb-field"><label>图片 src</label><input type="text" data-wf-attr="src" value="${esc(elc.getAttribute('src') || '')}"></div>`;
  html += `<div class="wb-field"><label>class</label><input type="text" data-wf-prop2="className" value="${esc(elc.className)}"></div>`;
  html += `<div class="wb-field"><label>id</label><input type="text" data-wf-prop2="id" value="${esc(elc.id)}"></div>`;
  html += '</div></div>';
  html += '<div class="wb-sec"><button class="tb danger wb-del" id="wbDelEl">删除元素</button></div>';
  return html;
}

function wbBindSettingsPanel(elc) {
  const body = document.getElementById('wbInspectBody');
  body.querySelectorAll('[data-sec-h]').forEach((h) => {
    h.onclick = () => {
      const sec = h.closest('.wb-sec');
      const b = sec.querySelector('.wb-sec-body');
      const arrow = h.querySelector('.wb-sec-arrow');
      const show = b.style.display === 'none';
      b.style.display = show ? '' : 'none';
      arrow.textContent = show ? '▾' : '▸';
    };
  });
  const ta = body.querySelector('[data-wf-text]');
  if (ta) ta.addEventListener('input', () => { elc.textContent = ta.value; wbSerializeSoon(); });
  const href = body.querySelector('[data-wf-attr="href"]');
  if (href) href.addEventListener('input', () => { elc.setAttribute('href', href.value); wbSerializeSoon(); });
  const src = body.querySelector('[data-wf-attr="src"]');
  if (src) src.addEventListener('input', () => { elc.setAttribute('src', src.value); wbSerializeSoon(); });
  const cls = body.querySelector('[data-wf-prop2="className"]');
  if (cls) cls.addEventListener('input', () => { elc.className = cls.value; wbSerializeSoon(); });
  const idn = body.querySelector('[data-wf-prop2="id"]');
  if (idn) idn.addEventListener('input', () => { elc.id = idn.value; wbSerializeSoon(); });
  const del = body.querySelector('#wbDelEl');
  if (del) del.onclick = () => wbDeleteSelected();
}

function wbDeleteSelected() {
  const bs = wbState();
  const elc = bs.selId ? wbEl(bs.selId) : null;
  if (!elc) return;
  elc.remove();
  wbRenumber();
  wbBuildLayers();
  wbHideTag();
  wbSelect(null);
  wbSerializeSoon();
}

/* -------------------------------------------------------------- 序列化回源码 */

let wbSerTimer = null;
function wbSerializeSoon() {
  clearTimeout(wbSerTimer);
  wbSerTimer = setTimeout(wbSerialize, 300);
}

function wbSerialize() {
  const frame = wbFrame();
  if (!frame) return;
  const doc = frame.contentDocument;
  if (!doc) return;
  const bs = wbState();
  const clone = doc.documentElement.cloneNode(true);
  const base = clone.querySelector('base');
  if (base) base.remove();
  clone.querySelectorAll('[data-wf-helper]').forEach((n) => n.remove());
  clone.querySelectorAll('.wf-tag').forEach((n) => n.remove());
  clone.querySelectorAll('.wf-sel').forEach((n) => n.classList.remove('wf-sel'));
  clone.querySelectorAll('.wf-hover').forEach((n) => n.classList.remove('wf-hover'));
  clone.querySelectorAll('[data-wf-id]').forEach((n) => n.removeAttribute('data-wf-id'));
  const s = '<!DOCTYPE html>\n' + clone.outerHTML;
  const tab = wbActiveTab();
  if (tab) {
    tab.content = s;
    tab.dirty = s !== tab.original;
  }
  renderEditorList();
  edUpdateStatus();
}
