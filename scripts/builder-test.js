'use strict';
/**
 * 设计模式（Webflow 式可视化建站）端到端自测：由 src/main/devtools.js 在 LA_TEST_SCRIPT 下加载。
 * 验证：打开 HTML → 进设计模式 → 画布装载 → 加元素 → 点选 → 改样式回写源码 → 切代码 → 保存落盘。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const log = (...a) => console.log('[builder]', ...a);
const assert = (cond, label) => {
  if (!cond) throw new Error('断言失败：' + label);
  log('  ✓ ' + label);
};

module.exports = async function ({ win, app, shot, errors }) {
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-builder-'));
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

  // 切到编辑器，打开目录并加载 HTML
  const setup = await run(`(async () => {
    state.view = 'editor'; renderAll();
    state.ed.root = ${JSON.stringify(root)};
    await edRefreshTree();
    await edLoadFile(${JSON.stringify(htmlPath)});
    return { visual: state.ed.visual, tabs: Object.keys(state.ed.tabs).length };
  })()`);
  log('初始化：' + JSON.stringify(setup));
  assert(!setup.visual, '初始为代码模式');
  assert(setup.tabs === 1, '已加载一个 HTML 文件');

  // 进入设计模式
  const toggled = await run(`(async () => {
    edToggleVisual();
    await new Promise(r => setTimeout(r, 600));
    const f = document.getElementById('wbFrame');
    const doc = f && f.contentDocument;
    return {
      builder: state.ed.visual,
      hasFrame: !!f,
      frameReady: !!(doc && doc.body),
      bodyHas: doc ? doc.body.innerHTML.includes('HelloWorld') : false,
      hasLeft: !!document.getElementById('wbLeftBody'),
      hasNavigator: !!document.getElementById('wbLayerTree'),
      hasInspect: !!document.getElementById('wbInspectBody'),
      hasBreadcrumb: !!document.querySelector('.wb-breadcrumb'),
    };
  })()`);
  log('进设计模式：' + JSON.stringify(toggled));
  assert(toggled.builder, '已进入设计模式');
  assert(toggled.hasFrame, '画布 iframe 存在');
  assert(toggled.frameReady, 'iframe 已加载且 body 就绪');
  assert(toggled.bodyHas, '页面内容正确装载进画布');
  assert(toggled.hasLeft, '出现左侧 Elements/Navigator 面板');
  assert(toggled.hasNavigator, '出现 Navigator 图层树');
  assert(toggled.hasInspect, '出现「检查器」面板');
  assert(toggled.hasBreadcrumb, '出现顶部 breadcrumb');

  // 切换到 Elements 面板
  const elems = await run(`(async () => {
    wbToggleLeft('elements');
    await new Promise(r => setTimeout(r, 50));
    return { hasAddList: !!document.getElementById('wbAddList') };
  })()`);
  log('Elements 面板：' + JSON.stringify(elems));
  assert(elems.hasAddList, 'Elements 面板出现「添加元素」列表');

  // 切回 Navigator 后再添加元素（heading + section）
  await run(`wbToggleLeft('navigator')`);
  const added = await run(`(async () => {
    wbAddElement('heading');
    wbAddElement('section');
    await new Promise(r => setTimeout(r, 400));
    const doc = document.getElementById('wbFrame').contentDocument;
    const tab = state.ed.tabs[${JSON.stringify(htmlPath)}];
    return {
      h2: doc.querySelectorAll('h2').length,
      section: doc.querySelectorAll('section').length,
      contentHasH2: tab.content.includes('标题文本'),
      contentHasSection: tab.content.includes('新区块'),
      layers: document.querySelectorAll('.wb-layer').length,
      dirty: tab.dirty,
    };
  })()`);
  log('添加元素：' + JSON.stringify(added));
  assert(added.h2 >= 1, '画布里出现一个 h2');
  assert(added.section >= 1, '画布里出现一个 section');
  assert(added.contentHasH2, '新增 heading 已序列化进源码');
  assert(added.contentHasSection, '新增 section 已序列化进源码');
  assert(added.layers >= 4, '图层树列出了元素');
  assert(added.dirty, '改动被标记为未保存');

  // 点选 h2 并改样式（颜色 + 字号），应内联写入并回写源码
  const styled = await run(`(async () => {
    const doc = document.getElementById('wbFrame').contentDocument;
    const h2 = doc.querySelector('h2');
    const id = h2.getAttribute('data-wf-id');
    wbSelect(id);
    wbSetStyle('color', '#ff0000', 'desktop');
    wbSetStyle('font-size', '28px', 'desktop');
    await new Promise(r => setTimeout(r, 400));
    const el = document.getElementById('wbFrame').contentDocument.querySelector('h2');
    const tab = state.ed.tabs[${JSON.stringify(htmlPath)}];
    return {
      inlineColor: el.style.color,
      inlineSize: el.style.fontSize,
      contentHas: tab.content.toLowerCase().includes('color: rgb(255, 0, 0)') || tab.content.toLowerCase().includes('color:#ff0000'),
      contentHasSize: tab.content.toLowerCase().includes('28px'),
    };
  })()`);
  log('改样式：' + JSON.stringify(styled));
  assert(styled.inlineColor === 'rgb(255, 0, 0)', '颜色已写入元素内联样式');
  assert(styled.inlineSize === '28px', '字号已写入元素内联样式');
  assert(styled.contentHas, '颜色已回写进源码');
  assert(styled.contentHasSize, '字号已回写进源码');

  // 断点覆盖：在平板断点改 padding，应生成 media query 样式块
  const bp = await run(`(async () => {
    wbSetBp('tablet');
    const doc = document.getElementById('wbFrame').contentDocument;
    const h2 = doc.querySelector('h2');
    const id = h2.getAttribute('data-wf-id');
    wbSelect(id);
    wbSetStyle('padding', '10px', 'tablet');
    await new Promise(r => setTimeout(r, 400));
    const tab = state.ed.tabs[${JSON.stringify(htmlPath)}];
    const fdoc = document.getElementById('wbFrame').contentDocument;
    const bpStyle = fdoc.querySelector('style[data-wf-bp]');
    const bs = state.ed.builderState;
    return {
      hasMedia: tab.content.indexOf('@media') >= 0,
      hasBpBlock: tab.content.indexOf('data-wf-bp') >= 0,
      frameBpText: bpStyle ? bpStyle.textContent.slice(0, 200) : null,
      contentHas991: tab.content.indexOf('991px') >= 0,
      bpStylesDump: bs ? JSON.stringify(bs.bpStyles) : null,
    };
  })()`);
  log('断点覆盖：' + JSON.stringify(bp));
  if (!bp.hasMedia) { log('  !! frameBpText=' + JSON.stringify(bp.frameBpText) + ' bpStylesDump=' + bp.bpStylesDump); }
  assert(bp.hasMedia, '平板断点的覆盖生成了 @media 规则');
  assert(bp.hasBpBlock, '源码里写入了 data-wf-bp 样式块');

  // 切回代码模式，CodeMirror 应能看到改动
  const back = await run(`(async () => {
    wbSetBp('desktop');
    edToggleVisual();
    await new Promise(r => setTimeout(r, 80));
    const cm = edActiveCM();
    return { builder: state.ed.visual, cmHas: cm ? cm.getValue().includes('标题文本') : false };
  })()`);
  log('切回代码：' + JSON.stringify(back));
  assert(!back.builder, '已切回代码模式');
  assert(back.cmHas, '代码视图里能看到设计模式的改动');

  // 保存落盘
  const saved = await run(`(async () => {
    await edSaveActive();
    await new Promise(r => setTimeout(r, 80));
    return { dirty: state.ed.tabs[${JSON.stringify(htmlPath)}].dirty };
  })()`);
  assert(!saved.dirty, '保存后标记已清除');

  const onDisk = fs.readFileSync(htmlPath, 'utf8').toLowerCase();
  assert(onDisk.includes('标题文本'), '磁盘文件已包含设计器新增的 heading');
  assert(onDisk.includes('color: rgb(255, 0, 0)') || onDisk.includes('color:#ff0000'), '磁盘文件已包含内联颜色样式');
  assert(onDisk.includes('data-wf-bp'), '磁盘文件已包含断点样式块');

  fs.rmSync(tmp, { recursive: true, force: true });
  log('设计模式端到端自测通过，渲染进程错误 ' + errors.length + ' 条');
};
