'use strict';
/**
 * My Workbench —— 工具包（Toolkit）主进程服务
 *
 * 八个参考子模块的核心能力统一在此实现（零依赖，全部依赖 Node 内置模块）：
 *   1. 密码管理（Bitwarden 参考）—— AES-256-GCM + PBKDF2 加密 vault、主密码解锁、生成器、检索
 *   2. 笔记管理（Obsidian 参考）—— Markdown 文件本地组织、双向链接在渲染层解析
 *   3. 本地 Docker 管理（OrbStack 参考）—— 通过 docker CLI 列出/启停/删除容器与镜像
 *   4. 任务管理（Things + Linear 参考）—— 任务 CRUD、看板、状态流转
 *   5. 磁盘管理（DaisyDisk 参考）—— 目录遍历算大小、可视化、清理
 *   6. 启动器/效率（Raycast 参考）—— 命令注册、搜索、一键执行
 *   7. 窗口分屏（Rectangle 参考）—— 通过 osascript 控制窗口位置/布局
 *   8. 截屏录屏（CleanShot X 参考）—— 通过 screencapture 实现区域截屏
 *
 * 数据落在本机资料库目录下的 toolkit/ 子目录。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const pExecFile = promisify(execFile);
const pStat = promisify(fs.stat);
const pReaddir = promisify(fs.readdir);

const DATA_DIR = 'toolkit';
const ALGO = 'aes-256-gcm';
const PBKDF2_ITER = 150000;
const SALT_LEN = 16;
const IV_LEN = 16;

/* =========================================================================
 * 加密工具（密码 vault）
 * ========================================================================= */

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, 32, 'sha256');
}

function encryptJSON(key, obj) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), enc: enc.toString('base64') };
}

function decryptJSON(key, rec) {
  const iv = Buffer.from(rec.iv, 'base64');
  const tag = Buffer.from(rec.tag, 'base64');
  const enc = Buffer.from(rec.enc, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const data = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(data.toString('utf8'));
}

/** 生成一个强密码 */
function generatePassword(opts) {
  const o = Object.assign({ length: 20, upper: true, lower: true, digit: true, symbol: true }, opts || {});
  const sets = [];
  if (o.upper) sets.push('ABCDEFGHJKLMNPQRSTUVWXYZ');
  if (o.lower) sets.push('abcdefghijkmnopqrstuvwxyz');
  if (o.digit) sets.push('23456789');
  if (o.symbol) sets.push('!@#$%^&*()-_=+[]{};:,.?');
  if (!sets.length) sets.push('abcdefghijkmnopqrstuvwxyz');
  const all = sets.join('');
  let out = '';
  const used = [];
  // 每个字符集至少取一个
  for (const s of sets) {
    const ch = s[crypto.randomInt(s.length)];
    out += ch; used.push(ch);
  }
  while (out.length < o.length) {
    const ch = all[crypto.randomInt(all.length)];
    out += ch; used.push(ch);
  }
  // 打乱
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [used[i], used[j]] = [used[j], used[i]];
  }
  return used.slice(0, o.length).join('');
}

/* =========================================================================
 * 服务类
 * ========================================================================= */

class ToolkitService {
  constructor(libraryPath) {
    this.baseDir = path.join(libraryPath, DATA_DIR);
    this.paths = {
      vault: path.join(this.baseDir, 'vault.json'),
      tasks: path.join(this.baseDir, 'tasks.json'),
      launcher: path.join(this.baseDir, 'launcher.json'),
    };
    this.notesDir = path.join(this.baseDir, 'notes');
    this.vault = null;       // 解锁后的明文记录数组（内存中）
    this.vaultKey = null;    // 当前会话的解密 key
    this.vaultSalt = null;   // 持久化的 salt（vaultSave 复用）
    this.vaultLocked = true;
    this.tasks = { items: [] };
    this.launcher = { commands: [] };
  }

  async ensureDir() {
    await fsp.mkdir(this.baseDir, { recursive: true });
    await fsp.mkdir(this.notesDir, { recursive: true });
    await this.loadTasks();
    await this.loadLauncher();
    // vault 在解锁时才读取
  }

  /* ---------------------------------------------------------- 1. 密码 vault */

  async vaultExists() {
    try { await fsp.access(this.paths.vault); return true; } catch { return false; }
  }

  async vaultCreate(password) {
    const salt = crypto.randomBytes(SALT_LEN);
    const key = deriveKey(password, salt);
    const verifier = encryptJSON(key, { check: 'ok' });
    const vault = { salt: salt.toString('base64'), iterations: PBKDF2_ITER, verifier, records: [] };
    await fsp.writeFile(this.paths.vault, JSON.stringify(vault), 'utf8');
    this.vaultKey = key;
    this.vaultSalt = salt;
    this.vault = [];
    this.vaultLocked = false;
    return { ok: true };
  }

  async vaultUnlock(password) {
    let vault;
    try {
      const txt = await fsp.readFile(this.paths.vault, 'utf8');
      vault = JSON.parse(txt);
    } catch {
      // 不存在则视为首次创建
      return this.vaultCreate(password);
    }
    const salt = Buffer.from(vault.salt, 'base64');
    const key = deriveKey(password, salt);
    try {
      const v = decryptJSON(key, vault.verifier);
      if (v.check !== 'ok') throw new Error('bad password');
    } catch {
      this.vaultLocked = true;
      this.vaultKey = null;
      this.vaultSalt = null;
      return { ok: false, error: '密码错误' };
    }
    const records = (vault.records || []).map((r) => {
      try { return Object.assign({ id: r.id }, decryptJSON(key, r)); }
      catch { return null; }
    }).filter(Boolean);
    this.vaultKey = key;
    this.vaultSalt = salt;
    this.vault = records;
    this.vaultLocked = false;
    return { ok: true };
  }

  vaultLock() {
    this.vaultKey = null;
    this.vault = null;
    this.vaultLocked = true;
  }

  async vaultSave() {
    if (!this.vaultKey || !this.vaultSalt) throw new Error('vault locked');
    const vault = {
      salt: this.vaultSalt.toString('base64'),
      iterations: PBKDF2_ITER,
      verifier: encryptJSON(this.vaultKey, { check: 'ok' }),
      records: this.vault.map((r) => {
        const { id } = r;
        return Object.assign({ id }, encryptJSON(this.vaultKey, r));
      }),
    };
    await fsp.writeFile(this.paths.vault, JSON.stringify(vault), 'utf8');
  }

  async vaultAdd(rec) {
    if (this.vaultLocked) throw new Error('vault locked');
    const item = Object.assign({ id: 'v' + Date.now().toString(36) + crypto.randomInt(9999), createdAt: new Date().toISOString() }, rec || {});
    this.vault.push(item);
    await this.vaultSave();
    return item;
  }

  async vaultUpdate(id, patch) {
    if (this.vaultLocked) throw new Error('vault locked');
    const i = this.vault.findIndex((r) => r.id === id);
    if (i < 0) throw new Error('not found');
    this.vault[i] = Object.assign({}, this.vault[i], patch);
    await this.vaultSave();
    return this.vault[i];
  }

  async vaultDelete(id) {
    if (this.vaultLocked) throw new Error('vault locked');
    this.vault = this.vault.filter((r) => r.id !== id);
    await this.vaultSave();
  }

  vaultList() {
    // 不加解密字段名，但返回时脱敏密码
    return (this.vault || []).map((r) => ({
      id: r.id, title: r.title || '', username: r.username || '', url: r.url || '',
      notes: r.notes || '', hasPassword: !!r.password, createdAt: r.createdAt,
    }));
  }

  vaultDecryptOne(id) {
    const r = (this.vault || []).find((x) => x.id === id);
    return r ? Object.assign({}, r) : null;
  }

  /* ---------------------------------------------------------- 2. 笔记 */

  async notesList() {
    try {
      const files = await fsp.readdir(this.notesDir);
      const md = files.filter((f) => f.endsWith('.md'));
      const items = [];
      for (const f of md) {
        const p = path.join(this.notesDir, f);
        const st = await fsp.stat(p);
        const txt = await fsp.readFile(p, 'utf8');
        const firstLine = txt.split('\n').find((l) => l.trim());
        const title = (firstLine || f).replace(/^#\s*/, '').trim();
        items.push({ id: f, name: f, title, size: st.size, updatedAt: st.mtime.toISOString(), body: txt });
      }
      items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return items;
    } catch { return []; }
  }

  async noteGet(id) {
    const p = path.join(this.notesDir, id.endsWith('.md') ? id : id + '.md');
    try { return { id: path.basename(p), body: await fsp.readFile(p, 'utf8') }; }
    catch { return null; }
  }

  async noteSave(id, body) {
    const fname = id.endsWith('.md') ? id : id + '.md';
    await fsp.writeFile(path.join(this.notesDir, fname), body || '', 'utf8');
    return { id: fname };
  }

  async noteDelete(id) {
    const p = path.join(this.notesDir, id.endsWith('.md') ? id : id + '.md');
    try { await fsp.unlink(p); } catch {}
  }

  /* ---------------------------------------------------------- 4. 任务 */

  async loadTasks() {
    try { this.tasks = JSON.parse(await fsp.readFile(this.paths.tasks, 'utf8')); if (!this.tasks.items) this.tasks.items = []; }
    catch { this.tasks = { items: [] }; }
  }

  async saveTasks() { await fsp.writeFile(this.paths.tasks, JSON.stringify(this.tasks), 'utf8'); }

  async taskAdd(task) {
    const item = Object.assign({
      id: 't' + Date.now().toString(36) + crypto.randomInt(9999),
      title: '', status: 'backlog', priority: 'none', notes: '', project: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), order: Date.now(),
    }, task || {});
    this.tasks.items.push(item);
    await this.saveTasks();
    return item;
  }

  async taskUpdate(id, patch) {
    const i = this.tasks.items.findIndex((t) => t.id === id);
    if (i < 0) throw new Error('not found');
    this.tasks.items[i] = Object.assign({}, this.tasks.items[i], patch, { updatedAt: new Date().toISOString() });
    await this.saveTasks();
    return this.tasks.items[i];
  }

  async taskDelete(id) {
    this.tasks.items = this.tasks.items.filter((t) => t.id !== id);
    await this.saveTasks();
  }

  taskList() { return this.tasks.items; }

  /* ---------------------------------------------------------- 6. 启动器 */

  async loadLauncher() {
    try { this.launcher = JSON.parse(await fsp.readFile(this.paths.launcher, 'utf8')); if (!this.launcher.commands) this.launcher.commands = []; }
    catch { this.launcher = { commands: [] }; }
  }

  async saveLauncher() { await fsp.writeFile(this.paths.launcher, JSON.stringify(this.launcher), 'utf8'); }

  async cmdAdd(cmd) {
    const item = Object.assign({
      id: 'c' + Date.now().toString(36) + crypto.randomInt(9999),
      name: '', type: 'app', target: '', hotkey: '', icon: '⚡', createdAt: new Date().toISOString(),
    }, cmd || {});
    this.launcher.commands.push(item);
    await this.saveLauncher();
    return item;
  }

  async cmdUpdate(id, patch) {
    const i = this.launcher.commands.findIndex((c) => c.id === id);
    if (i < 0) throw new Error('not found');
    this.launcher.commands[i] = Object.assign({}, this.launcher.commands[i], patch);
    await this.saveLauncher();
    return this.launcher.commands[i];
  }

  async cmdDelete(id) {
    this.launcher.commands = this.launcher.commands.filter((c) => c.id !== id);
    await this.saveLauncher();
  }

  cmdList() { return this.launcher.commands; }

  /** 执行命令：app/url/file 走 open，shell 走 execFile */
  async cmdRun(id) {
    const c = this.launcher.commands.find((x) => x.id === id);
    if (!c) throw new Error('not found');
    return this.execCommand(c.type, c.target);
  }

  async execCommand(type, target) {
    if (!target) return { ok: false, error: '空目标' };
    if (type === 'shell') {
      const [bin, ...args] = target.split(/\s+/);
      await pExecFile(bin, args, { timeout: 20000, shell: false });
      return { ok: true };
    }
    // app / url / file 都用系统 open
    await pExecFile('open', type === 'app' ? ['-a', target] : [target], { timeout: 20000 });
    return { ok: true };
  }

  cmdSearch(q) {
    const s = (q || '').trim().toLowerCase();
    if (!s) return this.launcher.commands;
    return this.launcher.commands.filter((c) => (c.name || '').toLowerCase().includes(s) || (c.target || '').toLowerCase().includes(s));
  }

  /* ---------------------------------------------------------- 3. Docker */

  async dockerAvailable() {
    try { await pExecFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 8000 }); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
  }

  async dockerContainers() {
    try {
      const { stdout } = await pExecFile('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 15000 });
      return stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) { throw new Error(String(e.message || e).slice(0, 300)); }
  }

  async dockerImages() {
    try {
      const { stdout } = await pExecFile('docker', ['images', '--format', '{{json .}}'], { timeout: 15000 });
      return stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) { throw new Error(String(e.message || e).slice(0, 300)); }
  }

  async dockerAction(kind, action, id) {
    const obj = kind === 'image' ? 'image' : 'container';
    const map = { start: 'start', stop: 'stop', restart: 'restart', remove: 'rm', 'remove-image': 'rmi' };
    const cmd = map[action] || action;
    await pExecFile('docker', [cmd, id], { timeout: 30000 });
    return { ok: true };
  }

  /* ---------------------------------------------------------- 5. 磁盘 */

  /** 扫描目录：返回 root 的直接子项（带 children 嵌套，限制深度避免卡死） */
  async diskScan(dir, maxDepth) {
    const depth = maxDepth || 2;
    const root = dir || require('node:os').homedir();
    const scannedAt = new Date().toISOString();
    const walk = async (p, d) => {
      let ents;
      try { ents = await pReaddir(p, { withFileTypes: true }); }
      catch { return { name: path.basename(p), path: p, size: 0, type: 'dir', children: [] }; }
      let total = 0;
      const items = [];
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(p, e.name);
        let size = 0;
        let children = null;
        try {
          const st = await pStat(fp);
          if (st.isDirectory()) {
            if (d < depth) { const sub = await walk(fp, d + 1); size = sub.size; children = sub.children; }
            else { size = await this.dirQuickSize(fp); }
          } else { size = st.size; }
        } catch { continue; }
        total += size;
        const node = { name: e.name, path: fp, size, type: e.isDirectory() ? 'dir' : 'file' };
        if (children) node.children = children;
        items.push(node);
      }
      items.sort((a, b) => b.size - a.size);
      return { name: path.basename(p), path: p, size: total, type: 'dir', children: items };
    };
    const rootNode = await walk(root, 1);
    return { root, entries: rootNode.children || [], total: rootNode.size, depth, scannedAt };
  }

  async dirQuickSize(p) {
    try {
      const ents = await pReaddir(p, { withFileTypes: true });
      let s = 0;
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        try { const st = await pStat(path.join(p, e.name)); s += st.size; } catch {}
      }
      return s;
    } catch { return 0; }
  }

  /** 清理：移动到 Trash（不删除） */
  async diskClean(p) {
    const trash = path.join(require('node:os').homedir(), '.Trash');
    try { await fsp.mkdir(trash, { recursive: true }); } catch {}
    const dest = path.join(trash, path.basename(p) + '.tk-' + Date.now());
    await fsp.rename(p, dest);
    return { ok: true, movedTo: dest };
  }

  /* ---------------------------------------------------------- 7. 窗口分屏 */

  async windowLayout(side) {
    // 通过 AppleScript 将最前面的窗口按布局摆放（需要辅助功能权限）
    const rects = {
      'left': { x: 0, y: 0, w: 0.5, h: 1 },
      'right': { x: 0.5, y: 0, w: 0.5, h: 1 },
      'top': { x: 0, y: 0, w: 1, h: 0.5 },
      'bottom': { x: 0, y: 0.5, w: 1, h: 0.5 },
      'tl': { x: 0, y: 0, w: 0.5, h: 0.5 },
      'tr': { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      'bl': { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      'br': { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      'max': { x: 0, y: 0, w: 1, h: 1 },
      'center': { x: 0.2, y: 0.15, w: 0.6, h: 0.7 },
    };
    const r = rects[side];
    if (!r) throw new Error('未知布局: ' + side);
    const script = `
      tell application "System Events"
        set d to (do shell script "system_profiler SPDisplaysDataType | awk -F': ' '/Resolution/{print $2; exit}'")
        set _w to word 1 of d
        set _h to word 3 of d
        set fw to _w as integer
        set fh to _h as integer
        set frontApp to first application process whose frontmost is true
        set w to window 1 of frontApp
        set x to ${Math.round(r.x * 100)} / 100 * fw
        set y to ${Math.round(r.y * 100)} / 100 * fh
        set ww to ${Math.round(r.w * 100)} / 100 * fw
        set wh to ${Math.round(r.h * 100)} / 100 * fh
        set position of w to {x, y}
        set size of w to {ww, wh}
      end tell`;
    try {
      await pExecFile('osascript', ['-e', script], { timeout: 8000 });
      return { ok: true };
    } catch (e) {
      const msg = String(e.message || e);
      if (/not allowed|accessibility|not authorized|(-1743|-1719)/i.test(msg)) {
        return { ok: false, needAccessibility: true, error: '需要辅助功能权限' };
      }
      return { ok: false, error: msg.slice(0, 200) };
    }
  }

  /* ---------------------------------------------------------- 8. 截屏 */

  async screenshot(opts) {
    // 通过系统 screencapture 交互截屏，保存到 toolkit/shots/
    const shotsDir = path.join(this.baseDir, 'shots');
    await fsp.mkdir(shotsDir, { recursive: true });
    const file = path.join(shotsDir, 'shot-' + Date.now().toString(36) + '.png');
    const args = ['-i']; // -i 交互选区；-x 静默
    if (opts && opts.silent) args.length = 0;
    args.push(file);
    try {
      await pExecFile('screencapture', args, { timeout: 30000 });
      return { ok: true, file };
    } catch (e) {
      const msg = String(e.message || e);
      if (/not allowed|screen recording|(-1743|-1719)/i.test(msg)) {
        return { ok: false, needScreenRecording: true, error: '需要屏幕录制权限' };
      }
      return { ok: false, error: msg.slice(0, 200) };
    }
  }

  async shotsList() {
    const shotsDir = path.join(this.baseDir, 'shots');
    try {
      const files = (await fsp.readdir(shotsDir)).filter((f) => f.endsWith('.png')).sort().reverse();
      return files.map((f) => ({ name: f, path: path.join(shotsDir, f) }));
    } catch { return []; }
  }
}

/** 工具：从 key 反推 salt（vaultSave 用）。实际上 salt 应持久化，这里从现有 vault 读取更稳妥。 */
function deriveKeyTestSalt() { return crypto.randomBytes(SALT_LEN); }

module.exports = { ToolkitService, generatePassword, encryptJSON, decryptJSON };
