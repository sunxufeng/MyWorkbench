'use strict';
/* ==========================================================================
   文件编辑器渲染层（VS Code 风格）：文件夹树、多标签 CodeMirror 编辑器、
   实时预览、分屏、多文件搜索、图片拖拽插入、Emmet、主题/背景自定义。
   依赖 app.js 暴露的全局：el / esc / toast / act / API / state / openModal /
   confirmDialog / openUrl
   ========================================================================== */

const ED_DEFAULT_THEME = {
  preset: 'dark',
  bg: '#174A45',
  sidebar: '#0F2E2B',
  bar: '#1A5C56',
  accent: '#4ECDC4',
  codeBg: '#0b2623',
  codeTxt: '#eafffb',
  bgImage: '',
  bgOpacity: 1,
};

const ED_PRESETS = {
  dark: { bg: '#174A45', sidebar: '#0F2E2B', bar: '#1A5C56', accent: '#4ECDC4', codeBg: '#0b2623', codeTxt: '#eafffb' },
  midnight: { bg: '#1a1a2e', sidebar: '#16213e', bar: '#0f3460', accent: '#e94560', codeBg: '#0d1117', codeTxt: '#e6edf3' },
  light: { bg: '#f6f2ea', sidebar: '#efe9dd', bar: '#e4dbcb', accent: '#6e8163', codeBg: '#ffffff', codeTxt: '#2c2a25' },
  green: { bg: '#1b2e25', sidebar: '#14241d', bar: '#244234', accent: '#7bc47e', codeBg: '#0f1f18', codeTxt: '#e6f3e9' },
};

let edEditors = [];        // 当前 pane 对应的 CodeMirror 实例
let edActivePane = 0;      // 当前激活的 pane 索引
let edUpdateTimer = null;  // 预览刷新防抖
let edSearchTimer = null;  // 搜索防抖

function edInitTheme() {
  if (!state.ed.theme || !state.ed.theme.preset) state.ed.theme = { ...ED_DEFAULT_THEME };
  edApplyTheme();
}

function edApplyTheme() {
  const app = $('#app');
  if (!app) return;
  const t = state.ed.theme;
  app.style.setProperty('--ed-bg', t.bg);
  app.style.setProperty('--ed-sidebar', t.sidebar);
  app.style.setProperty('--ed-bar', t.bar);
  app.style.setProperty('--ed-accent', t.accent);
  app.style.setProperty('--ed-code-bg', t.codeBg);
  app.style.setProperty('--ed-code-txt', t.codeTxt);
  app.style.setProperty('--ed-bg-image', t.bgImage ? `url(${t.bgImage})` : 'none');
  app.style.setProperty('--ed-bg-opacity', String(t.bgOpacity));
}

function edModeFor(filePath) {
  const ext = (filePath || '').split('.').pop().toLowerCase();
  if (['html', 'htm', 'xhtml'].includes(ext)) return 'htmlmixed';
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return 'css';
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json'].includes(ext)) return 'javascript';
  if (['xml', 'svg'].includes(ext)) return 'xml';
  return 'text';
}

function edIconFor(filePath) {
  const ext = (filePath || '').split('.').pop().toLowerCase();
  if (['html', 'htm'].includes(ext)) return '🌐';
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return '🎨';
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json'].includes(ext)) return '📜';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return '🖼';
  if (['md', 'markdown'].includes(ext)) return '📝';
  if (['txt'].includes(ext)) return '📄';
  return '📄';
}

function edRelPath(fullPath) {
  if (!state.ed.root || !fullPath) return fullPath || '';
  return fullPath.slice(state.ed.root.length).replace(/^[/\\]/, '');
}

function edIsImagePath(p) {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(p || '');
}

/* ---------------------------------------------------------- 中栏：文件树 */

function renderEditorList() {
  const scroll = $('#listScroll');
  scroll.innerHTML = '';
  const host = el('div', 'ed-host');

  const toolbar = el('div', 'ed-toolbar');
  const openBtn = el('button', 'tb', '📂 打开文件夹');
  openBtn.onclick = edOpenFolder;
  const newBtn = el('button', 'tb', '＋ 新建文件');
  newBtn.onclick = edNewFile;
  toolbar.append(openBtn, newBtn);
  host.appendChild(toolbar);

  const treeWrap = el('div', 'ed-tree-wrap');
  if (!state.ed.root) {
    const empty = el('div', 'ed-empty');
    empty.innerHTML = '<div class="big">💻</div><p>点击「打开文件夹」选择一个本地项目或网站目录。</p>';
    treeWrap.appendChild(empty);
  } else {
    treeWrap.appendChild(edBuildTree(state.ed.tree, 0));
  }
  host.appendChild(treeWrap);
  scroll.appendChild(host);
}

function edBuildTree(node, depth) {
  if (!node) return el('div');
  const wrap = el('div', 'ed-tree-node');
  if (node.type === 'dir') {
    const row = el('div', 'ed-tree-row ed-dir');
    row.style.paddingLeft = depth * 12 + 'px';
    const expanded = !node.collapsed;
    row.innerHTML = `<span class="ed-caret">${expanded ? '▼' : '▶'}</span><span class="ed-ico">📁</span><span class="ed-name">${esc(node.name)}</span>`;
    row.onclick = () => {
      node.collapsed = !node.collapsed;
      renderEditorList();
    };
    wrap.appendChild(row);
    if (expanded && node.children && node.children.length) {
      const children = el('div', 'ed-tree-children');
      for (const c of node.children) children.appendChild(edBuildTree(c, depth + 1));
      wrap.appendChild(children);
    }
  } else {
    const row = el('div', 'ed-tree-row ed-file' + (state.ed.activePath === node.path ? ' active' : ''));
    row.style.paddingLeft = depth * 12 + 'px';
    const dirty = state.ed.tabs[node.path] && state.ed.tabs[node.path].dirty ? '<span class="ed-dirty"></span>' : '';
    row.innerHTML = `<span class="ed-caret"></span><span class="ed-ico">${edIconFor(node.path)}</span><span class="ed-name">${esc(node.name)}</span>${dirty}`;
    row.onclick = () => edOpenFile(node.path);
    row.ondblclick = () => edOpenFileInOtherPane(node.path);
    wrap.appendChild(row);
  }
  return wrap;
}

/* ---------------------------------------------------------- 右栏：编辑器 */

function renderEditorDetail() {
  const detail = $('#detailScroll');
  detail.innerHTML = '';
  const bar = $('#detailBar');
  bar.innerHTML = '';

  if (!state.ed.root) {
    renderDetailBar([]);
    const empty = el('div', 'ed-empty-large');
    empty.innerHTML = '<div class="big">💻</div><h2>文件编辑器</h2><p>在左侧点击「打开文件夹」，或选择侧栏里的文件开始编辑。</p>';
    detail.appendChild(empty);
    return;
  }

  // 顶栏按钮
  const saveBtn = mkTb('💾 保存', 'primary', edSaveActive, '⌘S');
  const fmtBtn = mkTb('✨ 格式化', '', edFormatActive, '美化 HTML 缩进');
  const prevBtn = mkTb('👁 预览', state.ed.preview ? 'on' : '', edTogglePreview, '切换右侧实时预览');
  const splitBtn = mkTb('⬓ 分屏', state.ed.split ? 'on' : '', edToggleSplit, '并排编辑两个文件');
  // 可视化编辑：仅在 HTML 文件上可点
  const activeForVis = state.ed.panePaths[edActivePane] || state.ed.panePaths[0] || '';
  const visIsHtml = !!activeForVis && ['html', 'htm', 'xhtml'].includes((activeForVis.split('.').pop() || '').toLowerCase());
  const visBtn = mkTb(
    state.ed.visual ? '⟨⟩ 代码' : '✎ 可视化',
    state.ed.visual ? 'on' : '',
    edToggleVisual,
    state.ed.visual ? '切回源码编辑' : '直接在页面上改文字 / 内容（所见即所得）'
  );
  if (!visIsHtml) {
    visBtn.disabled = true;
    visBtn.style.opacity = '0.45';
    visBtn.style.cursor = 'not-allowed';
    visBtn.onclick = null;
    visBtn.title = '仅 HTML 文件支持可视化编辑';
  }
  const imgBtn = mkTb('🖼 插入图片', '', edInsertImageFromPicker, '从磁盘选择图片插入');
  const searchBtn = mkTb('🔍 搜索', '', edToggleSearch, '跨文件搜索');
  const themeBtn = mkTb('🎨 主题', '', edToggleThemePanel, '换背景 / 换颜色');
  const barButtons = [saveBtn, fmtBtn, prevBtn, splitBtn, visBtn, imgBtn, searchBtn, themeBtn];
  if (state.ed.visual) {
    // 可视化模式下，右侧预览被编辑区本身取代，禁用「预览」按钮
    prevBtn.disabled = true;
    prevBtn.style.opacity = '0.45';
    prevBtn.style.cursor = 'not-allowed';
    prevBtn.onclick = null;
    prevBtn.title = '可视化编辑时页面即所见即所得，无需额外预览';
  }
  renderDetailBar(barButtons);

  // 搜索面板
  const searchPanel = el('div', 'ed-search-panel' + (state.ed.searchOpen ? ' show' : ''));
  searchPanel.innerHTML = `
    <input type="text" id="edSearchInput" placeholder="搜索当前文件夹内的文件内容…" value="${esc(state.ed.searchQuery)}" />
    <button class="tb" id="edSearchGo">搜索</button>
    <button class="tb" id="edSearchClose">关闭</button>
    <span id="edSearchStat" class="ed-search-stat"></span>
  `;
  const searchInput = searchPanel.querySelector('#edSearchInput');
  const searchGo = searchPanel.querySelector('#edSearchGo');
  const searchClose = searchPanel.querySelector('#edSearchClose');
  if (searchInput) {
    searchInput.oninput = () => {
      state.ed.searchQuery = searchInput.value;
      clearTimeout(edSearchTimer);
      edSearchTimer = setTimeout(edRunSearch, 350);
    };
    searchInput.onkeydown = (e) => { if (e.key === 'Enter') edRunSearch(); };
  }
  if (searchGo) searchGo.onclick = edRunSearch;
  if (searchClose) searchClose.onclick = () => { state.ed.searchOpen = false; renderEditorDetail(); };

  // 编辑器区
  const area = el('div', 'ed-area' + (state.ed.preview ? '' : ' no-preview') + (state.ed.split ? ' split' : ''));
  area.id = 'edArea';

  edEditors = [];
  const paneCount = state.ed.split ? 2 : 1;
  for (let i = 0; i < paneCount; i++) {
    const pane = el('div', 'ed-pane' + (state.ed.visual ? ' visual' : '') + (edActivePane === i ? ' active' : ''));
    pane.onclick = () => { edActivePane = i; edUpdatePaneActive(); };

    const pbar = el('div', 'ed-pane-bar');
    const sel = el('select', 'ed-pane-select');
    sel.innerHTML = '<option value="">（未打开文件）</option>';
    const openPaths = Object.keys(state.ed.tabs);
    openPaths.forEach((p) => {
      const opt = new Option(edRelPath(p), p);
      if (p === state.ed.panePaths[i]) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = (e) => {
      const path = e.target.value;
      state.ed.panePaths[i] = path;
      if (path && !state.ed.tabs[path]) edLoadFile(path);
      else edRenderPane(i);
    };
    const closeBtn = el('button', 'tb small', '✕');
    closeBtn.title = '关闭当前文件';
    closeBtn.onclick = (e) => { e.stopPropagation(); edCloseFile(state.ed.panePaths[i]); };
    pbar.append(sel, closeBtn);
    pane.appendChild(pbar);

    if (state.ed.visual) {
      // 可视化编辑：轻量格式工具栏 + 可编辑的页面
      const tb = el('div', 'ed-visual-toolbar');
      tb.id = 'edVisualToolbar' + i;
      tb.innerHTML = edVisualToolbarHTML();
      pane.appendChild(tb);
      const vis = el('div', 'ed-visual');
      vis.id = 'edVisual' + i;
      vis.setAttribute('contenteditable', 'true');
      vis.setAttribute('spellcheck', 'false');
      pane.appendChild(vis);
    } else {
      const cmHost = el('div', 'ed-cm-host');
      cmHost.id = 'edCmHost' + i;
      pane.appendChild(cmHost);
    }
    area.appendChild(pane);

    // 分屏分隔条
    if (i === 0 && paneCount === 2) {
      const splitter = el('div', 'ed-splitter');
      splitter.title = '拖拽调整分屏宽度';
      area.appendChild(splitter);
    }
  }

  // 预览区（可视化模式下，编辑区本身即所见即所得，不再叠加右栏预览）
  if (state.ed.preview && !state.ed.visual) {
    const preview = el('div', 'ed-preview');
    preview.innerHTML = `<div class="ed-preview-head"><span>实时预览</span><button class="tb small" id="edOpenBrowser">外部浏览器打开</button></div><div class="ed-preview-body" id="edPreviewBody"></div>`;
    area.appendChild(preview);
    const openBrowser = preview.querySelector('#edOpenBrowser');
    if (openBrowser) openBrowser.onclick = () => {
      const html = edActiveContent();
      if (!html) return;
      const blob = new Blob([edWrapPreview(html)], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      API.openExternal(url);
    };
  }

  // 主题面板
  const themePanel = el('div', 'ed-theme-panel' + (state.ed.themeOpen ? ' show' : ''));
  themePanel.innerHTML = edThemePanelHTML();
  // 搜索结果浮层
  const srPanel = el('div', 'ed-search-results' + (state.ed.searchResults.length ? ' show' : ''));
  srPanel.id = 'edSearchResults';
  srPanel.innerHTML = state.ed.searchResults.length ? edRenderSearchResults() : '';
  // 状态栏
  const statusbar = el('div', 'ed-statusbar');
  statusbar.id = 'edStatus';

  const workspace = el('div', 'ed-workspace');
  workspace.appendChild(searchPanel);
  workspace.appendChild(area);
  workspace.appendChild(themePanel);
  workspace.appendChild(srPanel);
  workspace.appendChild(statusbar);
  detail.appendChild(workspace);

  // 拖拽插入图片
  area.ondragover = (e) => { e.preventDefault(); area.classList.add('ed-drag-over'); };
  area.ondragleave = () => area.classList.remove('ed-drag-over');
  area.ondrop = (e) => {
    e.preventDefault();
    area.classList.remove('ed-drag-over');
    const files = e.dataTransfer.files;
    if (files && files.length) edHandleDroppedFiles(files);
  };
  // 实例化 CodeMirror / 可视化编辑区
  for (let i = 0; i < paneCount; i++) {
    const path = state.ed.panePaths[i];
    if (state.ed.visual) {
      edLoadVisual(i, path);
      const tb = document.getElementById('edVisualToolbar' + i);
      if (tb) edBindVisualToolbar(tb, i);
    } else {
      const cm = edCreateCM('edCmHost' + i, path);
      edEditors[i] = cm;
    }
  }
  edUpdatePaneActive();
  edUpdatePreview();
  edUpdateStatus();
  edBindSearchResults();

  // 绑定主题面板事件
  edBindThemePanel(themePanel);
}

function edCreateCM(hostId, path) {
  const host = document.getElementById(hostId);
  if (!host) return null;
  const tab = path ? state.ed.tabs[path] : null;
  const mode = edModeFor(path || '');
  const cm = CodeMirror(host, {
    value: tab ? tab.content : '',
    mode: mode,
    theme: 'default',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    indentWithTabs: false,
    autoCloseTags: true,
    autoCloseBrackets: true,
    matchTags: { bothTags: true },
    foldGutter: true,
    gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
    styleActiveLine: true,
    extraKeys: {
      Tab: (cm) => edEmmetTab(cm),
      'Shift-Tab': 'indentLess',
      'Ctrl-S': () => edSaveActive(),
      'Cmd-S': () => edSaveActive(),
      'Ctrl-F': () => edToggleSearch(),
      'Cmd-F': () => edToggleSearch(),
    },
  });
  cm.getWrapperElement().classList.add('ed-cm');
  if (tab) {
    cm.edPath = path;
    cm.on('change', () => edOnCMChange(cm));
    cm.on('cursorActivity', edUpdateStatus);
  }
  return cm;
}

function edRenderPane(i) {
  if (state.ed.visual) {
    edLoadVisual(i, state.ed.panePaths[i]);
    return;
  }
  const cm = edEditors[i];
  if (!cm) return;
  const path = state.ed.panePaths[i];
  const tab = path ? state.ed.tabs[path] : null;
  cm.edPath = path || null;
  cm.setOption('mode', edModeFor(path || ''));
  cm.setValue(tab ? tab.content : '');
  cm.clearHistory();
  if (path && tab) {
    cm.on('change', () => edOnCMChange(cm));
    cm.on('cursorActivity', edUpdateStatus);
  }
}

function edUpdatePaneActive() {
  document.querySelectorAll('.ed-pane').forEach((p, i) => p.classList.toggle('active', i === edActivePane));
}

function edOnCMChange(cm) {
  if (!cm.edPath) return;
  const tab = state.ed.tabs[cm.edPath];
  if (!tab) return;
  tab.content = cm.getValue();
  tab.dirty = tab.content !== tab.original;
  renderEditorList();
  clearTimeout(edUpdateTimer);
  edUpdateTimer = setTimeout(edUpdatePreview, 300);
  edUpdateStatus();
}

function edActiveCM() {
  return edEditors[edActivePane] || edEditors[0];
}

function edActivePath() {
  return state.ed.panePaths[edActivePane] || '';
}

function edActiveContent() {
  const p = edActivePath();
  return p && state.ed.tabs[p] ? state.ed.tabs[p].content : '';
}

/* ---------------------------------------------------------- 可视化编辑 */

/** 取 <body> 的内部内容用于就地编辑；没有 body 标签则整段当作内容 */
function edExtractBody(src) {
  const s = String(src || '');
  const m = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) return m[1];
  return s;
}

/** 把编辑后的 body 内容回填进原文档结构（保留 <head> 等外壳） */
function edRebuild(src, newBody) {
  const s = String(src || '');
  const m = s.match(/^([\s\S]*?<body[^>]*>)([\s\S]*?)(<\/body>[\s\S]*)$/i);
  if (m) return m[1] + newBody + m[3];
  return newBody;
}

/** 在指定窗格的 contenteditable 里装载文件内容 */
function edLoadVisual(i, path) {
  const vis = document.getElementById('edVisual' + i);
  if (!vis) return;
  const tab = path ? state.ed.tabs[path] : null;
  vis.innerHTML = tab ? edExtractBody(tab.content) : '';
  vis.dataset.path = path || '';
  clearTimeout(vis._t);
  vis.oninput = () => edOnVisualInput(i);
}

/** 编辑区内容变化时，同步回源码、标记脏、刷新树与状态 */
function edOnVisualInput(i) {
  const vis = document.getElementById('edVisual' + i);
  if (!vis) return;
  const path = vis.dataset.path;
  if (!path || !state.ed.tabs[path]) return;
  const tab = state.ed.tabs[path];
  const newBody = vis.innerHTML;
  tab.content = edRebuild(tab.content, newBody);
  tab.dirty = tab.content !== tab.original;
  edActivePane = i;
  renderEditorList();
  clearTimeout(vis._t);
  vis._t = setTimeout(() => edUpdateStatus(), 300);
  edUpdateStatus();
}

/** 可视化模式的轻量格式工具栏 */
function edVisualToolbarHTML() {
  const btn = (cmd, label, title, val) =>
    `<button type="button" data-cmd="${cmd}"${val ? ` data-val="${val}"` : ''} title="${esc(title)}">${label}</button>`;
  return [
    btn('bold', 'B', '加粗'),
    btn('italic', 'I', '斜体'),
    btn('underline', 'U', '下划线'),
    '<span class="sep"></span>',
    btn('formatBlock', 'H1', '一级标题', 'h1'),
    btn('formatBlock', 'H2', '二级标题', 'h2'),
    btn('formatBlock', 'H3', '三级标题', 'h3'),
    '<span class="sep"></span>',
    btn('insertUnorderedList', '• 列表', '无序列表'),
    btn('insertOrderedList', '1. 列表', '有序列表'),
    '<span class="sep"></span>',
    btn('createLink', '🔗 链接', '插入 / 编辑链接'),
    btn('insertImage', '🖼 图片', '插入图片'),
    btn('removeFormat', '⌫ 清除', '清除格式'),
  ].join('');
}

function edBindVisualToolbar(toolbar, i) {
  if (!toolbar) return;
  toolbar.querySelectorAll('button[data-cmd]').forEach((b) => {
    // mousedown 时阻止默认，避免点击按钮后编辑区失去选中文本
    b.onmousedown = (e) => { e.preventDefault(); };
    b.onclick = () => edVisualCommand(b.dataset.cmd, b.dataset.val || null, i);
  });
}

function edVisualCommand(cmd, val, i) {
  const vis = document.getElementById('edVisual' + i);
  if (!vis) return;
  edActivePane = i;
  vis.focus();
  if (cmd === 'createLink') {
    const url = prompt('链接地址（URL）：', 'https://');
    if (!url) return;
    document.execCommand('createLink', false, url);
  } else if (cmd === 'insertImage') {
    edVisualInsertImage(vis);
    return;
  } else if (cmd === 'formatBlock') {
    document.execCommand('formatBlock', false, '<' + (val || 'p') + '>');
  } else {
    document.execCommand(cmd, false, val);
  }
  edOnVisualInput(i);
}

async function edVisualInsertImage(vis) {
  const r = await act(API.pickFiles('image'));
  if (!r || !r.length) return;
  const filePath = r[0];
  let src = '';
  if (state.ed.root && filePath.startsWith(state.ed.root)) {
    src = edRelPath(filePath).replace(/\\/g, '/');
  } else {
    const rr = await act(API.editor.read(filePath, 'base64'));
    if (!rr || rr.error || !rr.content) { toast('读取图片失败', 'err'); return; }
    const ext = (filePath.split('.').pop() || 'png').toLowerCase();
    src = `data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${rr.content}`;
  }
  vis.focus();
  document.execCommand('insertHTML', false, `<img src="${esc(src)}" alt="" style="max-width:100%">`);
  edOnVisualInput(edActivePane);
}

/** 切换「代码 / 可视化」模式 */
function edToggleVisual() {
  const activeForVis = state.ed.panePaths[edActivePane] || state.ed.panePaths[0] || '';
  const visIsHtml = !!activeForVis && ['html', 'htm', 'xhtml'].includes((activeForVis.split('.').pop() || '').toLowerCase());
  if (!state.ed.visual && !visIsHtml) {
    toast('可视化编辑仅支持 HTML 文件', 'warn');
    return;
  }
  state.ed.visual = !state.ed.visual;
  // 进入可视化模式时，编辑区本身即所见即所得，关闭右栏预览以免重复
  if (state.ed.visual) state.ed.preview = false;
  renderEditorDetail();
}

/* ---------------------------------------------------------- 文件操作 */

async function edOpenFolder() {
  const r = await act(API.editor.openFolder());
  if (!r || r.canceled || !r.path) return;
  state.ed.root = r.path;
  state.ed.tabs = {};
  state.ed.activePath = '';
  state.ed.panePaths = ['', ''];
  toast('已打开文件夹：' + edRelPath(r.path), 'ok');
  await edRefreshTree();
}

async function edRefreshTree() {
  if (!state.ed.root) return;
  const r = await act(API.editor.list(state.ed.root));
  state.ed.tree = r || null;
  renderEditorList();
}

async function edLoadFile(filePath) {
  if (!filePath) return;
  if (edIsImagePath(filePath)) {
    toast('图片文件不可编辑，可在 HTML 中插入引用', 'warn');
    return;
  }
  if (!state.ed.tabs[filePath]) {
    const r = await act(API.editor.read(filePath, 'utf8'));
    if (!r || r.error) { toast(r ? r.error : '读取失败', 'err'); return; }
    state.ed.tabs[filePath] = {
      content: r.content || '',
      original: r.content || '',
      type: edModeFor(filePath),
      ext: (filePath.split('.').pop() || '').toLowerCase(),
      dirty: false,
    };
  }
  state.ed.activePath = filePath;
  // 如果当前 pane 为空，则占用；否则替换当前 pane
  if (!state.ed.panePaths[edActivePane]) state.ed.panePaths[edActivePane] = filePath;
  else if (state.ed.split && state.ed.panePaths[(edActivePane + 1) % 2] === filePath) {
    // 另一屏已是该文件，切换焦点
    edActivePane = (edActivePane + 1) % 2;
  } else {
    state.ed.panePaths[edActivePane] = filePath;
  }
  renderEditorList();
  renderEditorDetail();
}

function edOpenFile(filePath) {
  edLoadFile(filePath);
}

function edOpenFileInOtherPane(filePath) {
  if (!state.ed.split) edToggleSplit();
  edActivePane = state.ed.panePaths[0] === filePath ? 1 : 0;
  edLoadFile(filePath);
}

async function edSaveActive() {
  const path = edActivePath();
  if (!path) { toast('没有活动文件可保存', 'err'); return; }
  const tab = state.ed.tabs[path];
  if (!tab || !tab.dirty) { toast('没有修改需要保存', 'ok'); return; }
  const r = await act(API.editor.write(path, tab.content));
  if (!r || r.error) { toast(r ? r.error : '保存失败', 'err'); return; }
  tab.original = tab.content;
  tab.dirty = false;
  renderEditorList();
  edUpdateStatus();
  toast('已保存：' + edRelPath(path), 'ok');
}

function edCloseFile(filePath) {
  if (!filePath) return;
  const tab = state.ed.tabs[filePath];
  if (tab && tab.dirty) {
    confirmDialog({
      title: '关闭前保存？',
      message: `${edRelPath(filePath)} 有未保存修改，是否先保存？`,
      okLabel: '保存并关闭',
      cancelLabel: '不保存关闭',
    }).then(async (ok) => {
      if (ok) {
        const r = await act(API.editor.write(filePath, tab.content));
        if (!r || r.error) { toast(r ? r.error : '保存失败', 'err'); return; }
      }
      delete state.ed.tabs[filePath];
      if (state.ed.activePath === filePath) state.ed.activePath = '';
      state.ed.panePaths = state.ed.panePaths.map((p) => (p === filePath ? '' : p));
      renderEditorList();
      renderEditorDetail();
    });
    return;
  }
  delete state.ed.tabs[filePath];
  if (state.ed.activePath === filePath) state.ed.activePath = '';
  state.ed.panePaths = state.ed.panePaths.map((p) => (p === filePath ? '' : p));
  renderEditorList();
  renderEditorDetail();
}

async function edNewFile() {
  if (!state.ed.root) { toast('先打开一个文件夹', 'warn'); return; }
  const name = prompt('新建文件名（含扩展名，如 index.html）：');
  if (!name) return;
  const full = state.ed.root + '/' + name;
  if (state.ed.tabs[full]) { toast('文件已存在', 'warn'); return; }
  const r = await act(API.editor.write(full, ''));
  if (!r || r.error) { toast(r ? r.error : '创建失败', 'err'); return; }
  state.ed.tabs[full] = { content: '', original: '', type: edModeFor(full), ext: (name.split('.').pop() || '').toLowerCase(), dirty: false };
  await edRefreshTree();
  edLoadFile(full);
}

/* ---------------------------------------------------------- 格式化 / Emmet */

function edFormatActive() {
  const cm = edActiveCM();
  if (!cm) return;
  const path = cm.edPath;
  const ext = (path || '').split('.').pop().toLowerCase();
  if (!['html', 'htm', 'xhtml'].includes(ext)) { toast('格式化目前仅支持 HTML 文件', 'warn'); return; }
  const formatted = edFormatHTML(cm.getValue());
  cm.setValue(formatted);
  toast('已格式化', 'ok');
}

function edFormatHTML(html) {
  let out = '';
  let indent = 0;
  const src = String(html || '');
  // 简单分词：标签、文本、注释、doctype
  const tokens = src.split(/(<\/?[^>]+>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)/i).filter((s) => s !== '');
  for (const tok of tokens) {
    if (/^<!DOCTYPE/i.test(tok)) { out += tok.trim() + '\n'; continue; }
    if (/^<!--/.test(tok)) {
      out += '  '.repeat(indent) + tok.trim() + '\n';
      continue;
    }
    if (/^<\//.test(tok)) {
      indent = Math.max(0, indent - 1);
      out += '  '.repeat(indent) + tok.trim() + '\n';
      continue;
    }
    if (/^[a-zA-Z][\w-]*\s*\/.*>/.test(tok) || /^<[\w-]/.test(tok)) {
      const selfClosing = /^<[a-zA-Z][\w-]*\s*\/.*>/.test(tok) || /<[^>] + \/>\s*$/.test(tok.trim());
      out += '  '.repeat(indent) + tok.trim() + '\n';
      if (!selfClosing && /^<[\w-]/.test(tok)) indent++;
      continue;
    }
    const text = tok.trim();
    if (text) out += '  '.repeat(indent) + text + '\n';
  }
  return out.trim();
}

function edEmmetTab(cm) {
  if (cm.getOption('mode') !== 'htmlmixed') return CodeMirror.Pass;
  const cur = cm.getCursor();
  const line = cm.getLine(cur.line);
  const before = line.slice(0, cur.ch);
  const abbr = edExtractEmmetAbbrev(before);
  if (!abbr) return CodeMirror.Pass;
  let expanded;
  try { expanded = edExpandEmmet(abbr); } catch (e) { return CodeMirror.Pass; }
  if (!expanded) return CodeMirror.Pass;
  const start = { line: cur.line, ch: cur.ch - abbr.length };
  cm.replaceRange(expanded, start, cur);
}

function edExtractEmmetAbbrev(before) {
  // 支持 a>b*3.c#d{中文}+e 等；不支持纯单词触发
  const m = before.match(/[a-zA-Z0-9!>+*.()#[\]{}=\-_:]*$/);
  if (!m || !m[0]) return '';
  const abbr = m[0];
  if (/^[a-zA-Z0-9_]+$/.test(abbr) && abbr !== '!') return '';
  return abbr;
}

function edExpandEmmet(abbr) {
  if (abbr === '!') {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title></title>
</head>
<body>

</body>
</html>`;
  }
  // 支持单个节点：tag#id.class{文本}*n
  const m = abbr.match(/^([a-zA-Z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)+)?(\{[^}]*\})?(\*(\d+))?$/);
  if (!m) return '';
  const tag = m[1] || 'div';
  const id = m[2] ? ` id="${m[2].slice(1)}"` : '';
  const cls = m[3] ? ` class="${m[3].split('.').filter(Boolean).join(' ')}"` : '';
  const text = m[4] ? m[4].slice(1, -1) : '';
  const count = Math.max(1, parseInt(m[6] || '1', 10));
  let out = '';
  for (let i = 0; i < count; i++) out += `<${tag}${id}${cls}>${text}</${tag}>\n`;
  return out.trim();
}

/* ---------------------------------------------------------- 预览 */

function edTogglePreview() {
  state.ed.preview = !state.ed.preview;
  renderEditorDetail();
}

function edToggleSplit() {
  state.ed.split = !state.ed.split;
  if (state.ed.split) {
    const openPaths = Object.keys(state.ed.tabs);
    const other = openPaths.find((p) => p !== state.ed.panePaths[0]);
    state.ed.panePaths[1] = other || state.ed.panePaths[0];
  } else {
    state.ed.panePaths[1] = '';
  }
  renderEditorDetail();
}

function edToggleSearch() {
  state.ed.searchOpen = !state.ed.searchOpen;
  if (!state.ed.searchOpen) state.ed.searchResults = [];
  renderEditorDetail();
  if (state.ed.searchOpen) setTimeout(() => { const si = $('#edSearchInput'); if (si) si.focus(); }, 50);
}

function edToggleThemePanel() {
  state.ed.themeOpen = !state.ed.themeOpen;
  renderEditorDetail();
}

function edUpdatePreview() {
  const body = $('#edPreviewBody');
  if (!body) return;
  const path = edActivePath();
  if (!path) { body.innerHTML = '<div class="ed-preview-empty">打开 HTML 文件即可实时预览</div>'; return; }
  const tab = state.ed.tabs[path];
  if (!tab) return;
  if (tab.type !== 'htmlmixed' && tab.type !== 'text') { body.innerHTML = '<div class="ed-preview-empty">当前文件不是 HTML，无法预览</div>'; return; }
  const html = edWrapPreview(tab.content);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  body.innerHTML = `<iframe src="${url}" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`;
}

function edWrapPreview(content) {
  const base = state.ed.root ? state.ed.root.replace(/\\/g, '/') + '/' : '';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<base href="file://${base}">
<style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;padding:20px;}</style>
</head>
<body>
${content}
</body>
</html>`;
}

/* ---------------------------------------------------------- 图片插入 */

async function edInsertImageFromPicker() {
  const r = await act(API.pickFiles('image'));
  if (!r || !r.length) return;
  for (const p of r) await edInsertImage(p);
}

async function edHandleDroppedFiles(files) {
  for (const f of files) {
    const p = API.pathForFile(f);
    if (p) {
      if (edIsImagePath(p)) await edInsertImage(p);
      else if (p.endsWith('.html') || p.endsWith('.css') || p.endsWith('.js')) edLoadFile(p);
    }
  }
}

async function edInsertImage(filePath) {
  const cm = edActiveCM();
  let src = '';
  if (state.ed.root && filePath.startsWith(state.ed.root)) {
    src = edRelPath(filePath).replace(/\\/g, '/');
  } else {
    const r = await act(API.editor.read(filePath, 'base64'));
    if (!r || r.error || !r.content) { toast('读取图片失败', 'err'); return; }
    const ext = (filePath.split('.').pop() || 'png').toLowerCase();
    src = `data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${r.content}`;
  }
  const tag = `<img src="${esc(src)}" alt="" style="max-width:100%">`;
  if (cm) {
    cm.replaceSelection(tag);
    toast('已插入图片', 'ok');
  } else if (state.ed.visual) {
    const vis = document.getElementById('edVisual' + edActivePane);
    if (!vis) { toast('先打开一个 HTML 文件再插入图片', 'warn'); return; }
    vis.focus();
    document.execCommand('insertHTML', false, tag);
    edOnVisualInput(edActivePane);
    toast('已插入图片', 'ok');
  } else {
    toast('先打开一个文件再插入图片', 'warn');
  }
}

/* ---------------------------------------------------------- 搜索 */

async function edRunSearch() {
  const q = (state.ed.searchQuery || '').trim();
  const stat = $('#edSearchStat');
  if (stat) stat.textContent = '搜索中…';
  if (!q) { state.ed.searchResults = []; renderEditorDetail(); return; }
  const results = [];
  const files = edFlattenFiles(state.ed.tree).filter((f) => !edIsImagePath(f.path));
  for (const f of files) {
    let r = state.ed.tabs[f.path];
    if (!r) {
      r = await act(API.editor.read(f.path, 'utf8'));
      if (r && !r.error) state.ed.tabs[f.path] = { content: r.content, original: r.content, type: edModeFor(f.path), ext: (f.name.split('.').pop() || '').toLowerCase(), dirty: false };
    }
    const content = r && r.content ? r.content : (state.ed.tabs[f.path] ? state.ed.tabs[f.path].content : '');
    if (!content) continue;
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      const i = line.toLowerCase().indexOf(q.toLowerCase());
      if (i >= 0) results.push({ path: f.path, line: idx, ch: i, text: line, file: f.name });
    });
  }
  state.ed.searchResults = results;
  if (stat) stat.textContent = `找到 ${results.length} 处`;
  renderEditorDetail();
}

function edFlattenFiles(node, arr = []) {
  if (!node) return arr;
  if (node.type === 'file') { arr.push(node); return arr; }
  if (node.children) node.children.forEach((c) => edFlattenFiles(c, arr));
  return arr;
}

function edRenderSearchResults() {
  return state.ed.searchResults.map((r) => {
    const snippet = esc(r.text).replace(new RegExp(esc(state.ed.searchQuery), 'gi'), (m) => `<mark>${esc(m)}</mark>`);
    return `<div class="ed-sr-item" data-path="${esc(r.path)}" data-line="${r.line}" data-ch="${r.ch}">
      <div class="ed-sr-file"><span class="f">${esc(r.file)}</span><span class="ln">:${r.line + 1}</span></div>
      <div class="ed-sr-snippet">${snippet}</div>
    </div>`;
  }).join('');
}

function edBindSearchResults() {
  document.querySelectorAll('.ed-sr-item').forEach((item) => {
    item.onclick = () => {
      const path = item.dataset.path;
      const line = parseInt(item.dataset.line, 10);
      const ch = parseInt(item.dataset.ch, 10);
      edLoadFile(path);
      setTimeout(() => {
        const cm = edActiveCM();
        if (cm) { cm.setCursor({ line, ch }); cm.focus(); }
      }, 50);
    };
  });
}

/* ---------------------------------------------------------- 主题面板 */

function edThemePanelHTML() {
  const t = state.ed.theme;
  return `
    <h4>主题与背景</h4>
    <div class="ed-presets">
      ${Object.entries(ED_PRESETS).map(([k, v]) => `<div class="ed-preset ${t.preset === k ? 'active' : ''}" data-preset="${k}" style="background:${v.bg};color:${v.accent};border-color:${v.accent}">${k === 'dark' ? '暗色' : k === 'midnight' ? '午夜' : k === 'light' ? '亮色' : '护眼绿'}</div>`).join('')}
    </div>
    <div class="ed-swatch"><label>背景</label><input type="color" id="edColorBg" value="${t.bg}"></div>
    <div class="ed-swatch"><label>侧栏</label><input type="color" id="edColorSidebar" value="${t.sidebar}"></div>
    <div class="ed-swatch"><label>顶栏</label><input type="color" id="edColorBar" value="${t.bar}"></div>
    <div class="ed-swatch"><label>强调色</label><input type="color" id="edColorAccent" value="${t.accent}"></div>
    <div class="ed-swatch"><label>代码背景</label><input type="color" id="edColorCodeBg" value="${t.codeBg}"></div>
    <div class="ed-swatch"><label>代码文字</label><input type="color" id="edColorCodeTxt" value="${t.codeTxt}"></div>
    <div class="ed-row2"><label>背景图 URL</label><input type="text" id="edBgImage" value="${esc(t.bgImage)}" placeholder="https://example.com/bg.jpg 或留空"></div>
    <div class="ed-row2"><label>背景不透明度</label><input type="range" id="edBgOpacity" min="0" max="1" step="0.05" value="${t.bgOpacity}"></div>
    <div class="ed-theme-actions"><button class="tb" id="edThemeReset">重置默认</button><button class="tb primary" id="edThemeClose">完成</button></div>
  `;
}

function edBindThemePanel(panel) {
  panel.querySelectorAll('.ed-preset').forEach((p) => {
    p.onclick = () => {
      const preset = p.dataset.preset;
      const v = ED_PRESETS[preset];
      state.ed.theme = { ...state.ed.theme, preset, ...v };
      edApplyTheme();
      renderEditorDetail();
    };
  });
  const bindColor = (id, key) => {
    const input = panel.querySelector('#' + id);
    if (!input) return;
    input.oninput = () => {
      state.ed.theme[key] = input.value;
      state.ed.theme.preset = 'custom';
      edApplyTheme();
    };
  };
  bindColor('edColorBg', 'bg');
  bindColor('edColorSidebar', 'sidebar');
  bindColor('edColorBar', 'bar');
  bindColor('edColorAccent', 'accent');
  bindColor('edColorCodeBg', 'codeBg');
  bindColor('edColorCodeTxt', 'codeTxt');
  const bgImg = panel.querySelector('#edBgImage');
  if (bgImg) bgImg.oninput = () => { state.ed.theme.bgImage = bgImg.value; edApplyTheme(); };
  const bgOp = panel.querySelector('#edBgOpacity');
  if (bgOp) bgOp.oninput = () => { state.ed.theme.bgOpacity = parseFloat(bgOp.value); edApplyTheme(); };
  const reset = panel.querySelector('#edThemeReset');
  if (reset) reset.onclick = () => { state.ed.theme = { ...ED_DEFAULT_THEME }; edApplyTheme(); renderEditorDetail(); };
  const close = panel.querySelector('#edThemeClose');
  if (close) close.onclick = () => { state.ed.themeOpen = false; renderEditorDetail(); };
}

/* ---------------------------------------------------------- 状态栏 */

function edUpdateStatus() {
  const cm = edActiveCM();
  const path = edActivePath();
  const tab = path ? state.ed.tabs[path] : null;
  const pos = cm ? cm.getCursor() : { line: 0, ch: 0 };
  const words = tab ? (tab.content.match(/\S+/g) || []).length : 0;
  const dirty = tab && tab.dirty;
  const info = {
    path: path ? edRelPath(path) : '无文件',
    pos: state.ed.visual ? (dirty ? '编辑中' : '已就绪') : `Ln ${pos.line + 1}, Col ${pos.ch + 1}`,
    words: `${words} 词`,
    save: dirty ? '● 未保存' : '已保存',
  };
  const st = $('#edStatus');
  if (st) st.textContent = `${info.path}  ·  ${info.pos}  ·  ${info.words}  ·  ${info.save}`;
}

// 初始化主题
edInitTheme();
