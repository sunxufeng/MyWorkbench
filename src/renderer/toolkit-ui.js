'use strict';
/* ==========================================================================
   Toolkit（工具包）—— 八个参考子模块渲染层
   依赖 app.js 全局：el / esc / toast / act / API / state / openUrl / relTime /
   renderDetailBar / confirmDialog / openModal / mkTb
   二级导航放在列表栏（8 个图标），详情栏渲染选中子模块的自包含界面。
   ========================================================================== */

if (!state.tk) {
  state.tk = {
    sub: 'password', // password|docker|tasks|disk|launcher|window|screenshot
    vaultUnlocked: false,
    vaultItems: [],
    tasks: [],
    cmds: [],
    disk: null,
    docker: null,
    dockerAvail: null,
    shots: [],
    loading: false,
    q: '',
    _seq: 0,
  };
}

const TK_SUBS = [
  { id: 'password', icon: '🔐', label: '密码管理' },
  { id: 'docker', icon: '🐳', label: 'Docker' },
  { id: 'tasks', icon: '✅', label: '任务' },
  { id: 'disk', icon: '💽', label: '磁盘' },
  { id: 'launcher', icon: '⚡', label: '启动器' },
  { id: 'window', icon: '🪟', label: '窗口分屏' },
  { id: 'screenshot', icon: '📸', label: '截屏录屏' },
];

/* ---------------------------------------------------------- 入口 */

function renderToolkitList() {
  const list = document.getElementById('listScroll');
  if (!list) return;
  list.innerHTML = '';
  const head = el('div', 'tk-subhead', '工具包 · Toolkit');
  list.appendChild(head);
  TK_SUBS.forEach((s) => {
    const item = el('div', 'tk-sub' + (state.tk.sub === s.id ? ' sel' : ''));
    item.appendChild(el('span', 'tk-sub-icon', s.icon));
    item.appendChild(el('span', 'tk-sub-label', s.label));
    item.onclick = () => { state.tk.sub = s.id; renderToolkitList(); renderToolkitDetail(); };
    list.appendChild(item);
  });
  const tip = el('div', 'tk-sub-tip', '八个本地生产力工具，统一集成于工具包内。');
  list.appendChild(tip);
}

function renderToolkitDetail() {
  const detail = document.getElementById('detailScroll');
  if (!detail) return;
  detail.innerHTML = '';
  detail.classList.remove('ed-mode');
  const map = {
    password: tkPassword, docker: tkDocker, tasks: tkTasks,
    disk: tkDisk, launcher: tkLauncher, window: tkWindow, screenshot: tkScreenshot,
  };
  const fn = map[state.tk.sub] || tkPassword;
  fn(detail);
}

function tkBar(detail, title) {
  const bar = el('div', 'tk-bar');
  bar.appendChild(el('h2', 'tk-title', title));
  const sp = el('span'); sp.className = 'spacer'; bar.appendChild(sp);
  detail.appendChild(bar);
  return bar;
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

/* ========================================================== 1. 密码管理 */

async function tkPassword(detail) {
  tkBar(detail, '🔐 密码管理');
  // 首次创建
  if (!(await act(API.toolkit.vaultExists())).exists) {
    return tkVaultSetup(detail, true);
  }
  if (!state.tk.vaultUnlocked) return tkVaultSetup(detail, false);

  const wrap = el('div', 'tk-pw');
  const tools = el('div', 'tk-pw-tools');
  const addBtn = el('button', 'tb primary', '＋ 新增条目');
  addBtn.onclick = () => tkVaultEdit(detail, null);
  const genBtn = el('button', 'tb', '🎲 生成密码');
  genBtn.onclick = () => tkVaultGenerate(detail);
  const lockBtn = el('button', 'tb', '🔒 锁定');
  lockBtn.onclick = async () => { await act(API.toolkit.vaultLock()); state.tk.vaultUnlocked = false; renderToolkitDetail(); };
  tools.append(addBtn, genBtn, lockBtn);
  wrap.appendChild(tools);

  const search = el('input', 'tk-input');
  search.placeholder = '检索标题 / 账号 / 网址…';
  search.oninput = () => { state.tk.q = search.value; tkRenderVaultList(listBox); };
  wrap.appendChild(search);

  const listBox = el('div', 'tk-pw-list');
  wrap.appendChild(listBox);
  detail.appendChild(wrap);
  if (!state.tk.vaultItems.length) state.tk.vaultItems = ((await act(await act(API.toolkit.vaultList()))) || {}).items || [];
  tkRenderVaultList(listBox);
}

function tkRenderVaultList(listBox) {
  const q = (state.tk.q || '').trim().toLowerCase();
  const items = (state.tk.vaultItems || []).filter((i) =>
    !q || (i.title + ' ' + i.username + ' ' + i.url).toLowerCase().includes(q));
  listBox.innerHTML = '';
  if (!items.length) { listBox.appendChild(el('div', 'tk-empty', '还没有密码条目，点「新增条目」开始。')); return; }
  items.forEach((i2) => {
    const card = el('div', 'tk-pw-card');
    const main2 = el('div', 'tk-pw-main', null);
    main2.appendChild(el('div', 'tk-pw-title', i2.title || '(无标题)'));
    if (i2.username) main2.appendChild(el('div', 'tk-pw-meta', '👤 ' + i2.username));
    if (i2.url) main2.appendChild(el('div', 'tk-pw-meta', '🔗 ' + i2.url));
    card.appendChild(main2);
    const acts = el('div', 'tk-pw-acts');
    const reveal = el('button', 'tb', '👁');
    reveal.title = '显示密码';
    reveal.onclick = async () => {
      const full = await act(API.toolkit.vaultGet(i2.id));
      if (full) toast('密码：' + (full.password || '(空)'), 'ok', 6000);
    };
    const copy = el('button', 'tb', '⧉');
    copy.title = '复制密码';
    copy.onclick = async () => {
      const full = await act(API.toolkit.vaultGet(i2.id));
      if (full && full.password) { await act(API.copyText(full.password)); toast('已复制密码', 'ok'); }
    };
    const edit = el('button', 'tb', '✎');
    edit.onclick = () => tkVaultEdit(document.getElementById('detailScroll'), i2.id);
    const del = el('button', 'tb danger', '🗑');
    del.onclick = async () => {
      await act(API.toolkit.vaultDelete(i2.id));
      state.tk.vaultItems = ((await act(await act(API.toolkit.vaultList()))) || {}).items || [];
      tkRenderVaultList(listBox);
    };
    acts.append(reveal, copy, edit, del);
    card.appendChild(acts);
    listBox.appendChild(card);
  });
}

async function tkVaultSetup(detail, isNew) {
  const wrap = el('div', 'tk-pw-setup');
  wrap.appendChild(el('div', 'tk-pw-setup-title', isNew ? '首次使用：设置主密码' : '解锁密码库'));
  wrap.appendChild(el('p', 'tk-pw-setup-tip', '主密码用于加密本地密码库（AES-256-GCM）。忘记无法找回，请牢记。'));
  const pw = el('input', 'tk-input'); pw.type = 'password'; pw.placeholder = '主密码';
  const pw2 = el('input', 'tk-input'); pw2.type = 'password'; pw2.placeholder = '确认主密码';
  if (!isNew) pw2.style.display = 'none';
  const err = el('div', 'tk-err');
  const btn = el('button', 'tb primary', isNew ? '创建密码库' : '解锁');
  btn.onclick = async () => {
    if (isNew && pw.value !== pw2.value) { err.textContent = '两次输入不一致'; return; }
    if (pw.value.length < 6) { err.textContent = '主密码至少 6 位'; return; }
    const r = isNew ? await act(API.toolkit.vaultCreate(pw.value)) : await act(API.toolkit.vaultUnlock(pw.value));
    if (!r || !r.ok) { err.textContent = (r && r.error) || '失败'; return; }
    state.tk.vaultUnlocked = true;
    renderToolkitDetail();
  };
  wrap.append(pw, pw2, err, btn);
  detail.appendChild(wrap);
}

async function tkVaultEdit(detail, id) {
  const existing = id ? (await act(API.toolkit.vaultGet(id))) : null;
  const body = el('div', 'tk-form');
  const fields = [['title', '标题'], ['username', '账号'], ['url', '网址'], ['password', '密码'], ['notes', '备注']];
  const inputs = {};
  fields.forEach(([k, lab]) => {
    const lab2 = el('label', 'tk-fld-label', lab);
    const inp = el(k === 'notes' ? 'textarea' : 'input', 'tk-input');
    if (k === 'password') inp.type = 'password';
    if (k === 'notes') inp.rows = 3;
    inp.value = (existing && existing[k]) || '';
    inputs[k] = inp;
    body.append(lab2, inp);
  });
  const gen = el('button', 'tb', '🎲 生成强密码');
  gen.onclick = async () => { const g = await act(API.toolkit.vaultGen({ length: 20 })); if (g) inputs.password.value = g.password; };
  body.appendChild(gen);

  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px;margin-top:8px';
  const sp = el('span'); sp.style.flex = '1';
  const save = el('button', 'tb primary', '保存');
  save.onclick = async () => {
    const rec = {}; fields.forEach(([k]) => rec[k] = inputs[k].value);
    if (id) await act(API.toolkit.vaultUpdate(id, rec));
    else await act(API.toolkit.vaultAdd(rec));
    state.tk.vaultItems = ((await act(await act(API.toolkit.vaultList()))) || {}).items || [];
    doClose(); tkPassword(detail);
  };
  foot.append(sp, save);
  body.appendChild(foot);
  const { close: c } = openModal({ title: id ? '编辑密码条目' : '新增密码条目', body, wide: false });
  var doClose = c;
}

async function tkVaultGenerate(detail) {
  const g = await act(API.toolkit.vaultGen({ length: 20 }));
  const body = el('div', 'tk-form');
  const inp = el('input', 'tk-input'); inp.value = g.password; body.appendChild(inp);
  const copy = el('button', 'tb primary', '复制');
  copy.onclick = async () => { await act(API.copyText(g.password)); toast('已复制', 'ok'); };
  const regen = el('button', 'tb', '🎲 换一个');
  regen.onclick = async () => { const g2 = await act(API.toolkit.vaultGen({ length: 20 })); inp.value = g2.password; };
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px;margin-top:8px';
  const sp = el('span'); sp.style.flex = '1';
  foot.append(sp, regen, copy);
  body.appendChild(foot);
  openModal({ title: '密码生成器', body });
}

/* ========================================================== 3. Docker */

async function tkDocker(detail) {
  tkBar(detail, '🐳 本地 Docker 管理');
  const wrap = el('div', 'tk-docker');
  if (state.tk.dockerAvail == null) state.tk.dockerAvail = await act(API.toolkit.dockerAvailable());
  if (!state.tk.dockerAvail || !state.tk.dockerAvail.ok) {
    wrap.appendChild(el('div', 'tk-empty', '未检测到 Docker（docker CLI）。请在本地安装并启动 Docker 后再使用此模块。\n' + (state.tk.dockerAvail?.error || '')));
    detail.appendChild(wrap); return;
  }
  const refresh = el('button', 'tb primary', '刷新');
  refresh.onclick = async () => { state.tk.docker = null; await tkDockerLoad(wrap); };
  const sp = el('span'); sp.className = 'spacer';
  const bar2 = el('div', 'tk-docker-bar'); bar2.append(refresh, sp, el('span', 'tk-docker-hint', '容器与镜像的本地可视化管理'));
  wrap.appendChild(bar2);
  const box = el('div', 'tk-docker-box'); wrap.appendChild(box);
  detail.appendChild(wrap);
  await tkDockerLoad(box);
}

async function tkDockerLoad(box) {
  box.innerHTML = el('div', 'tk-empty', '加载中…');
  try {
    const [cResp, iResp] = await Promise.all([act(API.toolkit.dockerContainers()), act(API.toolkit.dockerImages())]);
  const containers = (cResp && cResp.items) || [];
  const images = (iResp && iResp.items) || [];
    box.innerHTML = '';
    box.appendChild(el('h4', null, '容器（' + containers.length + '）'));
    const ctab = el('div', 'tk-table');
    containers.forEach((c) => {
      const row = el('div', 'tk-row');
      row.appendChild(el('span', 'tk-c-name', c.Names || c.ID));
      row.appendChild(el('span', 'tk-c-state ' + (c.State === 'running' ? 'run' : 'stop'), c.State || ''));
      row.appendChild(el('span', 'tk-c-img', c.Image || ''));
      const acts = el('div', 'tk-pw-acts');
      if (c.State === 'running') {
        acts.appendChild(tkDockerBtn('停止', async () => { await act(API.toolkit.dockerAction('container', 'stop', c.ID)); await tkDockerLoad(box); }));
        acts.appendChild(tkDockerBtn('重启', async () => { await act(API.toolkit.dockerAction('container', 'restart', c.ID)); await tkDockerLoad(box); }));
      } else {
        acts.appendChild(tkDockerBtn('启动', async () => { await act(API.toolkit.dockerAction('container', 'start', c.ID)); await tkDockerLoad(box); }));
      }
      acts.appendChild(tkDockerBtn('删除', async () => { await act(API.toolkit.dockerAction('container', 'remove', c.ID)); await tkDockerLoad(box); }, true));
      row.appendChild(acts);
      ctab.appendChild(row);
    });
    box.appendChild(ctab);
    box.appendChild(el('h4', null, '镜像（' + images.length + '）'));
    const itab = el('div', 'tk-table');
    images.forEach((img) => {
      const row = el('div', 'tk-row');
      row.appendChild(el('span', 'tk-c-name', img.Repository + ':' + img.Tag));
      row.appendChild(el('span', 'tk-c-size', img.Size || ''));
      const acts = el('div', 'tk-pw-acts');
      acts.appendChild(tkDockerBtn('删除', async () => { await act(API.toolkit.dockerAction('image', 'remove-image', img.ID)); await tkDockerLoad(box); }, true));
      row.appendChild(acts);
      itab.appendChild(row);
    });
    box.appendChild(itab);
  } catch (e) {
    box.innerHTML = ''; box.appendChild(el('div', 'tk-err', 'Docker 调用失败：' + (e && e.message ? e.message : e)));
  }
}

function tkDockerBtn(label, fn, danger) {
  const b = el('button', 'tb' + (danger ? ' danger' : ''), label);
  b.onclick = fn;
  return b;
}

/* ========================================================== 4. 任务管理 */

async function tkTasks(detail) {
  tkBar(detail, '✅ 任务（看板）');
  const wrap = el('div', 'tk-tasks');
  const addBtn = el('button', 'tb primary', '＋ 新增任务');
  addBtn.onclick = () => tkTaskEdit(detail, null);
  const sp = el('span'); sp.className = 'spacer';
  const bar2 = el('div', 'tk-bar'); bar2.append(addBtn, sp);
  wrap.appendChild(bar2);
  const board = el('div', 'tk-board');
  wrap.appendChild(board);
  detail.appendChild(wrap);
  state.tk.tasks = ((await act(await act(API.toolkit.tasksList()))) || {}).items || [];
  tkRenderBoard(board);
}

const TK_STATUSES = [
  { id: 'backlog', label: '待办池', color: 'var(--ink-3)' },
  { id: 'todo', label: '待做', color: 'var(--moss)' },
  { id: 'doing', label: '进行中', color: 'var(--gold)' },
  { id: 'done', label: '完成', color: 'var(--moss-deep)' },
];

function tkRenderBoard(board) {
  board.innerHTML = '';
  TK_STATUSES.forEach((st) => {
    const col = el('div', 'tk-col');
    col.appendChild(el('div', 'tk-col-h', st.label + ' · ' + state.tk.tasks.filter((t) => t.status === st.id).length));
    const items = state.tk.tasks.filter((t) => t.status === st.id).sort((a, b) => (a.order || 0) - (b.order || 0));
    items.forEach((t) => {
      const card = el('div', 'tk-task-card');
      card.appendChild(el('div', 'tk-task-title', t.title || '(无标题)'));
      if (t.project) card.appendChild(el('div', 'tk-task-meta', '📁 ' + t.project));
      if (t.priority && t.priority !== 'none') card.appendChild(el('div', 'tk-task-meta', '⚑ ' + t.priority));
      const acts = el('div', 'tk-task-acts');
      const next = TK_STATUSES[TK_STATUSES.findIndex((x) => x.id === t.status) + 1];
      if (next) {
        const mv = el('button', 'tb', '→ ' + next.label);
        mv.onclick = async () => { await act(API.toolkit.taskUpdate(t.id, { status: next.id })); state.tk.tasks = ((await act(await act(API.toolkit.tasksList()))) || {}).items || []; tkRenderBoard(board); };
        acts.appendChild(mv);
      }
      const ed = el('button', 'tb', '✎'); ed.onclick = () => tkTaskEdit(document.getElementById('detailScroll'), t.id);
      const dl = el('button', 'tb danger', '🗑'); dl.onclick = async () => { await act(API.toolkit.taskDelete(t.id)); state.tk.tasks = ((await act(await act(API.toolkit.tasksList()))) || {}).items || []; tkRenderBoard(board); };
      acts.append(ed, dl);
      card.appendChild(acts);
      col.appendChild(card);
    });
    board.appendChild(col);
  });
}

async function tkTaskEdit(detail, id) {
  const existing = id ? state.tk.tasks.find((t) => t.id === id) : null;
  const body = el('div', 'tk-form');
  const title = el('input', 'tk-input'); title.placeholder = '任务标题'; title.value = existing ? existing.title : '';
  const project = el('input', 'tk-input'); project.placeholder = '项目 / 分组'; project.value = existing ? (existing.project || '') : '';
  const notes = el('textarea', 'tk-input'); notes.rows = 3; notes.placeholder = '备注'; notes.value = existing ? (existing.notes || '') : '';
  const statusSel = el('select', 'tk-input'); TK_STATUSES.forEach((s) => { const o = el('option'); o.value = s.id; o.textContent = s.label; if (existing && existing.status === s.id) o.selected = true; statusSel.appendChild(o); });
  const prioSel = el('select', 'tk-input'); [['none', '无'], ['low', '低'], ['medium', '中'], ['high', '高']].forEach(([v, l]) => { const o = el('option'); o.value = v; o.textContent = l; if (existing && existing.priority === v) o.selected = true; prioSel.appendChild(o); });
  body.append(el('label', 'tk-fld-label', '标题'), title, el('label', 'tk-fld-label', '项目'), project, el('label', 'tk-fld-label', '状态'), statusSel, el('label', 'tk-fld-label', '优先级'), prioSel, el('label', 'tk-fld-label', '备注'), notes);
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px;margin-top:8px';
  const sp = el('span'); sp.style.flex = '1';
  const save = el('button', 'tb primary', '保存');
  save.onclick = async () => {
    const patch = { title: title.value, project: project.value, status: statusSel.value, priority: prioSel.value, notes: notes.value };
    if (id) await act(API.toolkit.taskUpdate(id, patch));
    else await act(API.toolkit.taskAdd(patch));
    state.tk.tasks = ((await act(await act(API.toolkit.tasksList()))) || {}).items || [];
    doClose(); tkTasks(detail);
  };
  foot.append(sp, save); body.appendChild(foot);
  const { close: c } = openModal({ title: id ? '编辑任务' : '新增任务', body });
  var doClose = c;
}

/* ========================================================== 5. 磁盘管理 */

async function tkDisk(detail) {
  tkBar(detail, '💽 磁盘空间');
  const homeR = await act(API.toolkit.home());
  const home = (homeR && homeR.home) || '';
  const wrap = el('div', 'tk-disk');
  const pathInp = el('input', 'tk-input');
  pathInp.placeholder = '输入要扫描的路径（如 ' + home + '）';
  pathInp.value = state.tk.disk ? state.tk.disk.root : home;
  const scan = el('button', 'tb primary', '扫描');
  scan.onclick = async () => {
    wrap.querySelector('.tk-disk-result').innerHTML = '扫描中…（大目录可能较慢）';
    state.tk.disk = await act(API.toolkit.diskScan(pathInp.value || home, 3));
    tkRenderDisk(detail);
  };
  const bar2 = el('div', 'tk-disk-bar'); bar2.append(pathInp, scan);
  wrap.appendChild(bar2);
  const result = el('div', 'tk-disk-result'); wrap.appendChild(result);
  detail.appendChild(wrap);
  if (state.tk.disk) tkRenderDisk(detail);
  else result.appendChild(el('div', 'tk-empty', '输入路径，点「扫描」查看磁盘占用（默认扫描你的主目录，深度 3 层，大目录可能稍慢）。'));
}

function tkRenderDisk(detail) {
  const d = state.tk.disk;
  const result = detail.querySelector('.tk-disk-result');
  if (!result) return;
  result.innerHTML = '';
  result.appendChild(el('div', 'tk-disk-total', '总占用：' + fmtSize(d.total) + ' · 深度 ' + d.depth + ' 层'));
  const max = Math.max(1, ...d.entries.map((e) => e.size));
  d.entries.forEach((e) => {
    const row = el('div', 'tk-disk-row');
    const bar2 = el('div', 'tk-disk-bar-graph'); bar2.style.width = (e.size / max * 100) + '%';
    const info = el('div', 'tk-disk-info');
    info.appendChild(el('span', 'tk-disk-name', (e.type === 'dir' ? '📁 ' : '📄 ') + e.name));
    info.appendChild(el('span', 'tk-disk-size', fmtSize(e.size)));
    const clean = el('button', 'tb danger', '清理');
    clean.title = '移入废纸篓';
    clean.onclick = async () => { const r = await act(API.toolkit.diskClean(e.path)); if (r && r.ok) { toast('已移入废纸篓：' + e.name, 'ok'); state.tk.disk = await act(API.toolkit.diskScan(d.root, 3)); tkRenderDisk(detail); } };
    info.appendChild(clean);
    row.append(bar2, info);
    result.appendChild(row);
  });
}

/* ========================================================== 6. 启动器 */

async function tkLauncher(detail) {
  tkBar(detail, '⚡ 启动器');
  const wrap = el('div', 'tk-launcher');
  const search = el('input', 'tk-input'); search.placeholder = '搜索命令，或回车快速执行首个匹配…';
  const runFirst = async () => { const r = await act(API.toolkit.cmdsSearch(search.value)); const list = (r && r.items) || []; if (list[0]) { const res = await act(API.toolkit.cmdRun(list[0].id)); toast(res && res.ok ? '已执行：' + list[0].name : '执行失败：' + ((res && res.error) || ''), res && res.ok ? 'ok' : 'err'); } };
  search.onkeydown = (e) => { if (e.key === 'Enter') runFirst(); };
  const addBtn = el('button', 'tb primary', '＋ 新增');
  addBtn.onclick = () => tkCmdEdit(detail, null);
  const sp = el('span'); sp.className = 'spacer';
  const bar2 = el('div', 'tk-bar'); bar2.append(search, addBtn, sp);
  wrap.appendChild(bar2);
  const listBox = el('div', 'tk-launcher-list'); wrap.appendChild(listBox);
  detail.appendChild(wrap);
  state.tk.cmds = ((await act(await act(API.toolkit.cmdsList()))) || {}).items || [];
  tkRenderCmds(listBox, search);
}

function tkRenderCmds(listBox, search) {
  const q = (search ? search.value : '').trim().toLowerCase();
  const cmds = (state.tk.cmds || []).filter((c) => !q || (c.name + ' ' + c.target).toLowerCase().includes(q));
  listBox.innerHTML = '';
  if (!cmds.length) { listBox.appendChild(el('div', 'tk-empty', '还没有命令。新增一个应用 / 网址 / 文件 / Shell 命令。')); return; }
  cmds.forEach((c) => {
    const card = el('div', 'tk-cmd-card');
    card.appendChild(el('span', 'tk-cmd-icon', c.icon || '⚡'));
    const info = el('div', 'tk-cmd-info');
    info.appendChild(el('div', 'tk-cmd-name', c.name || '(无名称)'));
    info.appendChild(el('div', 'tk-cmd-target', c.type + ' · ' + c.target));
    card.appendChild(info);
    const run = el('button', 'tb primary', '▶ 执行');
    run.onclick = async () => { const r = await act(API.toolkit.cmdRun(c.id)); toast(r && r.ok ? '已执行' : '失败：' + ((r && r.error) || ''), r && r.ok ? 'ok' : 'err'); };
    const ed = el('button', 'tb', '✎'); ed.onclick = () => tkCmdEdit(document.getElementById('detailScroll'), c.id);
    const dl = el('button', 'tb danger', '🗑'); dl.onclick = async () => { await act(API.toolkit.cmdDelete(c.id)); state.tk.cmds = ((await act(await act(API.toolkit.cmdsList()))) || {}).items || []; tkRenderCmds(listBox, search); };
    card.append(run, ed, dl);
    card.onclick = async (e) => { if (e.target.tagName !== 'BUTTON') { const r = await act(API.toolkit.cmdRun(c.id)); toast(r && r.ok ? '已执行' : '失败', r && r.ok ? 'ok' : 'err'); } };
    listBox.appendChild(card);
  });
}

async function tkCmdEdit(detail, id) {
  const existing = id ? state.tk.cmds.find((c) => c.id === id) : null;
  const body = el('div', 'tk-form');
  const name = el('input', 'tk-input'); name.placeholder = '名称'; name.value = existing ? existing.name : '';
  const typeSel = el('select', 'tk-input'); [['app', '应用'], ['url', '网址'], ['file', '文件'], ['shell', 'Shell 命令']].forEach(([v, l]) => { const o = el('option'); o.value = v; o.textContent = l; if (existing && existing.type === v) o.selected = true; typeSel.appendChild(o); });
  const target = el('input', 'tk-input'); target.placeholder = '目标（应用名 / 网址 / 路径 / 命令）'; target.value = existing ? existing.target : '';
  const icon = el('input', 'tk-input'); icon.placeholder = '图标 emoji'; icon.value = existing ? (existing.icon || '⚡') : '⚡';
  body.append(el('label', 'tk-fld-label', '名称'), name, el('label', 'tk-fld-label', '类型'), typeSel, el('label', 'tk-fld-label', '目标'), target, el('label', 'tk-fld-label', '图标'), icon);
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px;margin-top:8px';
  const sp = el('span'); sp.style.flex = '1';
  const save = el('button', 'tb primary', '保存');
  save.onclick = async () => {
    const patch = { name: name.value, type: typeSel.value, target: target.value, icon: icon.value };
    if (id) await act(API.toolkit.cmdUpdate(id, patch)); else await act(API.toolkit.cmdAdd(patch));
    state.tk.cmds = ((await act(await act(API.toolkit.cmdsList()))) || {}).items || []; doClose(); tkLauncher(detail);
  };
  foot.append(sp, save); body.appendChild(foot);
  const { close: c } = openModal({ title: id ? '编辑命令' : '新增命令', body });
  var doClose = c;
}

/* ========================================================== 7. 窗口分屏 */

async function tkWindow(detail) {
  tkBar(detail, '🪟 窗口分屏');
  const wrap = el('div', 'tk-window');
  wrap.appendChild(el('p', 'tk-pw-setup-tip', '选中/聚焦某个窗口后，点击下方布局把它摆放到屏幕对应位置（需要系统「辅助功能」权限，首次会弹窗请求）。'));
  const grid = el('div', 'tk-window-grid');
  const layouts = [
    ['left', '← 左半'], ['right', '右半 →'], ['top', '↑ 上半'], ['bottom', '下半 ↓'],
    ['tl', '↖ 左上'], ['tr', '右上 ↗'], ['bl', '左下 ↙'], ['br', '右下 ↘'],
    ['center', '⊡ 居中'], ['max', '⛶ 全屏'],
  ];
  layouts.forEach(([id, label]) => {
    const b = el('button', 'tb tk-window-btn', label);
    b.onclick = async () => {
      const r = await act(API.toolkit.windowLayout(id));
      if (r && r.needAccessibility) toast('请到系统设置→隐私与安全性→辅助功能，给 Workbench 授权', 'err', 6000);
      else toast(r && r.ok ? '已应用布局' : '失败：' + ((r && r.error) || ''), r && r.ok ? 'ok' : 'err');
    };
    grid.appendChild(b);
  });
  wrap.appendChild(grid);
  detail.appendChild(wrap);
}

/* ========================================================== 8. 截屏录屏 */

async function tkScreenshot(detail) {
  tkBar(detail, '📸 截屏');
  const wrap = el('div', 'tk-shot');
  wrap.appendChild(el('p', 'tk-pw-setup-tip', '点击「区域截屏」后，用系统选区工具框选要截取的区域（需要系统「屏幕录制」权限，首次会弹窗请求）。'));
  const cap = el('button', 'tb primary', '📸 区域截屏');
  cap.onclick = async () => {
    const r = await act(API.toolkit.screenshot({}));
    if (r && r.needScreenRecording) toast('请到系统设置→隐私与安全性→屏幕录制，给 Workbench 授权', 'err', 6000);
    else if (r && r.ok) { toast('已保存截图', 'ok'); state.tk.shots = ((await act(await act(API.toolkit.shotsList()))) || {}).items || []; tkRenderShots(listBox); }
    else toast('截屏取消或失败：' + ((r && r.error) || ''), 'err');
  };
  const sp = el('span'); sp.className = 'spacer';
  const bar2 = el('div', 'tk-bar'); bar2.append(cap, sp);
  wrap.appendChild(bar2);
  const listBox = el('div', 'tk-shot-list'); wrap.appendChild(listBox);
  detail.appendChild(wrap);
  state.tk.shots = ((await act(API.toolkit.shotsList())) || {}).items || [];
  tkRenderShots(listBox);
}

function tkRenderShots(listBox) {
  listBox.innerHTML = '';
  if (!state.tk.shots.length) { listBox.appendChild(el('div', 'tk-empty', '还没有截图。')); return; }
  state.tk.shots.forEach((s) => {
    const card = el('div', 'tk-shot-card');
    const img = el('img', 'tk-shot-img'); img.src = 'file://' + s.path; card.appendChild(img);
    card.appendChild(el('div', 'tk-shot-name', s.name));
    const openB = el('button', 'tb', '打开');
    openB.onclick = () => openUrl('file://' + s.path);
    card.appendChild(openB);
    listBox.appendChild(card);
  });
}
