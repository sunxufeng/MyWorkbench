'use strict';
/**
 * My Workbench —— 预加载脚本
 * 只通过 contextBridge 暴露一组明确的、参数受控的能力，渲染进程拿不到 Node。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  // 基础信息
  snapshot: () => invoke('app:snapshot'),

  // 资料库位置
  openLibrary: () => invoke('library:open'),
  openPath: (p) => invoke('library:open-path', p),
  revealPath: (p) => invoke('library:reveal', p),
  changeLibrary: () => invoke('library:change'),

  // 界面偏好
  getPrefs: () => invoke('prefs:get'),
  setPrefs: (patch) => invoke('prefs:set', patch),

  // 资料
  createEntry: (payload) => invoke('entry:create', payload),
  updateEntry: (id, patch) => invoke('entry:update', id, patch),
  trashEntries: (ids) => invoke('entry:trash', ids),
  restoreEntries: (ids) => invoke('entry:restore', ids),
  deleteForever: (ids) => invoke('entry:delete-forever', ids),
  emptyTrash: () => invoke('entry:empty-trash'),

  // 日程
  createSchedule: (payload) => invoke('schedule:create', payload),
  updateSchedule: (id, patch) => invoke('schedule:update', id, patch),
  trashSchedules: (ids) => invoke('schedule:trash', ids),
  restoreSchedules: (ids) => invoke('schedule:restore', ids),
  deleteSchedulesForever: (ids) => invoke('schedule:delete-forever', ids),
  splitSchedule: (id, date) => invoke('schedule:split', id, date),
  exportIcs: (options) => invoke('schedule:export-ics', options),

  // 草稿
  newDraftId: () => invoke('draft:new-id'),
  discardDraft: (id) => invoke('draft:discard', id),

  // 分类
  addCategory: (name) => invoke('category:add', name),
  renameCategory: (from, to) => invoke('category:rename', from, to),
  removeCategory: (name) => invoke('category:remove', name),

  // 附件
  addAttachmentPaths: (entryId, paths) => invoke('attachment:add-paths', entryId, paths),
  addAttachmentBuffer: (entryId, buffer, filename) => invoke('attachment:add-buffer', entryId, buffer, filename),
  cleanupAttachments: (relPaths) => invoke('attachment:cleanup', relPaths),
  openAttachment: (relPath) => invoke('attachment:open', relPath),
  revealAttachment: (relPath) => invoke('attachment:reveal', relPath),
  saveAttachmentAs: (relPath, name) => invoke('attachment:save-as', relPath, name),

  // 选择文件 / 剪贴板
  pickFiles: (kind) => invoke('dialog:pick', kind),
  readClipboardImage: () => invoke('clipboard:image'),
  copyText: (text) => invoke('clipboard:write-text', text),

  // 导出
  exportMarkdown: (ids, options) => invoke('export:markdown', ids, options),
  exportPreview: (ids, options) => invoke('export:preview', ids, options),

  // 备份 / 恢复
  createBackup: (path) => invoke('backup:create', path),
  backupToLibrary: () => invoke('backup:create-in-library'),
  inspectBackup: () => invoke('backup:inspect'),
  inspectPath: (path) => invoke('backup:inspect-path', path),
  restoreBackup: (path) => invoke('backup:restore', path),
  listBackups: () => invoke('backup:list'),

  // 打开外部链接
  openExternal: (url) => invoke('shell:open-external', url),

  // 天气（主进程走 Open-Meteo，带缓存与离线降级）
  weather: {
    get: (city) => invoke('weather:get', city),
  },

  // 微信读书（weread）
  weread: {
    status: () => invoke('weread:status'),
    config: (patch) => invoke('weread:config', patch),
    call: (apiName, params) => invoke('weread:call', apiName, params),
    chapter: (bookId, chapterUid) => invoke('weread:chapter', bookId, chapterUid),
  },

  // 文件编辑器（读取 / 编辑 / 预览本地文件夹与 HTML）
  editor: {
    openFolder: () => invoke('editor:open-folder'),
    list: (dir) => invoke('editor:list', dir),
    read: (filePath, encoding) => invoke('editor:read', filePath, encoding),
    write: (filePath, content) => invoke('editor:write', filePath, content),
  },

  // 本地电子书库（对标 Calibre）
  ebooks: {
    import: (paths) => invoke('ebooks:import', paths),
    list: () => invoke('ebooks:list'),
    get: (id) => invoke('ebooks:get', id),
    meta: (id, patch) => invoke('ebooks:meta', id, patch),
    delete: (id) => invoke('ebooks:delete', id),
    progress: (id, progress) => invoke('ebooks:progress', id, progress),
    chapter: (id, href) => invoke('ebooks:chapter', id, href),
    txt: (id) => invoke('ebooks:txt', id),
    exportTxt: (id) => invoke('ebooks:export-txt', id),
    calibre: () => invoke('ebooks:calibre'),
    convert: (id, to) => invoke('ebooks:convert', id, to),
    open: (id) => invoke('ebooks:open', id),
    bookmark: (id, action, payload) => invoke('ebooks:bookmark', id, action, payload),
    search: (id, q) => invoke('ebooks:search', id, q),
    prefGet: () => invoke('ebooks:pref-get'),
    prefSet: (patch) => invoke('ebooks:pref-set', patch),
  },

  // AI 资讯聚合（分层信源 + 身份订阅）
  ainews: {
    catalog: () => invoke('ainews:catalog'),
    cache: () => invoke('ainews:cache'),
    prefs: () => invoke('ainews:prefs'),
    refresh: () => invoke('ainews:refresh'),
    setIdentity: (id) => invoke('ainews:set-identity', id),
    toggleSource: (id, enabled) => invoke('ainews:toggle-source', id, enabled),
    toggleReadLater: (item) => invoke('ainews:toggle-readlater', item),
    noteGet: (link, title) => invoke('ainews:note-get', link, title),
    noteSet: (link, title, text) => invoke('ainews:note-set', link, title, text),
  },

  // 工具包（Toolkit）八个子模块
  toolkit: {
    // 密码
    vaultExists: () => invoke('tk:vault-exists'),
    vaultCreate: (pw) => invoke('tk:vault-create', pw),
    vaultUnlock: (pw) => invoke('tk:vault-unlock', pw),
    vaultLock: () => invoke('tk:vault-lock'),
    vaultList: () => invoke('tk:vault-list'),
    vaultAdd: (rec) => invoke('tk:vault-add', rec),
    vaultUpdate: (id, patch) => invoke('tk:vault-update', id, patch),
    vaultDelete: (id) => invoke('tk:vault-delete', id),
    vaultGet: (id) => invoke('tk:vault-get', id),
    vaultGen: (opts) => invoke('tk:vault-gen', opts),
    // 任务
    tasksList: () => invoke('tk:tasks-list'),
    taskAdd: (t) => invoke('tk:task-add', t),
    taskUpdate: (id, patch) => invoke('tk:task-update', id, patch),
    taskDelete: (id) => invoke('tk:task-delete', id),
    // 启动器
    cmdsList: () => invoke('tk:cmds-list'),
    cmdsSearch: (q) => invoke('tk:cmds-search', q),
    cmdAdd: (c) => invoke('tk:cmd-add', c),
    cmdUpdate: (id, patch) => invoke('tk:cmd-update', id, patch),
    cmdDelete: (id) => invoke('tk:cmd-delete', id),
    cmdRun: (id) => invoke('tk:cmd-run', id),
    // Docker
    dockerAvailable: () => invoke('tk:docker-available'),
    dockerContainers: () => invoke('tk:docker-containers'),
    dockerImages: () => invoke('tk:docker-images'),
    dockerAction: (kind, action, id) => invoke('tk:docker-action', kind, action, id),
    // 磁盘
    home: () => invoke('tk:home'),
    diskScan: (dir, depth) => invoke('tk:disk-scan', dir, depth),
    diskClean: (p) => invoke('tk:disk-clean', p),
    // 窗口分屏
    windowLayout: (side) => invoke('tk:window-layout', side),
    // 截屏
    screenshot: (opts) => invoke('tk:screenshot', opts),
    shotsList: () => invoke('tk:shots-list'),
  },

  // 拖拽进来的 File 对象 → 真实磁盘路径（Electron 32+ 不再有 File.path）
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  // 主进程菜单事件
  onMenu: (handler) => {
    const channels = [
      'menu:new',
      'menu:new-schedule',
      'menu:save',
      'menu:search',
      'menu:settings',
      'menu:backup',
      'menu:backup-as',
      'menu:restore',
      'menu:export-ics',
      'menu:calendar',
      'menu:all',
      'menu:help',
      'menu:toggle-side',
      'menu:toggle-list',
    ];
    for (const ch of channels) {
      ipcRenderer.on(ch, () => handler(ch));
    }
  },

  // 日程提醒（应用运行期间才会有）
  onReminder: (handler) => {
    ipcRenderer.on('reminder:fire', (_e, payload) => handler({ type: 'fire', ...payload }));
    ipcRenderer.on('reminder:summary', (_e, payload) => handler({ type: 'summary', ...payload }));
  },
  onReminderFocus: (handler) => {
    ipcRenderer.on('reminder:focus', (_e, payload) => handler(payload));
  },

  // 飞书日历同步
  feishu: {
    getConfig: () => invoke('feishu:config'),
    saveConfig: (patch) => invoke('feishu:save-config', patch),
    login: () => invoke('feishu:login'),
    logout: () => invoke('feishu:logout'),
    pull: () => invoke('feishu:pull'),
    push: () => invoke('feishu:push'),
    status: () => invoke('feishu:status'),
    onResult: (handler) => {
      ipcRenderer.on('feishu:sync-result', (_e, payload) => handler(payload));
    },
  },
});
