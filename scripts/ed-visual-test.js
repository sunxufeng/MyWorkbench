'use strict';
/**
 * 可视化编辑（所见即所得）端到端自测：由 src/main/devtools.js 在 LA_TEST_SCRIPT 下加载。
 * 验证：打开 HTML → 切到可视化模式 → 页面内容装载正确 → 就地改字并同步回源码 → 保存落盘。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const log = (...a) => console.log('[ed-visual]', ...a);
const assert = (cond, label) => {
  if (!cond) throw new Error('断言失败：' + label);
  log('  ✓ ' + label);
};

module.exports = async function ({ win, app, shot, errors }) {
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-edvis-'));
  const root = path.join(tmp, 'site');
  fs.mkdirSync(root, { recursive: true });
  const htmlPath = path.join(root, 'index.html');
  fs.writeFileSync(
    htmlPath,
    '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><title>示例</title></head>' +
      '<body><h1>HelloWorld</h1><p>这是一段示例文字。</p></body></html>',
    'utf8'
  );
  log('测试目录：' + root);

  // 切到编辑器，打开刚才的目录并加载 HTML
  const setup = await run(`(async () => {
    state.view = 'editor'; renderAll();
    state.ed.root = ${JSON.stringify(root)};
    await edRefreshTree();
    await edLoadFile(${JSON.stringify(htmlPath)});
    return {
      visual: state.ed.visual,
      tabs: Object.keys(state.ed.tabs).length,
      activePath: edActivePath(),
    };
  })()`);
  log('初始化：' + JSON.stringify(setup));
  assert(!setup.visual, '初始为代码模式');
  assert(setup.tabs === 1, '已加载一个 HTML 文件');

  // 切到可视化模式
  const toggled = await run(`(async () => {
    edToggleVisual();
    await new Promise(r => setTimeout(r, 60));
    const vis = document.getElementById('edVisual0');
    const tb = document.getElementById('edVisualToolbar0');
    return {
      visual: state.ed.visual,
      hasEditor: !!vis && vis.getAttribute('contenteditable') === 'true',
      hasToolbar: !!tb && tb.querySelectorAll('button[data-cmd]').length,
      bodyHasOriginal: vis ? vis.innerHTML.includes('HelloWorld') : false,
      previewHidden: !document.querySelector('.ed-preview'),
    };
  })()`);
  log('切到可视化：' + JSON.stringify(toggled));
  assert(toggled.visual, '已进入可视化模式');
  assert(toggled.hasEditor, '编辑区是可编辑的 contenteditable');
  assert(toggled.hasToolbar, '出现格式工具栏');
  assert(toggled.bodyHasOriginal, '页面内容（body）正确装载进编辑区');
  assert(toggled.previewHidden, '可视化模式下右栏预览被隐藏（编辑区即所见即所得）');

  // 就地改文字 + 触发 input，应同步回源码并标记脏
  const edited = await run(`(async () => {
    const vis = document.getElementById('edVisual0');
    vis.innerHTML = '<h1>编辑后的标题</h1><p>新段落内容</p>';
    vis.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
    const tab = state.ed.tabs[${JSON.stringify(htmlPath)}];
    return {
      contentHasNew: tab.content.includes('编辑后的标题'),
      contentHasHead: tab.content.includes('<title>示例</title>'),
      dirty: tab.dirty,
    };
  })()`);
  log('就地编辑：' + JSON.stringify(edited));
  assert(edited.contentHasNew, '就地改的字回到了源码（tab.content）');
  assert(edited.contentHasHead, '同步时保留了 <head> 等外壳');
  assert(edited.dirty, '改动被标记为未保存');

  // 格式工具栏：点「加粗」按钮不应报错（无选区时是空操作，但接线必须正常）
  const tbClick = await run(`(async () => {
    const before = document.getElementById('edVisual0').innerHTML;
    const b = document.querySelector('#edVisualToolbar0 button[data-cmd="bold"]');
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); // 先 mousedown 验证 preventDefault 不报错
    b.click();
    return { before, threw: false };
  })()`);
  assert(tbClick.threw === false, '点击加粗按钮（含 mousedown 防选区丢失）不抛错');

  // 切回代码模式，CodeMirror 应显示最新的源码
  const backToCode = await run(`(async () => {
    edToggleVisual();
    await new Promise(r => setTimeout(r, 60));
    const cm = edActiveCM();
    return { visual: state.ed.visual, cmHasNew: cm ? cm.getValue().includes('编辑后的标题') : false };
  })()`);
  log('切回代码：' + JSON.stringify(backToCode));
  assert(!backToCode.visual, '已切回代码模式');
  assert(backToCode.cmHasNew, '代码视图里能看到可视化模式下的改动');

  // 保存落盘
  const saved = await run(`(async () => {
    await edSaveActive();
    await new Promise(r => setTimeout(r, 60));
    return { dirty: state.ed.tabs[${JSON.stringify(htmlPath)}].dirty };
  })()`);
  assert(!saved.dirty, '保存后标记已清除');

  const onDisk = fs.readFileSync(htmlPath, 'utf8');
  assert(onDisk.includes('编辑后的标题'), '磁盘上的文件已被可视化编辑的内容覆盖');
  assert(onDisk.includes('<title>示例</title>'), '磁盘文件的外壳（head）完好');

  fs.rmSync(tmp, { recursive: true, force: true });
  log('可视化编辑端到端自测通过，渲染进程错误 ' + errors.length + ' 条');
};
