#!/usr/bin/env node
// 生成 dualsense-c GUI 线框图：.excalidraw + .svg + .png
// 用法：cd /Users/pcong/obsidian/docs/TODO && node assets/dualsense-c-gui/_build_gui_diagrams.js [--only=ia,input,trigger,rules,signals,output,dashboard]
//
// 设计约束（与 PRD §11.3 设计令牌表逐值一致，改动须同步）：
//   - 暗色仅用于「窗框内部」；图外标题/图例/脚注用深色文字，适配浅色 PRD 页面
//   - stale 不只靠颜色：颜色 + 文字徽标 + 图标 + 边框样式（虚线/点线）
//   - 性能：sparkline / 波形一律画成「固定长度环形缓冲」的静态示意，并标注缓冲长度
//   - 输出确定性：id / seed 自增，不用 Math.random，重跑 byte-stable

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = __dirname;
const RSVG = '/opt/homebrew/bin/rsvg-convert';
const UPDATED = 1792512000000; // 固定时间戳，保证重跑幂等

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const MONO = '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", "Hiragino Sans GB", monospace';

/* ============================ 设计令牌 ============================ */
const T = {
  // 图外（浅色画布）
  page: '#ffffff',
  ink: '#1e1e1e',
  inkMuted: '#495057',
  inkFaint: '#868e96',
  hair: '#dee2e6',

  // 窗框内（暗色默认主题）
  bg: '#0B0E14',
  bar: '#0F1420',
  panel: '#131824',
  panelAlt: '#1A2130',
  border: '#263044',
  grid: '#1E2636',
  fg: '#E6EAF2',
  muted: '#93A1B8',
  accent: '#4C8DFF',

  // 语义色（与 PRD 11.3 表一致）
  fresh: '#2FB344',
  stale: '#E8B33A',
  absent: '#7B879B',
  error: '#E5484D',
  hold: '#4C8DFF',
  cooldown: '#A855F7',
  info: '#22B8CF',

  // 字号阶梯：display 22 / title 16 / body 14 / caption 13 / numeric 20(mono)
  fs: { display: 22, title: 16, body: 14, caption: 13, micro: 11, num: 20 },

  // 间距 / 圆角 / 动效
  gap: 8, gutter: 24,
  r: { chip: 4, panel: 8, window: 12, pill: 999 },
  motion: { hover: 120, dragFrame: 33, cmdHz: 30, textHz: 10 },
};

// chip 三件套：边框色 / 底色 / 文字色（颜色 + 文字 + 图标 + 边框样式，四重表达）
T.tone = {
  fresh:    { line: T.fresh,    fill: '#10261A', text: '#5BE07A', icon: '●' },
  stale:    { line: T.stale,    fill: '#2A2210', text: '#F5C24B', icon: '⏳' },
  absent:   { line: T.absent,   fill: '#1B2028', text: '#AEB8C6', icon: '∅' },
  true:     { line: T.fresh,    fill: '#10261A', text: '#5BE07A', icon: '✓' },
  false:    { line: T.absent,   fill: '#1B2028', text: '#AEB8C6', icon: '✕' },
  hold:     { line: T.hold,     fill: '#111E33', text: '#7FB0FF', icon: '⏸' },
  cooldown: { line: T.cooldown, fill: '#211230', text: '#C084FC', icon: '◷' },
  error:    { line: T.error,    fill: '#2A1214', text: '#FF6B6F', icon: '!' },
  info:     { line: T.info,     fill: '#0E2530', text: '#4DD4E8', icon: 'i' },
  accent:   { line: T.accent,   fill: '#111E33', text: '#7FB0FF', icon: '▸' },
  plain:    { line: T.border,   fill: T.panelAlt, text: T.muted,   icon: '' },
};

/* ============================ 工具函数 ============================ */
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 中文按 1em、ASCII 按 0.6em 估算宽度，避免框内溢出
function charW(ch, size) {
  return ch.codePointAt(0) < 0x2e80 ? size * 0.6 : size;
}
function measure(str, size) {
  let max = 0;
  for (const line of String(str).split('\n')) {
    let w = 0;
    for (const ch of line) w += charW(ch, size);
    max = Math.max(max, w);
  }
  return Math.ceil(max);
}
// 确定性伪随机（LCG），用于示意波形/轨迹
function rnd(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
function dashArray(dash, sw) {
  if (dash === 'dash') return `${sw * 4} ${sw * 3}`;
  if (dash === 'dot') return `${sw * 1.2} ${sw * 2.4}`;
  return null;
}

/* ============================ Scene：图元 + 双序列化 ============================ */
class Scene {
  constructor({ width, height, title = '', subtitle = '', ground = T.page }) {
    this.width = width;
    this.height = height;
    this.title = title;
    this.subtitle = subtitle;
    this.ground = ground;
    this.ex = [];        // excalidraw elements
    this.svg = [];       // svg fragments
    this.seq = 0;        // 元素自增序号（确定性 id/seed）
    this.counts = {};
  }

  _id(kind) {
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    return `f_${kind}_${this.counts[kind]}`;
  }

  _guard(x, y, w, h) {
    const pad = 4;
    const boxes = [
      [x, y], [x + w, y], [x, y + h], [x + w, y + h],
    ];
    for (const [px, py] of boxes) {
      if (px < -pad || py < -pad || px > this.width + pad || py > this.height + pad) {
        throw new Error(`[out-of-bounds] ${this.title || 'scene'}: (${Math.round(px)},${Math.round(py)}) 超出 ${this.width}×${this.height}`);
      }
    }
  }

  _base(kind, x, y, w, h, stroke, fill, sw, dash, opacity) {
    this.seq += 1;
    return {
      id: this._id(kind),
      type: kind,
      x, y, width: w, height: h,
      angle: 0,
      strokeColor: stroke,
      backgroundColor: fill === 'none' || !fill ? 'transparent' : fill,
      fillStyle: 'solid',
      strokeWidth: sw,
      strokeStyle: dash === 'dot' ? 'dotted' : dash === 'dash' ? 'dashed' : 'solid',
      roughness: 0,
      opacity,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 10000 + this.seq * 13,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: UPDATED,
      link: null,
      locked: false,
    };
  }

  rect({ x, y, w, h, fill = 'none', stroke = T.border, sw = 1, dash = null, radius = T.r.panel, opacity = 100 }) {
    this._guard(x, y, w, h);
    const e = this._base('rectangle', x, y, w, h, stroke, fill, sw, dash, opacity);
    e.roundness = radius ? { type: 3 } : null;
    this.ex.push(e);
    const da = dashArray(dash, sw);
    this.svg.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius || 0}"`
      + ` fill="${fill === 'none' ? 'none' : fill}" stroke="${stroke}" stroke-width="${sw}"`
      + `${da ? ` stroke-dasharray="${da}"` : ''}${opacity !== 100 ? ` opacity="${opacity / 100}"` : ''}/>`);
  }

  text({ x, y, w = null, text, size = T.fs.body, color = T.ink, align = 'left', family = 'sans',
         weight = 400, anchor = 'start', lh = 1.3, italic = false }) {
    const fam = family === 'mono' ? MONO : SANS;
    const lines = String(text).split('\n');
    const width = w || measure(text, size);
    const height = Math.ceil(lines.length * size * lh);
    // anchor → 左边缘
    const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
    this._guard(left, y, width, height);

    const e = this._base('text', left, y, width, height, color, 'transparent', 1, null, 100);
    e.roundness = null;
    e.text = String(text);
    e.originalText = String(text);
    e.fontSize = size;
    e.fontFamily = family === 'mono' ? 3 : 2;
    e.textAlign = align;
    e.verticalAlign = 'top';
    e.containerId = null;
    e.lineHeight = lh;
    this.ex.push(e);

    const svgAnchor = anchor;
    const tx = anchor === 'middle' ? x : anchor === 'end' ? x : x;
    const rows = lines.map((ln, i) =>
      `<tspan x="${tx}" dy="${i === 0 ? 0 : size * lh}">${esc(ln)}</tspan>`).join('');
    this.svg.push(`<text x="${tx}" y="${y + size * 0.94}" font-family="${esc(fam)}" font-size="${size}"`
      + ` font-weight="${weight}" fill="${color}" text-anchor="${svgAnchor}"`
      + `${italic ? ' font-style="italic"' : ''}`
      + ` style="font-variant-numeric:tabular-nums;white-space:pre">${rows}</text>`);
  }

  line({ x1, y1, x2, y2, color = T.border, sw = 1, dash = null, opacity = 100 }) {
    const minX = Math.min(x1, x2), minY = Math.min(y1, y2);
    this._guard(minX, minY, Math.abs(x2 - x1), Math.abs(y2 - y1));
    const e = this._base('line', x1, y1, Math.abs(x2 - x1), Math.abs(y2 - y1), color, 'none', sw, dash, opacity);
    e.points = [[0, 0], [x2 - x1, y2 - y1]];
    e.lastCommittedPoint = null;
    e.startBinding = null;
    e.endBinding = null;
    e.startArrowhead = null;
    e.endArrowhead = null;
    this.ex.push(e);
    const da = dashArray(dash, sw);
    this.svg.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"`
      + `${da ? ` stroke-dasharray="${da}"` : ''}${opacity !== 100 ? ` opacity="${opacity / 100}"` : ''}/>`);
  }

  polyline({ points, color = T.accent, sw = 1.5, dash = null, close = false, fill = 'none', opacity = 100 }) {
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const w = Math.max(...xs) - minX, h = Math.max(...ys) - minY;
    this._guard(minX, minY, w, Math.max(h, 1));

    const e = this._base('line', points[0][0], points[0][1], w, Math.max(h, 1), color, fill, sw, dash, opacity);
    e.points = points.map((p) => [p[0] - points[0][0], p[1] - points[0][1]]);
    e.lastCommittedPoint = null;
    e.startBinding = null;
    e.endBinding = null;
    e.startArrowhead = null;
    e.endArrowhead = null;
    this.ex.push(e);

    const da = dashArray(dash, sw);
    const pts = points.map((p) => `${p[0]},${p[1]}`).join(' ');
    if (close) {
      this.svg.push(`<polygon points="${pts}" fill="${fill}" stroke="${color}" stroke-width="${sw}"`
        + `${da ? ` stroke-dasharray="${da}"` : ''}/>`);
    } else {
      this.svg.push(`<polyline points="${pts}" fill="${fill === 'none' ? 'none' : fill}" stroke="${color}"`
        + ` stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"`
        + `${da ? ` stroke-dasharray="${da}"` : ''}${opacity !== 100 ? ` opacity="${opacity / 100}"` : ''}/>`);
    }
  }

  arrow({ x1, y1, x2, y2, color = T.inkMuted, sw = 1.4, dash = null, head = true }) {
    const minX = Math.min(x1, x2), minY = Math.min(y1, y2);
    this._guard(minX, minY, Math.abs(x2 - x1), Math.abs(y2 - y1));
    const e = this._base('arrow', x1, y1, Math.abs(x2 - x1), Math.abs(y2 - y1), color, 'none', sw, dash, 100);
    e.points = [[0, 0], [x2 - x1, y2 - y1]];
    e.lastCommittedPoint = null;
    e.startBinding = null;
    e.endBinding = null;
    e.startArrowhead = null;
    e.endArrowhead = head ? 'arrow' : null;
    this.ex.push(e);
    const da = dashArray(dash, sw);
    const marker = color === T.accent ? 'arrow-blue' : color === T.error ? 'arrow-red' : color === T.inkMuted ? 'arrow-gray' : 'arrow-gray';
    this.svg.push(`<path d="M ${x1} ${y1} L ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${sw}"`
      + `${da ? ` stroke-dasharray="${da}"` : ''} marker-end="url(#${marker})"/>`);
  }

  ellipse({ cx, cy, rx, ry, fill = 'none', stroke = T.border, sw = 1, dash = null, opacity = 100 }) {
    this._guard(cx - rx, cy - ry, rx * 2, ry * 2);
    const e = this._base('ellipse', cx - rx, cy - ry, rx * 2, ry * 2, stroke, fill, sw, dash, opacity);
    e.roundness = null;
    this.ex.push(e);
    const da = dashArray(dash, sw);
    this.svg.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill === 'none' ? 'none' : fill}"`
      + ` stroke="${stroke}" stroke-width="${sw}"${da ? ` stroke-dasharray="${da}"` : ''}`
      + `${opacity !== 100 ? ` opacity="${opacity / 100}"` : ''}/>`);
  }

  // 状态徽标：颜色 + 文字 + 图标 + 边框样式
  chip({ x, y, w = null, h = 20, label, tone = 'info', size = 10.5, icon = null, family = 'mono' }) {
    const c = T.tone[tone] || T.tone.plain;
    const ic = icon === null ? c.icon : icon;
    const body = ic ? `${ic} ${label}` : label;
    const width = w || Math.ceil(measure(body, size) + 18);
    const dash = tone === 'stale' ? 'dash' : tone === 'absent' || tone === 'false' ? 'dot' : null;
    this.rect({ x, y, w: width, h, fill: c.fill, stroke: c.line, sw: 1, dash, radius: T.r.chip });
    this.text({
      x: x + width / 2, y: y + (h - size * 1.3) / 2, text: body, size, color: c.text,
      anchor: 'middle', align: 'center', family, weight: 600,
    });
    return width;
  }

  // 面板壳：标题 + 副标题 + 右上徽标，返回内容区
  panel({ x, y, w, h, title = '', sub = '', badge = '', badgeTone = 'info', children = [], pad = 12 }) {
    this.rect({ x, y, w, h, fill: T.panel, stroke: T.border, sw: 1, radius: T.r.panel });
    let top = y + pad;
    if (title) {
      this.text({ x: x + pad, y: top, text: title, size: T.fs.caption, color: T.fg, weight: 600 });
      if (badge) {
        const bw = Math.ceil(measure(badge, 10) + 18);
        this.chip({ x: x + w - pad - bw, y: top - 2, w: bw, h: 18, label: badge, tone: badgeTone, size: 10, icon: '' });
      }
      top += 22;
    }
    if (sub) {
      this.text({ x: x + pad, y: top - 4, text: sub, size: 10.5, color: T.muted });
      top += 16;
    }
    const content = { x: x + pad, y: top + (title || sub ? 6 : 0), w: w - pad * 2, h: 0 };
    content.h = y + h - pad - content.y;
    for (const child of children) child(content);
    return content;
  }

  // 暗色 UI 窗框（顶栏 + 内容区 + 底部状态栏）
  ui({ x, y, w, h, title = '', sub = '', chips = [], status = '' }) {
    this.rect({ x, y, w, h, fill: T.bg, stroke: T.border, sw: 1.5, radius: T.r.window });
    this.rect({ x, y, w, h: 40, fill: T.bar, stroke: T.bar, sw: 0, radius: T.r.window });
    this.line({ x1: x, y1: y + 40, x2: x + w, y2: y + 40, color: T.border, sw: 1 });
    // 三个「窗口按钮」示意
    for (let i = 0; i < 3; i++) {
      this.ellipse({ cx: x + 18 + i * 14, cy: y + 20, rx: 4, ry: 4, fill: T.border, stroke: T.border, sw: 1 });
    }
    this.text({ x: x + 68, y: y + 12, text: title, size: T.fs.caption, color: T.fg, weight: 600 });
    if (sub) {
      this.text({ x: x + 68 + measure(title, T.fs.caption) + 14, y: y + 13, text: sub, size: T.fs.micro, color: T.muted });
    }
    let cx = x + w - 16;
    for (const ch of chips.slice().reverse()) {
      const bw = Math.ceil(measure((ch.icon ? ch.icon + ' ' : '') + ch.label, 10) + 18);
      cx -= bw;
      this.chip({ x: cx, y: y + 11, w: bw, h: 18, label: ch.label, tone: ch.tone || 'plain', size: 10, icon: ch.icon ?? null });
      cx -= 8;
    }
    let content;
    if (status) {
      const sy = y + h - 28;
      this.line({ x1: x, y1: sy, x2: x + w, y2: sy, color: T.border, sw: 1 });
      this.rect({ x, y: sy, w, h: 28, fill: T.bar, stroke: T.bar, sw: 0, radius: T.r.window });
      this.text({ x: x + 16, y: sy + 8, text: status, size: 10.5, color: T.muted, family: 'mono' });
      content = { x: x + 16, y: y + 52, w: w - 32, h: sy - (y + 52) - 16 };
    } else {
      content = { x: x + 16, y: y + 52, w: w - 32, h: h - 52 - 16 };
    }
    return content;
  }

  // 坐标轴：返回映射函数
  axis({ x, y, w, h, xLabels = [], yTicks = 5, color = T.grid }) {
    for (let i = 0; i <= yTicks; i++) {
      const gy = y + (h * i) / yTicks;
      this.line({ x1: x, y1: gy, x2: x + w, y2: gy, color, sw: 1 });
    }
    for (const lb of xLabels) {
      this.line({ x1: x + w * lb.p, y1: y, x2: x + w * lb.p, y2: y + h, color, sw: 1, dash: 'dot', opacity: 60 });
    }
  }

  // 环形缓冲示意（固定 N 点，标注缓冲长度）
  spark({ x, y, w, h, seed = 7, color = T.fresh, n = 40, sw = 1.2, fill = 'none', amp = 0.8 }) {
    const r = rnd(seed);
    const pts = [];
    let v = 0.5;
    for (let i = 0; i < n; i++) {
      v += (r() - 0.5) * 0.35;
      v = Math.min(1, Math.max(0.05, v));
      pts.push([x + (w * i) / (n - 1), y + h - v * h * amp - h * (1 - amp) / 2]);
    }
    this.polyline({ points: pts, color, sw, fill });
    return pts;
  }

  write(name) {
    // ---------- SVG ----------
    const head = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}" width="${this.width}" height="${this.height}">`;
    const defs = `  <defs>
    <marker id="arrow-gray" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto">
      <path d="M 0 1 L 7.5 4.5 L 0 8 Z" fill="${T.inkMuted}"/>
    </marker>
    <marker id="arrow-blue" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto">
      <path d="M 0 1 L 7.5 4.5 L 0 8 Z" fill="${T.accent}"/>
    </marker>
    <marker id="arrow-red" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto">
      <path d="M 0 1 L 7.5 4.5 L 0 8 Z" fill="${T.error}"/>
    </marker>
  </defs>`;
    const titleSvg = this.title
      ? `<text x="32" y="46" font-family="${esc(SANS)}" font-size="23" font-weight="700" fill="${T.ink}">${esc(this.title)}</text>`
        + (this.subtitle
          ? `\n<text x="32" y="72" font-family="${esc(SANS)}" font-size="13" font-weight="500" fill="${T.inkMuted}">${esc(this.subtitle)}</text>`
          : '')
      : '';
    const bg = `<rect x="0" y="0" width="${this.width}" height="${this.height}" fill="${this.ground}"/>`;
    const svg = [head, defs, bg, titleSvg, ...this.svg, '</svg>'].join('\n');

    // ---------- Excalidraw ----------
    const doc = {
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements: this.ex,
      appState: { gridSize: null, viewBackgroundColor: this.ground },
      files: {},
    };

    const base = path.join(OUT, name);
    fs.writeFileSync(`${base}.excalidraw`, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.writeFileSync(`${base}.svg`, svg + '\n', 'utf8');

    // ---------- PNG（硬交付物，失败必须抛错）----------
    execFileSync(RSVG, ['-w', '2400', `${base}.svg`, '-o', `${base}.png`], { stdio: 'pipe' });
    return [`${base}.excalidraw`, `${base}.svg`, `${base}.png`];
  }
}

/* ================================================================== */
/* 图 11-1：全局信息架构与布局                                          */
/* ================================================================== */
function figIA() {
  const s = new Scene({
    width: 1600, height: 1000,
    title: '图 11-1  dualsense-c GUI 信息架构与全局布局',
    subtitle: '左 rail（10 屏 × 功能 ID）· 顶栏（profile / 连接态 / seq / 订阅频率）· 内容四区 · 底部状态栏；数据流只有 STT1 与 CMD1 两条新增通道',
  });

  /* ---- 左：数据层 ---- */
  s.text({ x: 56, y: 108, text: '数据层（GUI 只读 + 控制请求）', size: 11, color: T.inkFaint, weight: 600 });
  s.rect({ x: 56, y: 128, w: 224, h: 66, fill: '#F1F3F5', stroke: '#CED4DA', sw: 1, radius: 8 });
  s.text({ x: 68, y: 138, text: 'ds5d', size: 16, color: T.ink, weight: 700, family: 'mono' });
  s.text({ x: 68, y: 162, text: '唯一 hidraw owner', size: 11.5, color: T.inkMuted });

  const flows = [
    { y: 214, head: 'STT1  30–60Hz', sub: 'shaped / raw / age / fresh', tone: 'fresh', dash: null },
    { y: 280, head: 'CMD1  JSON', sub: 'preview / reload / health', tone: 'info', dash: null },
    { y: 346, head: 'SIG1  125Hz', sub: 'raw 原始流（不改动）', tone: 'absent', dash: 'dash' },
  ];
  for (const f of flows) {
    s.rect({ x: 56, y: f.y, w: 196, h: 50, fill: '#FBFBFC', stroke: f.dash ? '#ADB5BD' : '#CED4DA', sw: 1, dash: f.dash, radius: 6 });
    s.line({ x1: 56, y1: f.y, x2: 60, y2: f.y + 50, color: f.dash ? '#ADB5BD' : T.tone[f.tone].line, sw: 3 });
    s.text({ x: 68, y: f.y + 7, text: f.head, size: 12, color: T.tone[f.tone].line, family: 'mono', weight: 600 });
    s.text({ x: 68, y: f.y + 27, text: f.sub, size: 10, color: T.inkMuted });
    s.arrow({ x1: 256, y1: f.y + 25, x2: 296, y2: f.y + 25, color: f.dash ? '#ADB5BD' : T.accent });
  }
  s.text({ x: 56, y: 402, text: '127.0.0.1:9997 · 仅环回 · 按 magic 分流', size: 9.5, color: T.inkFaint, family: 'mono' });

  /* ---- 左：状态图例 ---- */
  s.line({ x1: 56, y1: 428, x2: 280, y2: 428, color: T.hair, sw: 1 });
  s.text({ x: 56, y: 440, text: '状态图例 · 四重表达', size: 11, color: T.inkFaint, weight: 600 });
  const legend = [['fresh', 'TTL 内更新'], ['stale', '超 TTL，值冻结'], ['absent', '从未提供'], ['error', '求值/写失败']];
  legend.forEach(([tone, label], i) => {
    s.chip({ x: 56, y: 462 + i * 26, w: 84, h: 20, label: tone.toUpperCase(), tone, size: 10 });
    s.text({ x: 148, y: 466 + i * 26, text: label, size: 10, color: T.inkMuted });
  });
  s.text({ x: 56, y: 574, text: '颜色 + 文字 + 图标 + 边框样式（虚线/点线）\n四者同时表达；禁止仅用颜色，禁止闪烁动画。', size: 10, color: T.inkMuted, lh: 1.5 });

  s.rect({ x: 56, y: 624, w: 224, h: 148, fill: '#FFF9E6', stroke: '#E8B33A', sw: 1, radius: 8 });
  s.text({ x: 68, y: 632, text: '不可违背的约束', size: 11, color: '#8A6512', weight: 700 });
  s.text({
    x: 68, y: 654, size: 9.8, color: '#6B5310', lh: 1.55,
    text: '① 60Hz 数据下 ≥30fps\n② sparkline/波形 = 定长环形缓冲\n③ 文本 10Hz 节流，禁每帧新对象\n④ 拖拽 ≤100ms 生效（≤30Hz 预览）\n⑤ GUI 不 open hidraw，只发 hid.claim',
  });
  s.text({ x: 56, y: 790, text: '仓库零改动 · 资产位于 vault（docs/TODO/assets/）', size: 9.5, color: T.inkFaint });

  /* ---- 窗框 ---- */
  const W = { x: 300, y: 110, w: 1236, h: 760 };
  s.rect({
    x: W.x, y: W.y, w: W.w, h: W.h, fill: T.bg, stroke: T.border, sw: 1.5, radius: T.r.window,
  });
  // 顶栏
  s.rect({ x: W.x, y: W.y, w: W.w, h: 40, fill: T.bar, stroke: T.bar, sw: 0, radius: T.r.window });
  s.line({ x1: W.x, y1: W.y + 40, x2: W.x + W.w, y2: W.y + 40, color: T.border, sw: 1 });
  s.rect({ x: 316, y: 118, w: 186, h: 24, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 5 });
  s.text({ x: 326, y: 123, text: 'profile  fps-aim.yaml ▾', size: 10.5, color: T.fg, family: 'mono' });
  s.chip({ x: 514, y: 121, w: 62, h: 18, label: 'LIVE', tone: 'fresh', size: 9.5 });
  s.text({ x: 588, y: 124, text: 'seq 184223', size: 10.5, color: T.muted, family: 'mono' });
  s.chip({ x: 676, y: 121, w: 68, h: 18, label: 'STT1 60Hz', tone: 'info', size: 9.5, icon: '' });
  s.chip({ x: 752, y: 121, w: 56, h: 18, label: 'strict', tone: 'plain', size: 9.5, icon: '' });
  s.text({ x: W.x + W.w - 16, y: 124, text: '⌘K  命令面板', size: 10.5, color: T.muted, anchor: 'end' });
  s.text({ x: 828, y: 122, text: '④ 顶栏联动：切 profile / 订阅频率，作用于全部屏', size: 9.8, color: T.accent });

  /* ---- 左 rail：10 屏 × 功能 ID ---- */
  s.line({ x1: 516, y1: 150, x2: 516, y2: 842, color: T.border, sw: 1 });
  const rail = [
    ['观测', [['S1 Dashboard', '1.1·1.4·1.5'], ['S2 Input', '1.2·6.5', true], ['S3 Signals', '1.3·5.6']]],
    ['决策', [['S4 Rules', '3.1–3.3'], ['S5 Trigger', '2.1·2.3·2.4'], ['S6 Output', '2.2·2.5']]],
    ['工程', [['S7 Profile', '4.1–4.4'], ['S8 Calibrator', '5.1·4.5']]],
    ['增强', [['S9 Aim', '6.1–6.4']]],
    ['周边', [['S10 Peripherals', '5.2–5.5']]],
  ];
  let ry = 160;
  for (const [group, items] of rail) {
    s.text({ x: 324, y: ry, text: group, size: 9.5, color: T.muted, weight: 600 });
    ry += 20;
    for (const [name, ids, active] of items) {
      if (active) {
        s.rect({ x: 318, y: ry - 4, w: 196, h: 26, fill: T.panelAlt, stroke: T.panelAlt, sw: 0, radius: 5 });
        s.line({ x1: 318, y1: ry - 4, x2: 320, y2: ry + 22, color: T.accent, sw: 3 });
      }
      s.text({ x: 328, y: ry, text: name, size: 12, color: active ? T.fg : T.muted, weight: active ? 700 : 400 });
      s.text({ x: 506, y: ry + 1, text: ids, size: 9, color: active ? T.accent : T.muted, anchor: 'end', family: 'mono' });
      ry += 26;
    }
    ry += 8;
  }
  s.text({ x: 324, y: 700, text: '← 本列即「10 屏 × 功能 ID」映射矩阵', size: 9.5, color: T.accent });
  s.text({ x: 324, y: 720, text: '30 项功能 ID 全覆盖（§4.0）', size: 9.5, color: T.muted });
  s.text({ x: 324, y: 748, text: '1..0 切屏   / 搜索', size: 9.5, color: T.muted, family: 'mono' });
  s.text({ x: 324, y: 766, text: 'space 暂停   R 录制', size: 9.5, color: T.muted, family: 'mono' });

  /* ---- 内容四区 ---- */
  s.rect({ x: 532, y: 162, w: 612, h: 438, fill: T.panel, stroke: T.border, sw: 1, radius: 8 });
  s.text({ x: 546, y: 172, text: '① 主画布 · 当前屏主体', size: 12.5, color: T.fg, weight: 600 });
  s.text({ x: 546, y: 194, text: 'S2 → 摇杆/扳机/按键；S5 → 曲线画布；S4 → AST + 抢占链', size: 10, color: T.muted });
  s.spark({ x: 560, y: 226, w: 556, h: 120, seed: 31, color: T.fresh, n: 60 });
  s.spark({ x: 560, y: 366, w: 556, h: 120, seed: 77, color: T.info, n: 60 });
  s.text({ x: 560, y: 496, text: '定长缓冲 Float32Array(600) · 60Hz 入 / 30fps 出', size: 9.5, color: T.muted, family: 'mono' });

  s.rect({ x: 1160, y: 162, w: 360, h: 438, fill: T.panel, stroke: T.border, sw: 1, radius: 8 });
  s.text({ x: 1174, y: 172, text: '② 右侧 Inspector · 选中项详情', size: 12.5, color: T.fg, weight: 600 });
  s.text({ x: 1174, y: 194, text: 'hover / 选中任何信号或规则 → 此处展开', size: 10, color: T.muted });
  const insRows = [
    ['signal', 'l2 · fresh · age 12ms', 'fresh'],
    ['raw → shaped', '0.63 → 0.61', 'plain'],
    ['shaper', 'deadzone 0.08 / gamma 1.4', 'plain'],
    ['provider(inferred)', 'ds5bridge @9997', 'plain'],
    ['rule', 'l2_weapon · TRUE', 'true'],
  ];
  insRows.forEach(([k, v, tone], i) => {
    const yy = 226 + i * 34;
    s.line({ x1: 1174, y1: yy + 26, x2: 1506, y2: yy + 26, color: T.grid, sw: 1 });
    s.text({ x: 1174, y: yy + 4, text: k, size: 10, color: T.muted });
    if (tone === 'plain') s.text({ x: 1174, y: yy + 18, text: v, size: 10.5, color: T.fg, family: 'mono' });
    else s.chip({ x: 1174, y: yy + 15, w: 196, h: 18, label: v, tone, size: 9.5 });
  });
  s.text({ x: 1174, y: 408, text: 'Provider 归属为推断：STATE1 无 provider 字段\n→ UI 一律标 inferred ○，不伪造确定来源', size: 9.5, color: T.muted, lh: 1.5 });
  s.chip({ x: 1174, y: 456, w: 120, h: 18, label: 'APPEND-ONLY', tone: 'cooldown', size: 9, icon: '🔒' });
  s.text({ x: 1302, y: 460, text: '76 槽词表不可插队', size: 9.5, color: T.muted });

  s.rect({ x: 532, y: 616, w: 988, h: 174, fill: T.panel, stroke: T.border, sw: 1, radius: 8 });
  s.text({ x: 546, y: 626, text: '③ 底部时间轴 · 跨屏共享同一时间基（hover 冻结视图，seq 继续）', size: 12.5, color: T.fg, weight: 600 });
  s.axis({ x: 560, y: 654, w: 932, h: 88, yTicks: 3, xLabels: [{ p: 0.25 }, { p: 0.5 }, { p: 0.75 }] });
  s.spark({ x: 560, y: 654, w: 932, h: 88, seed: 5, color: T.fresh, n: 80, amp: 0.45 });
  s.spark({ x: 560, y: 654, w: 932, h: 88, seed: 19, color: T.hold, n: 80, amp: 0.30 });
  s.line({ x1: 560 + 932 * 0.63, y1: 648, x2: 560 + 932 * 0.63, y2: 748, color: T.accent, sw: 1.5, dash: 'dash' });
  s.chip({ x: 560 + 932 * 0.63 - 34, y: 764, w: 68, h: 16, label: 'playhead', tone: 'accent', size: 8.5, icon: '' });
  for (let i = 0; i <= 5; i++) {
    s.text({ x: 560 + (932 * i) / 5, y: 748, text: `${i - 5}s`, size: 8.5, color: T.muted, family: 'mono', anchor: i === 0 ? 'start' : i === 5 ? 'end' : 'middle' });
  }
  s.text({ x: 1506, y: 626, text: '③ 5s 环形缓冲', size: 9.5, color: T.muted, anchor: 'end', family: 'mono' });

  s.text({
    x: 532, y: 800, size: 10, color: T.muted, lh: 1.5,
    text: '四区位置固定：任何屏只替换 ① 与 ② 的内容，③ 时间轴与 ④ 顶栏跨屏不变 —— 保证「切屏不丢上下文」。',
  });
  s.text({ x: 532, y: 820, text: '观测（S1–S3）→ 决策（S4–S6）→ 工程（S7–S8）→ 增强（S9）→ 周边（S10）', size: 10, color: T.accent });

  /* ---- 底部状态栏 ---- */
  s.line({ x1: W.x, y1: 842, x2: W.x + W.w, y2: 842, color: T.border, sw: 1 });
  s.rect({ x: W.x, y: 842, w: W.w, h: 28, fill: T.bar, stroke: T.bar, sw: 0, radius: T.r.window });
  s.text({
    x: W.x + 16, y: 850, size: 9.5, color: T.muted, family: 'mono',
    text: 'seq 184223  ·  lag_ms 12  ·  jitter p99 0.8ms  ·  drop 0  ·  hid_err 0  ·  uptime 01:42:07  ·  loopback 127.0.0.1:9997  ·  strict on  ·  dry-run off',
  });

  /* ---- 设计令牌条 ---- */
  s.line({ x1: 56, y1: 890, x2: 1544, y2: 890, color: T.hair, sw: 1 });
  s.text({ x: 56, y: 902, text: '设计令牌（暗色默认；浅色映射见 §11.3 表 11-1）', size: 11, color: T.inkFaint, weight: 600 });
  const swatches = [
    ['bg', T.bg], ['panel', T.panel], ['border', T.border], ['fg', T.fg], ['muted', T.muted],
    ['fresh', T.fresh], ['stale', T.stale], ['absent', T.absent], ['error', T.error],
  ];
  swatches.forEach(([k, c], i) => {
    const x = 56 + i * 74;
    s.rect({ x, y: 922, w: 64, h: 24, fill: c, stroke: T.hair, sw: 1, radius: 4 });
    s.text({ x, y: 950, text: `${k} ${c}`, size: 7.8, color: T.inkFaint, family: 'mono' });
  });
  s.text({ x: 740, y: 904, text: '字号阶梯  display 22 / title 16 / body 14 / caption 13  ·  数字 20 mono（tabular-nums）', size: 10, color: T.ink });
  s.text({ x: 740, y: 926, text: '间距 4 / 8 / 12 / 16 / 24  ·  圆角 4 / 8 / 12  ·  动效 hover 120ms · 拖拽帧 33ms · CMD1 预览 ≤30Hz', size: 10, color: T.inkMuted });
  s.text({ x: 740, y: 952, text: '暗色默认  ·  单位显式（0–1 / 0–255 / ms / Hz / %）  ·  stale 不只靠颜色', size: 10, color: T.accent, weight: 600 });

  return s;
}

/* ================================================================== */
/* 图 11-2：S2 输入面板                                                 */
/* ================================================================== */
function stick(s, { cx, cy, r, label, raw, shaped, readRaw, readShaped }) {
  s.ellipse({ cx, cy, rx: r, ry: r, fill: '#0E1220', stroke: T.border, sw: 1 });
  s.line({ x1: cx - r, y1: cy, x2: cx + r, y2: cy, color: T.grid, sw: 1 });
  s.line({ x1: cx, y1: cy - r, x2: cx, y2: cy + r, color: T.grid, sw: 1 });
  for (const p of [0.33, 0.66]) {
    s.ellipse({ cx, cy, rx: r * p, ry: r * p, fill: 'none', stroke: T.grid, sw: 1 });
  }
  s.ellipse({ cx, cy, rx: r * 0.3, ry: r * 0.3, fill: 'none', stroke: T.stale, sw: 1.2, dash: 'dash' });
  s.text({ x: cx, y: cy + r * 0.3 + 10, text: '死区 0.30', size: 8.5, color: T.stale, anchor: 'middle', family: 'mono' });

  const rp = [cx + raw[0] * r, cy - raw[1] * r];
  const sp = [cx + shaped[0] * r, cy - shaped[1] * r];
  for (let i = 6; i >= 0; i--) {
    const t = i / 6;
    s.ellipse({
      cx: rp[0] + (sp[0] - rp[0]) * (1 - t), cy: rp[1] + (sp[1] - rp[1]) * (1 - t),
      rx: 3.4, ry: 3.4, fill: T.info, stroke: T.info, sw: 0, opacity: Math.round(15 + 55 * (1 - t)),
    });
  }
  s.line({ x1: rp[0], y1: rp[1], x2: sp[0], y2: sp[1], color: T.info, sw: 1, dash: 'dot', opacity: 70 });
  s.ellipse({ cx: rp[0], cy: rp[1], rx: 6, ry: 6, fill: 'none', stroke: T.muted, sw: 1.8 });
  s.ellipse({ cx: sp[0], cy: sp[1], rx: 5, ry: 5, fill: T.accent, stroke: T.accent, sw: 1 });
  s.text({ x: cx, y: cy + r + 12, text: label, size: 11, color: T.fg, anchor: 'middle', weight: 600 });
  s.text({ x: cx, y: cy + r + 30, text: readRaw, size: 9.5, color: T.muted, anchor: 'middle', family: 'mono' });
  s.text({ x: cx, y: cy + r + 46, text: readShaped, size: 10.5, color: T.fg, anchor: 'middle', family: 'mono' });
}

function figInput() {
  const s = new Scene({
    width: 1400, height: 900,
    title: '图 11-2  S2 输入面板（功能 1.2 / 6.5）',
    subtitle: '双摇杆 raw/shaped 叠加 + 死区圆 + 残影 · L2/R2 行程条与 0.85 阈值 · 按键 / D-pad · 6 轴与姿态 · 触控板 · 电量',
  });

  const c = s.ui({
    x: 40, y: 100, w: 1320, h: 680,
    title: 'S2 输入面板',
    sub: '1.2 输入可视化  ·  6.5 双路一致性',
    chips: [{ label: 'LIVE', tone: 'fresh' }, { label: 'STT1 60Hz', tone: 'info', icon: '' }],
    status: 'STT1 60Hz · seq 184223 · lag 12ms · 只读：GUI 不 open hidraw（写权经 CMD1 hid.claim）',
  });

  /* 一致性横幅（6.5） */
  s.rect({ x: c.x, y: c.y, w: c.w, h: 34, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 6 });
  s.text({ x: c.x + 12, y: c.y + 9, text: '6.5 双路一致性：raw(物理) ＝ shaped(注入 ds5vpad) — 一致', size: 12, color: T.fg });
  s.chip({ x: c.x + c.w - 108, y: c.y + 8, w: 96, h: 18, label: 'CONSISTENT', tone: 'fresh', size: 9 });
  s.text({ x: c.x + 470, y: c.y + 10, text: '不一致时此条转 error + aim.mismatch', size: 9.5, color: T.muted });

  /* A 列：双摇杆 */
  s.panel({
    x: 56, y: 198, w: 436, h: 300, title: '双摇杆 · raw / shaped / 死区 / 残影', badge: 'STT1', badgeTone: 'info',
  });
  stick(s, { cx: 163, cy: 316, r: 88, label: '左摇杆 lx / ly', raw: [0.55, -0.30], shaped: [0.42, -0.18], readRaw: 'raw   0.55 / −0.30', readShaped: 'shaped 0.42 / −0.18' });
  stick(s, { cx: 369, cy: 316, r: 88, label: '右摇杆 rx / ry', raw: [0.20, 0.46], shaped: [0.14, 0.38], readRaw: 'raw   0.20 /  0.46', readShaped: 'shaped 0.14 /  0.38' });
  s.text({ x: 68, y: 468, text: '○ raw   ● shaped   残影 6 点（LPF 33ms）  ⊙ 死区圆 0.30', size: 9.5, color: T.muted });
  s.text({ x: 68, y: 482, text: 'STT1 同时提供 lx/ly/rx/ry 的 raw 与 shaped', size: 9.5, color: T.muted });

  /* A 列：触控板 */
  s.panel({ x: 56, y: 514, w: 436, h: 222, title: '触控板 · 触点与轨迹', badge: '120Hz', badgeTone: 'plain' });
  s.rect({ x: 78, y: 566, w: 300, h: 150, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 6 });
  s.line({ x1: 228, y1: 566, x2: 228, y2: 716, color: T.grid, sw: 1 });
  s.line({ x1: 78, y1: 641, x2: 378, y2: 641, color: T.grid, sw: 1 });
  const touch = [[0.32, 0.72], [0.40, 0.66], [0.47, 0.58], [0.54, 0.50], [0.60, 0.43], [0.64, 0.36], [0.62, 0.34]];
  touch.forEach(([tx, ty], i) => {
    s.ellipse({
      cx: 78 + tx * 300, cy: 566 + ty * 150, rx: i === touch.length - 1 ? 5 : 2.6, ry: i === touch.length - 1 ? 5 : 2.6,
      fill: i === touch.length - 1 ? T.accent : T.info, stroke: 'none', sw: 0, opacity: i === touch.length - 1 ? 100 : 25 + i * 10,
    });
  });
  s.text({ x: 390, y: 580, text: 'x 0.62', size: 10.5, color: T.fg, family: 'mono' });
  s.text({ x: 390, y: 596, text: 'y 0.34', size: 10.5, color: T.fg, family: 'mono' });
  s.chip({ x: 390, y: 616, w: 62, h: 18, label: 'TOUCH 1', tone: 'true', size: 9 });
  s.text({ x: 390, y: 646, text: '按压 0.42', size: 9.5, color: T.muted, family: 'mono' });
  s.text({ x: 78, y: 722, text: '归一化 0–1，原点左上；坐标单位与量纲必须显式', size: 9.5, color: T.muted });

  /* B 列：扳机 */
  s.panel({ x: 508, y: 198, w: 412, h: 196, title: '扳机行程 · 阈值 0.85', badge: 'l2_full 0', badgeTone: 'false' });
  const bx = 556, bw = 300, thr = bx + bw * 0.85;
  s.text({ x: 524, y: 250, text: 'L2', size: 11, color: T.fg, family: 'mono' });
  s.rect({ x: bx, y: 244, w: bw, h: 26, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 4 });
  s.rect({ x: bx, y: 244, w: bw * 0.63, h: 26, fill: T.fresh, stroke: T.fresh, sw: 0, radius: 4, opacity: 55 });
  s.text({ x: bx + 8, y: 249, text: '0.63 / 0–1', size: 10, color: T.fg, family: 'mono' });

  s.text({ x: 524, y: 306, text: 'R2', size: 11, color: T.fg, family: 'mono' });
  s.rect({ x: bx, y: 300, w: bw, h: 26, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 4 });
  s.rect({ x: bx, y: 300, w: bw * 0.41, h: 26, fill: T.fresh, stroke: T.fresh, sw: 0, radius: 4, opacity: 55 });
  s.text({ x: bx + 8, y: 305, text: '0.41 / 0–1', size: 10, color: T.fg, family: 'mono' });

  s.line({ x1: thr, y1: 228, x2: thr, y2: 340, color: T.stale, sw: 1.4, dash: 'dash' });
  s.text({ x: thr - 6, y: 228, text: '0.85 阈值', size: 9.5, color: T.stale, anchor: 'end', family: 'mono' });
  s.rect({ x: thr - 3, y: 238, w: 6, h: 6, fill: T.stale, stroke: T.stale, sw: 0 });
  for (const [p, lb] of [[0, '0'], [0.5, '0.5'], [1, '1']]) {
    s.text({ x: bx + bw * p, y: 332, text: lb, size: 8.5, color: T.muted, anchor: p === 0 ? 'start' : p === 1 ? 'end' : 'middle', family: 'mono' });
  }
  s.chip({ x: 524, y: 356, w: 92, h: 18, label: 'r2_full 0', tone: 'false', size: 9 });
  s.chip({ x: 624, y: 356, w: 118, h: 18, label: 'crossed thr .85', tone: 'absent', size: 9 });
  s.text({ x: 750, y: 361, text: '边沿', size: 9, color: T.muted });

  /* B 列：按键 */
  s.panel({ x: 508, y: 410, w: 412, h: 326, title: '按键 / D-pad · 按下态双表达', badge: '1 按下', badgeTone: 'accent' });
  s.text({ x: 600, y: 452, text: 'face', size: 9.5, color: T.muted, anchor: 'middle', family: 'mono' });
  s.ellipse({ cx: 600, cy: 512, rx: 16, ry: 16, fill: T.panelAlt, stroke: T.border, sw: 1 });
  s.text({ x: 600, y: 506, text: '△', size: 12, color: T.muted, anchor: 'middle' });
  s.ellipse({ cx: 636, cy: 530, rx: 16, ry: 16, fill: T.panelAlt, stroke: T.border, sw: 1 });
  s.text({ x: 636, y: 524, text: '○', size: 12, color: T.muted, anchor: 'middle' });
  s.ellipse({ cx: 564, cy: 530, rx: 16, ry: 16, fill: T.panelAlt, stroke: T.border, sw: 1 });
  s.text({ x: 564, y: 524, text: '□', size: 12, color: T.muted, anchor: 'middle' });
  s.ellipse({ cx: 600, cy: 548, rx: 16, ry: 16, fill: T.accent, stroke: T.accent, sw: 1 });
  s.text({ x: 600, y: 542, text: '×', size: 12, color: '#08101F', anchor: 'middle', weight: 700 });
  s.chip({ x: 552, y: 574, w: 96, h: 18, label: 'PRESSED ×', tone: 'accent', size: 9 });

  s.text({ x: 800, y: 452, text: 'D-pad', size: 9.5, color: T.muted, anchor: 'middle', family: 'mono' });
  const dp = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  dp.forEach(([dx, dy]) => {
    const up = dy < 0;
    s.rect({ x: 800 + dx * 22 - 11, y: 530 + dy * 22 - 11, w: 22, h: 22, fill: up ? T.accent : T.panelAlt, stroke: up ? T.accent : T.border, sw: 1, radius: 3 });
  });
  s.rect({ x: 800 - 11, y: 530 - 11, w: 22, h: 22, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 3 });
  s.text({ x: 800, y: 574, text: '↑ 按下', size: 9, color: T.accent, anchor: 'middle', family: 'mono' });

  const sh = [['L1', 'plain'], ['R1', 'accent'], ['L3', 'plain'], ['R3', 'plain']];
  sh.forEach(([lb, tone], i) => {
    s.chip({ x: 528 + i * 52, y: 614, w: 46, h: 18, label: lb, tone, size: 9 });
  });
  [['PS', 40], ['touchpad', 76], ['mute', 52]].reduce((x, [lb, w]) => {
    s.chip({ x, y: 642, w, h: 18, label: lb, tone: 'plain', size: 9 });
    return x + w + 8;
  }, 528);
  s.text({ x: 528, y: 678, text: '按下 = 填充 + 文字（PRESSED）双表达；不依赖颜色深浅', size: 9.5, color: T.muted });
  s.text({ x: 528, y: 698, text: 'dpad_* 与 face 键位映射见 §5.1 信号段（id 升序）', size: 9.5, color: T.muted });

  /* C 列：6 轴 */
  s.panel({ x: 936, y: 198, w: 408, h: 252, title: '6 轴时域条（gyro dps / accel g）', badge: '10Hz 文本', badgeTone: 'plain' });
  const axes = [
    ['gyro_x', 0.42, '12.4 dps'], ['gyro_y', -0.28, '−8.1 dps'], ['gyro_z', 0.15, '4.4 dps'],
    ['accel_x', -0.06, '−0.06 g'], ['accel_y', 0.04, '0.04 g'], ['accel_z', 0.98, '0.98 g'],
  ];
  axes.forEach(([name, v, unit], i) => {
    const yy = 244 + i * 28;
    s.text({ x: 948, y: yy + 3, text: name, size: 9.5, color: T.muted, family: 'mono' });
    s.rect({ x: 1012, y: yy, w: 190, h: 16, fill: T.panelAlt, stroke: T.grid, sw: 1, radius: 3 });
    const mid = 1012 + 95;
    s.line({ x1: mid, y1: yy, x2: mid, y2: yy + 16, color: T.border, sw: 1 });
    const wv = Math.abs(v) * (v > 0 ? 95 : 95);
    s.rect({ x: v >= 0 ? mid : mid - wv, y: yy + 2, w: wv, h: 12, fill: v >= 0 ? T.info : T.stale, stroke: 'none', sw: 0, radius: 2, opacity: 70 });
    s.text({ x: 1332, y: yy + 3, text: unit, size: 9.5, color: T.fg, anchor: 'end', family: 'mono' });
  });
  s.text({ x: 948, y: 416, text: '环形缓冲 600 点 · 文本 10Hz 节流 · 数值单位不可省略', size: 9, color: T.muted });

  /* C 列：姿态 */
  s.panel({ x: 936, y: 466, w: 408, h: 140, title: '3D 姿态（yaw / pitch / roll）', badge: 'STT1', badgeTone: 'info' });
  const att = [['yaw', 0.62, '132.4°'], ['pitch', -0.22, '−12.0°'], ['roll', 0.10, '6.2°']];
  att.forEach(([name, v, txt], i) => {
    const yy = 512 + i * 28;
    s.text({ x: 948, y: yy + 3, text: name, size: 9.5, color: T.muted, family: 'mono' });
    s.rect({ x: 996, y: yy, w: 236, h: 16, fill: T.panelAlt, stroke: T.grid, sw: 1, radius: 3 });
    const mid = 996 + 118;
    s.line({ x1: mid, y1: yy, x2: mid, y2: yy + 16, color: T.border, sw: 1 });
    s.rect({ x: v >= 0 ? mid : mid + v * 118, y: yy + 2, w: Math.abs(v) * 118, h: 12, fill: T.hold, stroke: 'none', sw: 0, radius: 2, opacity: 70 });
    s.text({ x: 1332, y: yy + 3, text: txt, size: 9.5, color: T.fg, anchor: 'end', family: 'mono' });
  });

  /* C 列：电量 */
  s.panel({ x: 936, y: 622, w: 408, h: 114, title: '电量与充电态', badge: 'USB', badgeTone: 'plain' });
  s.text({ x: 948, y: 660, text: '87%', size: 20, color: T.fg, family: 'mono', weight: 700 });
  s.rect({ x: 1030, y: 664, w: 92, h: 28, fill: T.panelAlt, stroke: T.muted, sw: 1.2, radius: 4 });
  s.rect({ x: 1032, y: 666, w: 76, h: 24, fill: T.fresh, stroke: 'none', sw: 0, radius: 2, opacity: 65 });
  s.rect({ x: 1124, y: 672, w: 6, h: 12, fill: T.muted, stroke: T.muted, sw: 0, radius: 1 });
  s.chip({ x: 1144, y: 668, w: 110, h: 20, label: 'CHARGING', tone: 'fresh', size: 9.5, icon: '⚡' });
  s.text({ x: 948, y: 704, text: '电压 4.12V · 温度 31°C · 充电 87% / 0–100%', size: 9.5, color: T.muted, family: 'mono' });

  /* 图例 */
  s.line({ x1: 40, y1: 800, x2: 1360, y2: 800, color: T.hair, sw: 1 });
  s.chip({ x: 40, y: 810, w: 82, h: 20, label: 'FRESH', tone: 'fresh', size: 9.5 });
  s.chip({ x: 130, y: 810, w: 82, h: 20, label: 'STALE', tone: 'stale', size: 9.5 });
  s.chip({ x: 220, y: 810, w: 86, h: 20, label: 'ABSENT', tone: 'absent', size: 9.5 });
  s.chip({ x: 314, y: 810, w: 80, h: 20, label: 'ERROR', tone: 'error', size: 9.5 });
  s.text({ x: 404, y: 814, text: 'stale = ⏳ + 虚线边框 + 文字，三重表达；不得仅用颜色或闪烁动画', size: 10, color: T.inkMuted });
  s.text({
    x: 40, y: 842, size: 10, color: T.inkMuted, lh: 1.6,
    text: '单位显式：摇杆 0–1（归一化，非 0–255）· 扳机 0–1 与内部 0–255 字节并列展示 · 6 轴 dps / g · 触控 0–1 · 电量 %。\n'
      + '性能：摇杆/行程条/6 轴全部走定长环形缓冲（600 点）+ Canvas 绘制，文本 10Hz 节流；60Hz 输入下 UI ≥30fps。',
  });

  return s;
}

/* ================================================================== */
/* 图 11-3：S5 扳机效果曲线编辑器                                       */
/* ================================================================== */
function figTrigger() {
  const s = new Scene({
    width: 1400, height: 900,
    title: '图 11-3  S5 扳机效果曲线编辑器（功能 2.1 · 2.3 · 2.4）',
    subtitle: '横轴行程 0–100% + 10 档 byte 标尺 · 纵轴阻力 0–255 · 按 mode 渲染语义 · 实时游标 · A/B 叠加 · 写回 profile',
  });

  const c = s.ui({
    x: 40, y: 100, w: 1320, h: 680,
    title: 'S5 扳机效果曲线编辑器',
    sub: '2.1 编辑  ·  2.3 写回  ·  2.4 A/B',
    chips: [{ label: 'LIVE', tone: 'fresh' }, { label: 'CMD1 preview', tone: 'info', icon: '' }],
    status: 'L2 · mode weapon · start=6 · cursor 63% · preview ttl_ms 500 · 未写入（仅预览，ttl 到期交还规则引擎）',
  });

  /* mode 标签条 */
  s.rect({ x: c.x, y: c.y, w: c.w, h: 48, fill: T.panel, stroke: T.border, sw: 1, radius: 6 });
  const modes = ['off', 'rigid', 'section', 'feedback', 'weapon', 'vibration', 'slope_feedback', 'slope_weapon', 'machine'];
  modes.forEach((m, i) => {
    const x = 62 + i * 122, sel = m === 'weapon';
    s.rect({ x, y: 158, w: 118, h: 34, fill: sel ? '#152238' : T.panelAlt, stroke: sel ? T.accent : T.border, sw: sel ? 1.6 : 1, radius: 5 });
    s.text({ x: x + 59, y: 167, text: m, size: 10.5, color: sel ? T.accent : T.muted, anchor: 'middle', family: 'mono', weight: sel ? 700 : 400 });
  });
  s.chip({ x: 1170, y: 158, w: 138, h: 18, label: 'pulse → section', tone: 'plain', size: 8.5, icon: '' });
  s.chip({ x: 1170, y: 180, w: 168, h: 18, label: 'slope → slope_feedback', tone: 'plain', size: 8.5, icon: '' });

  /* 主画布 */
  s.panel({ x: 56, y: 208, w: 844, h: 448, title: 'weapon · 双段折点（3 个可拖 handle）', badge: 'x = 63%', badgeTone: 'accent', pad: 12 });
  s.text({ x: 68, y: 238, text: '阻力（0–255）', size: 9.5, color: T.muted });
  const PX = (p) => 120 + (740 * p) / 100;
  const PY = (v) => 602 - (340 * v) / 255;
  s.axis({ x: 120, y: 262, w: 740, h: 340, yTicks: 5, xLabels: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((p) => ({ p })) });
  ['255', '191', '128', '64', '0'].forEach((lb, i) => {
    s.text({ x: 114, y: 262 + (340 * i) / 5 - 5, text: lb, size: 8.5, color: T.muted, anchor: 'end', family: 'mono' });
  });
  ['0', '25', '50', '75', '100'].forEach((lb, i) => {
    s.text({ x: 120 + (740 * i) / 4, y: 606, text: `${lb}${i === 4 ? '%' : ''}`, size: 8.5, color: T.muted, anchor: i === 0 ? 'start' : i === 4 ? 'end' : 'middle', family: 'mono' });
  });

  /* section 高亮带 */
  s.rect({ x: PX(40), y: 262, w: PX(75) - PX(40), h: 340, fill: T.cooldown, stroke: T.cooldown, sw: 1, dash: 'dash', radius: 0, opacity: 14 });
  s.text({ x: PX(40) + 6, y: 268, text: 'section 语义区间 40–75%', size: 9, color: T.cooldown });

  /* slope_feedback 参考（B 叠加，虚线） */
  s.polyline({ points: [[PX(0), PY(60)], [PX(100), PY(240)]], color: T.info, sw: 1.6, dash: 'dash' });
  s.text({ x: PX(6), y: PY(78) - 14, text: 'B · slope_feedback（虚线）', size: 9, color: T.info });

  /* weapon 主曲线 */
  const wp = [[0, 0], [30, 85], [65, 180], [100, 232]];
  s.polyline({ points: wp.map(([p, v]) => [PX(p), PY(v)]), color: T.accent, sw: 2.6 });
  wp.forEach(([p, v], i) => {
    if (i === 0) return;
    s.ellipse({ cx: PX(p), cy: PY(v), rx: 5.5, ry: 5.5, fill: T.bg, stroke: T.accent, sw: 2 });
    const last = i === wp.length - 1;
    s.text({ x: PX(p) - (last ? 12 : 14), y: last ? PY(v) - 20 : PY(v) + 14, text: `(${p}%, ${v})`, size: 8.5, color: T.muted, anchor: 'end', family: 'mono' });
  });
  s.text({ x: PX(4), y: PY(0) - 18, text: 'A · weapon（实线，可拖）', size: 9, color: T.accent });

  /* 实时游标 */
  s.line({ x1: PX(63), y1: 256, x2: PX(63), y2: 602, color: T.accent, sw: 1.5, dash: 'dash' });
  s.chip({ x: PX(63) - 32, y: 244, w: 64, h: 16, label: '63%', tone: 'accent', size: 8.5, icon: '' });
  s.text({ x: 852, y: 528, text: '阻力 142 / 0–255', size: 9.5, color: T.fg, anchor: 'end', family: 'mono' });
  s.text({ x: 852, y: 546, text: 'P0 = 6 (byte)', size: 9.5, color: T.fg, anchor: 'end', family: 'mono' });
  s.text({ x: 852, y: 564, text: 'cursor @ 63% → 求值 142', size: 9, color: T.muted, anchor: 'end', family: 'mono' });

  /* byte 标尺 */
  s.text({ x: 120, y: 620, text: 'byte 0..9 十档（start / end 取值域）', size: 9, color: T.muted });
  for (let i = 0; i < 10; i++) {
    const x = 120 + i * 74;
    s.rect({ x, y: 634, w: 74, h: 14, fill: i === 6 ? '#152238' : T.panelAlt, stroke: i === 6 ? T.accent : T.border, sw: 1, radius: 0 });
    s.text({ x: x + 37, y: 636, text: String(i), size: 8, color: i === 6 ? T.accent : T.muted, anchor: 'middle', family: 'mono' });
  }

  /* 右侧参数表（固定顺序） */
  s.panel({ x: 916, y: 208, w: 428, h: 448, title: '参数 p0..p9（固定顺序表）', badge: 'clamped 1', badgeTone: 'stale' });
  s.text({ x: 932, y: 250, text: '字节', size: 9, color: T.muted, family: 'mono' });
  s.text({ x: 980, y: 250, text: '命名参数', size: 9, color: T.muted });
  s.text({ x: 1160, y: 250, text: '求值', size: 9, color: T.muted });
  s.text({ x: 1330, y: 250, text: '单位', size: 9, color: T.muted, anchor: 'end' });
  const params = [
    ['p0', 'start', '6', 'byte'],
    ['p1', 'amp_a', '180', '0–255'],
    ['p2', 'amp_b', '90', '0–255'],
    ['p3', 'freq', '42', 'Hz'],
    ['p4', '—', '—', ''],
    ['p5', '—', '—', ''],
    ['p6', '—', '—', ''],
    ['p7', '—', '—', ''],
    ['p8', '—', '—', ''],
    ['p9', '—', '—', ''],
  ];
  params.forEach(([b, name, val, unit], i) => {
    const yy = 268 + i * 23;
    s.line({ x1: 932, y1: yy + 18, x2: 1328, y2: yy + 18, color: T.grid, sw: 1 });
    s.text({ x: 932, y: yy, text: b, size: 9.5, color: T.muted, family: 'mono' });
    s.text({ x: 980, y: yy, text: name, size: 9.5, color: name === '—' ? T.muted : T.fg, family: name === '—' ? 'sans' : 'mono' });
    s.text({ x: 1160, y: yy, text: val, size: 9.5, color: val === '—' ? T.muted : T.fg, family: 'mono' });
    s.text({ x: 1330, y: yy, text: unit, size: 8.5, color: T.muted, anchor: 'end', family: 'mono' });
  });
  s.text({ x: 932, y: 512, text: 'amp_a 180 未超限 · start 6 已钳位到 0..9', size: 8.5, color: T.stale });

  s.text({ x: 932, y: 538, text: 'hid.Trigger 字节 P[0..4]', size: 9, color: T.muted });
  ['06', 'B4', '5A', '2A', '00'].forEach((v, i) => {
    const x = 932 + i * 54;
    s.rect({ x, y: 554, w: 44, h: 28, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 3 });
    s.text({ x: x + 22, y: 560, text: v, size: 10.5, color: T.fg, anchor: 'middle', family: 'mono' });
    s.text({ x: x + 22, y: 586, text: `P${i}`, size: 8, color: T.muted, anchor: 'middle', family: 'mono' });
  });

  s.line({ x1: 932, y1: 604, x2: 1328, y2: 604, color: T.grid, sw: 1 });
  s.polyline({ points: [[936, 620], [980, 620]], color: T.accent, sw: 2.4 });
  s.text({ x: 988, y: 614, text: 'A 当前', size: 9, color: T.muted });
  s.polyline({ points: [[1050, 620], [1094, 620]], color: T.info, sw: 2, dash: 'dash' });
  s.text({ x: 1102, y: 614, text: 'B 对比（2.4）', size: 9, color: T.muted });
  s.text({ x: 932, y: 636, text: 'A/B 切换 ≤1 tick（125Hz → 8ms）', size: 8.5, color: T.muted });

  /* 底部操作条 */
  s.rect({ x: 56, y: 672, w: 844, h: 64, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 6 });
  s.chip({ x: 68, y: 680, w: 190, h: 18, label: 'effect.preview ttl_ms=500', tone: 'info', size: 8.5, icon: '' });
  s.text({ x: 68, y: 704, text: '拖拽 → 乐观重绘 ≤33ms/帧 + preview ≤30Hz 节流', size: 9, color: T.muted });
  s.text({ x: 68, y: 720, text: '生效预算：拖拽 → 硬件 ≤100ms（ttl_ms 兜底交还）', size: 9, color: T.muted });
  s.line({ x1: 400, y1: 680, x2: 400, y2: 728, color: T.border, sw: 1 });
  s.chip({ x: 412, y: 680, w: 148, h: 18, label: '写入 profile → diff', tone: 'accent', size: 8.5, icon: '' });
  s.text({ x: 412, y: 704, text: '2.3 写回：YAML 片段 → 指定 rule → 保存', size: 9, color: T.muted });
  s.text({ x: 412, y: 720, text: '→ profile.reload → 展示 diff；失败回滚旧配置', size: 9, color: T.muted });
  s.line({ x1: 700, y1: 680, x2: 700, y2: 728, color: T.border, sw: 1 });
  s.text({ x: 712, y: 684, text: '校验', size: 9, color: T.fg });
  s.text({ x: 712, y: 702, text: '· p0..p9 顺序固定，不遍历 map', size: 9, color: T.muted });
  s.text({ x: 712, y: 718, text: '· start/end ∈ 0..9 · force 0..255', size: 9, color: T.muted });

  s.panel({ x: 916, y: 672, w: 428, h: 64, title: '两条易错语义', badge: '', pad: 10 });
  s.text({ x: 928, y: 702, text: 'Scaled 只缩放 forceParams，release 包络不缩放几何参数', size: 9, color: T.muted });
  s.text({ x: 928, y: 718, text: 'byte = round(pct/10)，钳位 0..9（不是 0..255）', size: 9, color: T.muted });

  /* 脚注 */
  s.line({ x1: 40, y1: 800, x2: 1360, y2: 800, color: T.hair, sw: 1 });
  s.text({
    x: 40, y: 812, size: 10, color: T.inkMuted, lh: 1.65,
    text: '① 横轴双刻度：百分比 0–100% 给人看，10 档 byte 0..9 给协议看；两者同屏并列，避免「拖出来对不上字节」的返工。\n'
      + '② 9 个有效 mode 平铺，pulse/slope 只在展示层归一（徽标写明），写回 profile 一律用规范名。\n'
      + '③ 只渲染被选 mode 的完整曲线；其余 mode 以标签缩略呈现，避免 9 条曲线互相遮挡。表达式参数显示求值结果 + 实时游标（验收 M2 逐字节一致）。',
  });

  return s;
}

/* ================================================================== */
/* 图 11-4：S4 规则 Inspector                                           */
/* ================================================================== */
function figRules() {
  const s = new Scene({
    width: 1400, height: 900,
    title: '图 11-4  S4 规则 Inspector（功能 3.1–3.4）',
    subtitle: '三态 TRUE/FALSE/STALE · when AST 逐节点求值 · params 求值到 hid.Trigger 字节 · priority 抢占链路 · hold/cooldown/release 时序',
  });

  const c = s.ui({
    x: 40, y: 100, w: 1320, h: 680,
    title: 'S4 规则 Inspector',
    sub: '3.1 三态与求值  ·  3.2 抢占  ·  3.3 时序',
    chips: [{ label: 'LIVE', tone: 'fresh' }, { label: 'STT1 60Hz', tone: 'info', icon: '' }],
    status: 'tick 184223 · 6 rules · 1 STALE · 1 ERROR · winner l2_weapon(p30) · hold 1 · cooldown 1 · backend: rule telemetry pending',
  });

  /* A 列：规则列表 */
  s.panel({ x: 56, y: 152, w: 316, h: 584, title: '规则（6）· 六态徽标', badge: '1 STALE', badgeTone: 'stale' });
  const rules = [
    ['l2_weapon', 'true', 'priority 30 · target l2', 'written[tick]'],
    ['brake_rigid', 'false', 'brake 0.31 > 0.6 为 false', 'target l2'],
    ['audio_speak', 'stale', 'audio_onset age 412ms > 400ms', '引用 stale 信号'],
    ['rumble_hold', 'hold', 'latch：until 余量 120ms', 'target rumble'],
    ['radio_voice', 'cooldown', '仅 speak / radio 生效', '剩余 0.7s'],
    ['l2_section', 'error', 'expr: undefined func "smoth"', 'target l2 · 跳过'],
  ];
  rules.forEach(([name, tone, sub1, sub2], i) => {
    const y = 200 + i * 74;
    if (i > 0) s.line({ x1: 68, y1: y - 10, x2: 360, y2: y - 10, color: T.grid, sw: 1 });
    s.text({ x: 68, y, text: name, size: 11.5, color: T.fg, family: 'mono', weight: 600 });
    s.chip({ x: 264, y: y - 3, w: 96, h: 18, label: tone.toUpperCase(), tone, size: 8.5 });
    s.text({ x: 68, y: y + 20, text: sub1, size: 8.5, color: T.muted });
    s.text({ x: 68, y: y + 34, text: sub2, size: 8.5, color: tone === 'error' ? T.error : T.muted });
  });
  s.chip({ x: 68, y: 652, w: 168, h: 18, label: 'cooldown: 扳机 n/a', tone: 'absent', size: 8.5, icon: '∅' });
  s.text({ x: 68, y: 678, text: '三态 + HOLD/COOLDOWN/ERROR 六态并列；\nSTALE ≠ FALSE（见脚注）', size: 8.5, color: T.muted, lh: 1.5 });
  s.text({ x: 68, y: 712, text: '规则遥测需 Engine.SetTelemetrySink', size: 8.5, color: T.muted });

  /* B 列：AST */
  s.panel({ x: 388, y: 152, w: 432, h: 320, title: 'when AST · 逐节点求值', badge: 'backend pending', badgeTone: 'stale' });
  s.text({ x: 400, y: 196, text: 'when = "brake > 0.2 && has(speed)"', size: 9, color: T.muted, family: 'mono' });
  const root = { x: 512, y: 214, w: 184, h: 42 };
  s.rect({ ...root, fill: '#1B2028', stroke: T.absent, sw: 1.4, radius: 5 });
  s.text({ x: 604, y: 220, text: '&&   root', size: 11, color: T.fg, anchor: 'middle', family: 'mono' });
  s.chip({ x: 604 - 42, y: 236, w: 84, h: 16, label: 'FALSE', tone: 'false', size: 8.5 });
  s.line({ x1: 604, y1: 256, x2: 604, y2: 282, color: T.muted, sw: 1 });
  s.line({ x1: 502, y1: 282, x2: 706, y2: 282, color: T.muted, sw: 1 });
  s.line({ x1: 502, y1: 282, x2: 502, y2: 300, color: T.muted, sw: 1 });
  s.line({ x1: 706, y1: 282, x2: 706, y2: 300, color: T.muted, sw: 1 });
  s.rect({ x: 412, y: 300, w: 180, h: 44, fill: '#10261A', stroke: T.fresh, sw: 1.4, radius: 5 });
  s.text({ x: 502, y: 306, text: 'brake > 0.2', size: 11, color: T.fg, anchor: 'middle', family: 'mono' });
  s.chip({ x: 502 - 40, y: 322, w: 80, h: 16, label: 'TRUE', tone: 'true', size: 8.5 });
  s.rect({ x: 616, y: 300, w: 180, h: 44, fill: '#2A2210', stroke: T.stale, sw: 1.4, dash: 'dash', radius: 5 });
  s.text({ x: 706, y: 306, text: 'has(speed)', size: 11, color: T.fg, anchor: 'middle', family: 'mono' });
  s.chip({ x: 706 - 40, y: 322, w: 80, h: 16, label: 'STALE', tone: 'stale', size: 8.5 });
  s.text({ x: 502, y: 352, text: 'brake = 0.31', size: 9, color: T.fresh, anchor: 'middle', family: 'mono' });
  s.text({ x: 706, y: 352, text: 'speed age 412ms', size: 9, color: T.stale, anchor: 'middle', family: 'mono' });
  s.line({ x1: 400, y1: 372, x2: 808, y2: 372, color: T.grid, sw: 1 });
  s.text({ x: 400, y: 382, text: '逐节点求值需 expr.Patch / parser.Parse 暴露 AST；', size: 8.5, color: T.muted });
  s.text({ x: 400, y: 396, text: '当前 vm.Program 无 AST → 只给根节点三态（标 backend pending）', size: 8.5, color: T.muted });
  s.text({ x: 400, y: 416, text: '根 FALSE 的两种原因必须可区分：值为假 / 引用了 stale', size: 8.5, color: T.stale });
  s.chip({ x: 400, y: 434, w: 130, h: 18, label: 'trace: backend pending', tone: 'stale', size: 8, icon: '' });

  /* B 列：params → bytes */
  s.panel({ x: 388, y: 488, w: 432, h: 248, title: 'params 求值 → hid.Trigger 字节', badge: '逐字节一致 ✓', badgeTone: 'true' });
  s.text({ x: 400, y: 536, text: 'smoothstep(0.05,0.95,p1) = 0.712', size: 9, color: T.fg, family: 'mono' });
  s.text({ x: 400, y: 554, text: 'amp_a = 180   amp_b = 90   freq = 42Hz', size: 9, color: T.fg, family: 'mono' });
  s.text({ x: 400, y: 572, text: 'start = 6 → P0 (0..9 十档)   freq 42 → P3', size: 9, color: T.fg, family: 'mono' });
  ['06', 'B4', '5A', '2A', '00'].forEach((v, i) => {
    const x = 400 + i * 56;
    s.rect({ x, y: 590, w: 46, h: 28, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 3 });
    s.text({ x: x + 23, y: 597, text: v, size: 10.5, color: T.fg, anchor: 'middle', family: 'mono' });
    s.text({ x: x + 23, y: 622, text: `P${i}`, size: 8, color: T.muted, anchor: 'middle', family: 'mono' });
  });
  s.rect({ x: 688, y: 594, w: 118, h: 20, fill: '#10261A', stroke: T.fresh, sw: 1, radius: 4 });
  s.text({ x: 698, y: 598, text: '☑ 与真实帧一致', size: 8.5, color: T.fresh });
  s.text({ x: 400, y: 650, text: '「参数顺序错」与「手感不对」在这里可分：字节逐位对照', size: 8.5, color: T.muted });
  s.text({ x: 400, y: 670, text: '表达式错误按规则聚合（3.4），点击跳转到此处', size: 8.5, color: T.muted });
  s.text({ x: 400, y: 694, text: 'STEP 内零分配填充 TickReport（§5.3）', size: 8.5, color: T.muted });

  /* C 列：priority 抢占 */
  s.panel({ x: 836, y: 152, w: 508, h: 248, title: 'priority 抢占链路（同 target l2）', badge: 'winner p30', badgeTone: 'accent' });
  s.text({ x: 848, y: 190, text: '↓ priority 升序 apply：后写覆盖前写', size: 9, color: T.muted });
  const chain = [
    ['10', 'l2_section', '被覆盖', 'absent'],
    ['20', 'l2_feedback', '被覆盖', 'absent'],
    ['30', 'l2_weapon', '本 tick 生效', 'accent'],
  ];
  chain.forEach(([p, name, note, tone], i) => {
    const y = 204 + i * 62;
    const win = tone === 'accent';
    s.rect({ x: 852, y, w: 476, h: 52, fill: win ? '#152238' : T.panelAlt, stroke: win ? T.accent : T.border, sw: win ? 1.6 : 1, dash: win ? null : 'dash', radius: 5 });
    s.text({ x: 864, y: y + 8, text: `prio ${p}`, size: 10, color: win ? T.accent : T.muted, family: 'mono' });
    s.text({ x: 940, y: y + 7, text: name, size: 11.5, color: win ? T.fg : T.muted, family: 'mono', weight: win ? 700 : 400 });
    s.text({ x: 940, y: y + 28, text: note, size: 8.5, color: win ? T.accent : T.muted });
    if (win) s.chip({ x: 1210, y: y + 16, w: 106, h: 18, label: 'written[tick]', tone: 'true', size: 8, icon: '●' });
    else s.chip({ x: 1236, y: y + 16, w: 80, h: 18, label: 'overridden', tone: 'absent', size: 8, icon: '' });
  });
  s.text({ x: 852, y: 390, text: '同 target 的三条链在时序上等价于「最后一次写赢」', size: 8.5, color: T.muted });

  /* C 列：时序 */
  s.panel({ x: 836, y: 416, w: 508, h: 320, title: '5s 时序窗（tick 阶梯）', badge: 'release 250ms', badgeTone: 'hold' });
  s.axis({ x: 852, y: 464, w: 476, h: 196, yTicks: 2, xLabels: [{ p: 0.2 }, { p: 0.4 }, { p: 0.6 }, { p: 0.8 }] });
  const TX = (ms) => 852 + (476 * ms) / 5000;

  s.text({ x: 856, y: 470, text: 'hold（latch：真值区间每 tick 续期 until）', size: 8.5, color: T.hold });
  s.rect({ x: TX(0), y: 486, w: TX(2600) - TX(0), h: 22, fill: T.fresh, stroke: T.fresh, sw: 0, radius: 0, opacity: 30 });
  s.rect({ x: TX(2600), y: 486, w: TX(3400) - TX(2600), h: 22, fill: T.hold, stroke: T.hold, sw: 1, dash: 'dash', radius: 0, opacity: 30 });
  s.text({ x: TX(0) + 6, y: 491, text: 'TRUE', size: 8, color: T.fresh, family: 'mono' });
  s.text({ x: TX(2600) + 5, y: 491, text: 'until +800ms', size: 8, color: T.hold, family: 'mono' });
  s.polyline({ points: [[TX(0), 516], [TX(3400), 516], [TX(3400), 530]], color: T.hold, sw: 1.4 });

  s.text({ x: 856, y: 546, text: 'release（每 tick 阶梯衰减 250ms，非曲线插值）', size: 8.5, color: T.stale });
  const rel = [];
  const startMs = 3400;
  for (let i = 0; i <= 6; i++) {
    const lvl = 1 - i / 6;
    const yy = 586 - lvl * 24;
    rel.push([TX(startMs + (250 * i) / 6), yy]);
    if (i < 6) rel.push([TX(startMs + (250 * (i + 1)) / 6), yy]);
  }
  s.line({ x1: TX(3400), y1: 586, x2: TX(3700), y2: 586, color: T.grid, sw: 1 });
  s.polyline({ points: rel, color: T.stale, sw: 1.8 });
  s.text({ x: TX(3700) + 8, y: 576, text: 'decay → 0', size: 8, color: T.stale, family: 'mono' });

  s.text({ x: 856, y: 600, text: 'cooldown（仅 speak / radio；扳机规则 n/a）', size: 8.5, color: T.cooldown });
  s.rect({ x: TX(900), y: 614, w: TX(1900) - TX(900), h: 18, fill: T.cooldown, stroke: T.cooldown, sw: 1, dash: 'dash', radius: 0, opacity: 28 });
  s.text({ x: TX(900) + 5, y: 617, text: 'COOLDOWN 1.0s', size: 8, color: T.cooldown, family: 'mono' });
  s.text({ x: TX(1900) + 10, y: 617, text: 'l2_*（扳机规则）→ n/a', size: 8, color: T.muted, family: 'mono' });

  for (let i = 0; i <= 5; i++) {
    s.text({ x: 852 + (476 * i) / 5, y: 662, text: `${i}s`, size: 8, color: T.muted, anchor: i === 0 ? 'start' : i === 5 ? 'end' : 'middle', family: 'mono' });
  }
  s.text({ x: 852, y: 684, text: 'written[tick] 判定点用小三角标在阶梯拐点；hover 任一 tick 联动左侧规则高亮', size: 8.5, color: T.muted });
  s.text({ x: 852, y: 706, text: 'hold 与 cooldown 语义不同：hold 续期、cooldown 封锁（不可混用）', size: 8.5, color: T.stale });

  /* 脚注 */
  s.line({ x1: 40, y1: 800, x2: 1360, y2: 800, color: T.hair, sw: 1 });
  s.text({
    x: 40, y: 812, size: 10, color: T.inkMuted, lh: 1.65,
    text: '① STALE = when 为 false 且引用了 stale/absent 信号；FALSE = 值层面为假。二者严格区分，是「L2 没手感」类排障的第一分叉点。\n'
      + '② hold 是 latch（真值区间内每 tick 续期 until），不是 cooldown；cooldown 仅 speak / radio 生效，扳机规则显示 n/a。\n'
      + '③ release 每 tick 阶梯衰减；Scaled 只缩放 forceParams，不改 release 包络几何。三态 / 逐节点 AST / provider 归因均依赖 §5.1 与 §5.3 新增遥测，标 backend pending。',
  });

  return s;
}

/* ================================================================== */
/* 图 11-5：S3 信号总线（76 槽）                                        */
/* ================================================================== */
function figSignals() {
  const s = new Scene({
    width: 1400, height: 900,
    title: '图 11-5  S3 信号总线监视器（功能 1.3 / 5.6）',
    subtitle: '76 槽全量 + profile 扩展 · raw/shaped 双值 · sparkline 10s · fresh/stale/absent 徽标 · TTL 倒计时 · provider 归属（推断）',
  });

  const c = s.ui({
    x: 40, y: 100, w: 1320, h: 700,
    title: 'S3 信号总线',
    sub: '1.3 监视器  ·  5.6 兼容性看板（id↔name↔provider）',
    chips: [{ label: '76 / 76', tone: 'info', icon: '' }, { label: 'APPEND-ONLY', tone: 'cooldown', icon: '🔒' }],
    status: 'STT1 60Hz · seq 184223 · 渲染 14 / 76 行（视口虚拟化）· 行高固定 34px · 排序 id 升序（wire 契约顺序）',
  });

  /* 工具条 */
  s.rect({ x: c.x, y: c.y, w: c.w, h: 40, fill: T.panel, stroke: T.border, sw: 1, radius: 6 });
  s.rect({ x: 68, y: 158, w: 240, h: 26, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 4 });
  s.text({ x: 78, y: 163, text: '⌕  搜索 name / id', size: 9.5, color: T.muted });
  [['fresh 61', 'fresh'], ['stale 9', 'stale'], ['absent 6', 'absent'], ['all 76', 'accent']].forEach(([lb, tone], i) => {
    const w = 78;
    s.chip({ x: 320 + i * 86, y: 160, w, h: 22, label: lb, tone: tone === 'accent' ? 'accent' : tone, size: 8.5, icon: '' });
  });
  s.text({ x: 700, y: 163, text: '分组：axis / trigger / button / touch / audio / telemetry', size: 9, color: T.muted });
  s.chip({ x: 1206, y: 160, w: 128, h: 22, label: 'id 表由 names.go 生成', tone: 'plain', size: 8, icon: '' });

  /* 表头 */
  s.rect({ x: 56, y: 204, w: 1288, h: 28, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 4 });
  const cols = [
    [68, 'id'], [112, 'name'], [290, 'raw'], [386, 'shaped'], [484, 'Δ'],
    [546, 'sparkline 10s (60 点)'], [748, 'state'], [852, 'TTL'], [996, 'provider (inferred ○)'], [1200, 'has()'],
  ];
  for (const [x, lb] of cols) s.text({ x, y: 211, text: lb, size: 8.5, color: T.muted, family: 'mono' });

  const groupColor = [T.accent, T.info, T.cooldown, T.fresh, T.stale, T.muted];
  // 行内 id 必须与 internal/signal/names.go 的 Standard 顺序逐项一致（APPEND-ONLY wire 契约）。
  // 同一 tick（seq 18422）下与 S2（l2 0.63 / r2 0.41 / lx 0.42 / ly −0.18）与 S4（brake 0.31 FRESH / speed STALE）对齐。
  const rows = [
    [33, 'lx', '0.55', '0.42', '−0.13', 0, 'fresh', '12ms', 'ds5d', '1'],
    [34, 'ly', '−0.30', '−0.18', '+0.12', 0, 'fresh', '12ms', 'ds5d', '1'],
    [35, 'rx', '0.20', '0.14', '−0.06', 0, 'fresh', '12ms', 'ds5d', '1'],
    [36, 'ry', '0.46', '0.38', '−0.08', 0, 'fresh', '12ms', 'ds5d', '1'],
    [19, 'l2', '0.63', '0.61', '−0.02', 1, 'fresh', '12ms', 'ds5d', '1'],
    [20, 'r2', '0.41', '0.39', '−0.02', 1, 'fresh', '12ms', 'ds5d', '1'],
    [25, 'cross', '0', '0', '0', 2, 'fresh', '12ms', 'ds5d', '1'],
    [26, 'circle', '0', '0', '0', 2, 'fresh', '12ms', 'ds5d', '1'],
    [52, 'touch_x', '0.62', '0.62', '0.00', 3, 'fresh', '12ms', 'ds5d', '1'],
    [46, 'gyro_x', '12.4', '12.4', '0.00', 0, 'fresh', '12ms', 'ds5d', '1'],
    [47, 'gyro_y', '−8.1', '−8.1', '0.00', 0, 'fresh', '12ms', 'ds5d', '1'],
    [1, 'brake', '0.31', '0.31', '0.00', 5, 'fresh', '288ms', 'ds5bridge', '1'],
    [4, 'speed', '0.00', '0.00', '0.00', 5, 'stale', '412ms', 'ds5bridge', '0'],
    [62, 'onset', '0.00', '0.00', '0.00', 4, 'stale', '0ms', 'radio', '0'],
  ];
  rows.forEach((r, i) => {
    const [id, name, raw, shaped, d, g, tone, ttl, prov, has] = r;
    const y = 236 + i * 34;
    s.rect({ x: 56, y, w: 1288, h: 34, fill: i % 2 ? '#111720' : 'transparent', stroke: 'none', sw: 0, radius: 0, opacity: 100 });
    s.rect({ x: 56, y, w: 3, h: 34, fill: groupColor[g], stroke: groupColor[g], sw: 0, radius: 0, opacity: 80 });
    s.text({ x: 68, y: y + 11, text: String(id), size: 9.5, color: T.muted, family: 'mono' });
    s.text({ x: 112, y: y + 10, text: name, size: 10.5, color: tone === 'absent' ? T.muted : T.fg, family: 'mono' });
    s.text({ x: 290, y: y + 11, text: raw, size: 9.5, color: tone === 'absent' ? T.muted : T.fg, family: 'mono' });
    s.text({ x: 386, y: y + 11, text: shaped, size: 9.5, color: tone === 'absent' ? T.muted : T.accent, family: 'mono' });
    s.text({ x: 484, y: y + 11, text: d, size: 9, color: T.muted, family: 'mono' });
    if (tone !== 'absent') {
      s.spark({ x: 546, y: y + 8, w: 176, h: 18, seed: 11 + i * 7, color: T.tone[tone].line, n: 24, sw: 1 });
    } else {
      s.line({ x1: 546, y1: y + 17, x2: 722, y2: y + 17, color: T.absent, sw: 1, dash: 'dot' });
    }
    const st = tone === 'fresh' ? 'FRESH' : tone === 'stale' ? 'STALE' : 'ABSENT';
    s.chip({ x: 748, y: y + 8, w: 78, h: 18, label: st, tone, size: 8 });
    if (tone === 'absent') {
      s.line({ x1: 852, y1: y + 17, x2: 938, y2: y + 17, color: T.absent, sw: 1, dash: 'dot' });
      s.text({ x: 946, y: y + 11, text: '—', size: 8.5, color: T.muted, family: 'mono' });
    } else {
      const frac = tone === 'stale' ? 0 : Math.min(1, parseFloat(ttl) / 400);
      s.rect({ x: 852, y: y + 13, w: 86, h: 8, fill: T.panelAlt, stroke: T.border, sw: 1, radius: 2 });
      s.rect({ x: 852, y: y + 13, w: Math.max(2, 86 * frac), h: 8, fill: tone === 'stale' ? T.stale : T.fresh, stroke: 'none', sw: 0, radius: 2, opacity: 70 });
      s.text({ x: 946, y: y + 11, text: ttl, size: 8.5, color: tone === 'stale' ? T.stale : T.muted, family: 'mono' });
    }
    s.text({ x: 996, y: y + 11, text: prov, size: 9, color: T.muted, family: 'mono' });
    s.text({ x: 1200, y: y + 11, text: has, size: 9.5, color: has === '1' ? T.fg : T.muted, family: 'mono' });
    s.line({ x1: 56, y1: y + 34, x2: 1344, y2: y + 34, color: T.grid, sw: 1 });
  });

  s.text({ x: 68, y: 716, text: '⋮  其余 62 行在视口外（虚拟滚动，DOM/Canvas 仅保留可见行）', size: 8.5, color: T.muted });

  /* 脚注 */
  s.line({ x1: 40, y1: 818, x2: 1360, y2: 818, color: T.hair, sw: 1 });
  s.text({
    x: 40, y: 828, size: 10, color: T.inkMuted, lh: 1.6,
    text: '① 三态必须互斥且可分：fresh 的 0 值（绿色 ✓ FRESH 0.00）与 absent（∅ 点线，从未提供）绝不能显示成同一个东西。\n'
      + '② TTL 倒计时取自 profile signal_ttl（默认 400ms，profile 可覆盖）与 CMD1 元数据；STATE1 的 age_ms 是事实来源，signal_ttl 不在 STATE1 内。\n'
      + '③ provider 归属为推断（STATE1 无 provider 字段，标 ○）；id/name 表由 internal/signal/names.go 生成，UI 不硬编码 76 个名字；词表 append-only 🔒。',
  });

  return s;
}

/* ================================================================== */
/* 图 11-6：S6 输出可视化                                               */
/* ================================================================== */
function figOutput() {
  const s = new Scene({
    width: 1400, height: 900,
    title: '图 11-6  S6 输出可视化（功能 2.2 / 2.5）',
    subtitle: '双马达 + modulate 包络 · 音圈 synth/passthrough 波形与 25–180Hz 频谱 · 虚拟手柄外观（灯条 / 玩家灯 / 静音灯）· dry-run',
  });

  const c = s.ui({
    x: 40, y: 100, w: 1320, h: 700,
    title: 'S6 输出可视化（dry-run）',
    sub: '2.2 输出预览  ·  2.5 硬件回放',
    chips: [{ label: 'DRY-RUN', tone: 'stale', icon: '◇' }, { label: '125Hz', tone: 'info', icon: '' }],
    status: 'dry-run：不写硬件，仅渲染帧序列 · rate 125Hz · tick jitter p99 0.8ms · 输出摘要来自 STATE1 ~40B',
  });

  /* 双马达 */
  s.panel({ x: 56, y: 152, w: 644, h: 196, title: '双马达 + modulate 包络（正弦 / 方波）', badge: 'rumble L/R', badgeTone: 'accent' });
  const MX = (t) => 140 + 540 * t;
  ['L', 'R'].forEach((ch, lane) => {
    const base = lane === 0 ? 214 : 300;
    const amp = lane === 0 ? 34 : 22;
    s.text({ x: 68, y: base - 4, text: `rumble_${ch}`, size: 9, color: T.muted, family: 'mono' });
    s.line({ x1: 140, y1: base, x2: 680, y2: base, color: T.grid, sw: 1 });
    const pts = [];
    for (let i = 0; i <= 180; i++) {
      const t = i / 180;
      const env = 0.30 + 0.70 * Math.abs(Math.sin(t * Math.PI * 2 * 0.6 + lane));
      const v = lane === 0 ? Math.abs(Math.sin(t * Math.PI * 2 * 18)) : (Math.sin(t * Math.PI * 2 * 9) > 0 ? 1 : 0.15);
      pts.push([MX(t), base - v * env * amp]);
    }
    s.polyline({ points: pts, color: lane === 0 ? T.fresh : T.hold, sw: 1.3 });
    const envPts = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const env = 0.30 + 0.70 * Math.abs(Math.sin(t * Math.PI * 2 * 0.6 + lane));
      envPts.push([MX(t), base - env * amp]);
    }
    s.polyline({ points: envPts, color: T.stale, sw: 1.1, dash: 'dash' });
  });
  s.text({ x: 140, y: 336, text: '实线 = 输出值  虚线 = modulate 包络（正弦 / 方波）  ·  L 0.42 / R 0.31', size: 8.5, color: T.muted });

  /* 音圈 */
  s.panel({ x: 56, y: 364, w: 644, h: 240, title: '音圈触感：synth / passthrough 波形', badge: '25–180Hz', badgeTone: 'info' });
  const lanes = [
    ['synth', T.accent, 430, 60],
    ['passthrough', T.info, 520, 90],
  ];
  for (const [name, color, base, freq] of lanes) {
    s.text({ x: 68, y: base - 4, text: name, size: 9, color, family: 'mono' });
    s.line({ x1: 140, y1: base, x2: 680, y2: base, color: T.grid, sw: 1 });
    const pts = [];
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      const mod = 0.55 + 0.45 * Math.sin(t * Math.PI * 2 * 1.4);
      const noise = (Math.sin(t * Math.PI * 2 * freq * 1.7) * 0.18 + Math.sin(t * Math.PI * 2 * freq * 3.3) * 0.1);
      const v = name === 'synth' ? Math.sin(t * Math.PI * 2 * freq) : Math.sin(t * Math.PI * 2 * freq) * 0.7 + noise;
      pts.push([140 + 540 * t, base - v * mod * 32]);
    }
    s.polyline({ points: pts, color, sw: 1.3 });
  }
  s.text({ x: 140, y: 578, text: '采样窗口 200ms · 环形缓冲 600 点 · 绘制 ≤30fps，数据 125Hz', size: 8.5, color: T.muted });

  /* 频谱 */
  s.panel({ x: 56, y: 620, w: 644, h: 116, title: '频谱（关注 25–180Hz 带）', badge: 'FFT', badgeTone: 'plain' });
  s.rect({ x: 100, y: 656, w: 580, h: 60, fill: T.cooldown, stroke: 'none', sw: 0, radius: 0, opacity: 10 });
  for (let i = 0; i < 32; i++) {
    const f = 20 + i * 6;
    const hgt = Math.max(3, 52 * Math.exp(-Math.pow((f - 70) / 45, 2)) + 8 * Math.abs(Math.sin(i * 1.7)));
    s.rect({ x: 102 + i * 18, y: 716 - hgt, w: 12, h: hgt, fill: f >= 25 && f <= 180 ? T.info : T.absent, stroke: 'none', sw: 0, radius: 1, opacity: 75 });
  }
  s.text({ x: 100, y: 722, text: '25', size: 8, color: T.muted, family: 'mono' });
  s.text({ x: 680, y: 722, text: '180Hz＋', size: 8, color: T.muted, anchor: 'end', family: 'mono' });

  /* 虚拟手柄 */
  s.panel({ x: 716, y: 152, w: 628, h: 430, title: '虚拟手柄外观（灯条 / 5 颗玩家灯 / 静音灯）', badge: 'ControllerGlyph', badgeTone: 'accent' });
  s.ellipse({ cx: 828, cy: 382, rx: 54, ry: 78, fill: T.panelAlt, stroke: T.border, sw: 1 });
  s.ellipse({ cx: 1232, cy: 382, rx: 54, ry: 78, fill: T.panelAlt, stroke: T.border, sw: 1 });
  s.rect({ x: 796, y: 218, w: 468, h: 170, fill: T.panelAlt, stroke: T.border, sw: 1.4, radius: 64 });
  s.rect({ x: 974, y: 232, w: 112, h: 64, fill: '#0E1220', stroke: T.border, sw: 1, radius: 6 });
  s.text({ x: 1030, y: 254, text: 'touchpad', size: 8, color: T.muted, anchor: 'middle' });
  s.rect({ x: 944, y: 234, w: 22, h: 60, fill: '#FF4020', stroke: '#FF4020', sw: 1, radius: 3 });
  s.rect({ x: 1094, y: 234, w: 22, h: 60, fill: '#FF4020', stroke: '#FF4020', sw: 1, radius: 3 });
  s.text({ x: 1030, y: 226, text: '灯条 rgb(255, 64, 32)', size: 8.5, color: '#FF7A5A', anchor: 'middle', family: 'mono' });
  for (let i = 0; i < 5; i++) {
    const on = i === 2;
    s.ellipse({ cx: 986 + i * 22, cy: 316, rx: 5, ry: 5, fill: on ? T.fg : T.border, stroke: on ? T.fg : T.border, sw: 1 });
  }
  s.text({ x: 1030, y: 338, text: 'player_leds 0x04 → 第 3 颗亮', size: 8.5, color: T.muted, anchor: 'middle', family: 'mono' });
  s.ellipse({ cx: 890, cy: 352, rx: 26, ry: 26, fill: '#0E1220', stroke: T.border, sw: 1 });
  s.ellipse({ cx: 1170, cy: 352, rx: 26, ry: 26, fill: '#0E1220', stroke: T.border, sw: 1 });
  s.text({ x: 890, y: 348, text: 'L', size: 9, color: T.muted, anchor: 'middle', family: 'mono' });
  s.text({ x: 1170, y: 348, text: 'R', size: 9, color: T.muted, anchor: 'middle', family: 'mono' });
  s.ellipse({ cx: 1030, cy: 362, rx: 7, ry: 7, fill: T.stale, stroke: T.stale, sw: 1 });
  s.text({ x: 1030, y: 396, text: 'mute 灯 ON', size: 8.5, color: T.stale, anchor: 'middle' });
  s.text({ x: 732, y: 552, text: '灯条与玩家灯来自 STATE1 输出摘要；Glyph 只读，不可点击（避免误以为可写硬件）', size: 9, color: T.muted });

  /* 输出摘要 */
  s.panel({ x: 716, y: 596, w: 628, h: 140, title: '输出摘要（STATE1 ~40B）', badge: 'DRY-RUN', badgeTone: 'stale' });
  const summary = [
    ['L2', 'mode weapon · P[06 B4 5A 2A 00]'],
    ['R2', 'mode rigid · P[00 00 00 00 00]'],
    ['rumble', 'L 0.42 · R 0.31'],
    ['lightbar', 'rgb(255, 64, 32)'],
    ['player_leds', '0x04 (bit2) · mute ON'],
  ];
  summary.forEach(([k, v], i) => {
    const y = 636 + i * 19;
    s.text({ x: 728, y, text: k, size: 9, color: T.muted, family: 'mono' });
    s.text({ x: 812, y, text: v, size: 9, color: T.fg, family: 'mono' });
  });

  /* 脚注 */
  s.line({ x1: 40, y1: 818, x2: 1360, y2: 818, color: T.hair, sw: 1 });
  s.text({
    x: 40, y: 828, size: 10, color: T.inkMuted, lh: 1.6,
    text: '① dry-run 不打开 hidraw：所有波形来自 STATE1 输出摘要的回放/仿真帧，因此 macOS 与无设备环境同样可用（§六 跨平台降级）。\n'
      + '② 波形与频谱只用于「辨识差异」，不追求测量精度：采样窗口、缓冲长度、绘制帧率全部标注在面板内，避免误读为示波器。\n'
      + '③ 2.5 硬件回放复用同一画布：把录像帧序列按 tick 精度重放，画布显示「计划帧 vs 实际帧」的双轨，中标志中止。',
  });

  return s;
}

/* ================================================================== */
/* 图 11-7：S1 概览 Dashboard（高保真稿）                               */
/* ================================================================== */
function figDashboard() {
  const s = new Scene({
    width: 1600, height: 1000,
    title: '图 11-7  S1 概览 Dashboard（高保真稿）',
    subtitle: '连接状态 · 当前 profile · 实时关键信号 · 最近规则触发 · 健康度；首屏只回答「现在能不能调参、问题在哪一层」',
  });

  const c = s.ui({
    x: 40, y: 100, w: 1520, h: 800,
    title: 'S1 概览',
    sub: '1.1 设备面板 · 1.4 事件流 · 1.5 录像',
    chips: [{ label: 'LIVE', tone: 'fresh' }, { label: 'USB', tone: 'plain', icon: '' }, { label: 'REC', tone: 'error', icon: '●' }],
    status: 'seq 184223 · lag 12ms · jitter p99 0.8ms · drop 0 · hid_err 0 · uptime 01:42:07 · rc 0 · loopback 127.0.0.1:9997 · strict on',
  });

  /* 左 rail 压缩版 */
  s.line({ x1: 232, y1: 152, x2: 232, y2: 840, color: T.border, sw: 1 });
  s.text({ x: 56, y: 168, text: '导航', size: 9.5, color: T.muted });
  ['S1 Dashboard', 'S2 Input', 'S3 Signals', 'S4 Rules', 'S5 Trigger', 'S6 Output', 'S7 Profile', 'S8 Calibrator', 'S9 Aim', 'S10 Peripherals'].forEach((n, i) => {
    const y = 192 + i * 26, act = i === 0;
    if (act) {
      s.rect({ x: 56, y: y - 4, w: 168, h: 24, fill: T.panelAlt, stroke: T.panelAlt, sw: 0, radius: 5 });
      s.line({ x1: 56, y1: y - 4, x2: 58, y2: y + 20, color: T.accent, sw: 3 });
    }
    s.text({ x: 68, y, text: n, size: 11, color: act ? T.fg : T.muted, weight: act ? 700 : 400 });
  });
  s.line({ x1: 56, y1: 476, x2: 216, y2: 476, color: T.border, sw: 1 });
  s.text({ x: 56, y: 490, text: '快捷键', size: 9.5, color: T.muted });
  ['1..0  切屏', 'space  暂停', 'R  录制', 'B  A/B', 'Esc  取消预览'].forEach((k, i) => {
    s.text({ x: 56, y: 510 + i * 20, text: k, size: 9.5, color: T.fg, family: 'mono' });
  });
  s.chip({ x: 56, y: 620, w: 96, h: 20, label: 'dry-run off', tone: 'plain', size: 8.5, icon: '' });
  s.text({ x: 56, y: 654, text: 'hid.claim 仅「写权」按钮', size: 8.5, color: T.muted });
  s.text({ x: 56, y: 670, text: '请求，GUI 不 open hidraw', size: 8.5, color: T.muted });

  const X0 = 256;
  /* 三张状态卡 */
  const tiles = [
    { x: X0, t: '连接状态', big: 'LIVE', tone: 'fresh', lines: ['hidraw /dev/hidraw3 · USB', 'VID:PID 054C:0CE6 · BT off', '写失败 0 · 重连 0 次'] },
    { x: X0 + 428, t: '当前 profile', big: 'fps-aim', tone: 'accent', lines: ['mtime 12:04:31 · hash 9f3a…', '规则 6 · 信号覆盖 41/76', '严格校验：1 未知键'] },
    { x: X0 + 856, t: '健康度', big: '98%', tone: 'fresh', lines: ['状态流 60Hz · 丢帧 0', '序列化 0.4ms / 预算 1ms', 'CPU 2.1% · 内存 148MB'] },
  ];
  tiles.forEach((tile) => {
    s.rect({ x: tile.x, y: 164, w: 412, h: 156, fill: T.panel, stroke: T.border, sw: 1, radius: 10 });
    s.text({ x: tile.x + 16, y: 176, text: tile.t, size: 10.5, color: T.muted });
    s.text({ x: tile.x + 16, y: 194, text: tile.big, size: 26, color: T.fg, family: 'mono', weight: 700 });
    s.chip({ x: tile.x + 412 - 92, y: 200, w: 78, h: 18, label: tile.tone === 'fresh' ? 'HEALTHY' : 'CHECK', tone: tile.tone === 'accent' ? 'stale' : tile.tone, size: 8.5, icon: '' });
    tile.lines.forEach((ln, i) => {
      s.text({ x: tile.x + 16, y: 232 + i * 22, text: ln, size: 9.5, color: T.muted, family: 'mono' });
    });
  });

  /* 实时关键信号 */
  s.panel({ x: X0, y: 336, w: 830, h: 268, title: '实时关键信号（按消费热度取前 6）', badge: 'STT1 60Hz', badgeTone: 'info' });
  const sigs = [
    ['l2', '0.63', 'fresh', T.fresh, 41],
    ['r2', '0.00', 'fresh', T.fresh, 12],
    ['speed', '0.00', 'stale', T.stale, 77],
    ['brake', '0.31', 'fresh', T.fresh, 23],
    ['lx', '0.42', 'fresh', T.fresh, 55],
    ['gyro_x', '12.4', 'fresh', T.fresh, 91],
  ];
  sigs.forEach(([name, val, tone, color, seed], i) => {
    const y = 376 + i * 36;
    s.text({ x: 268, y: y + 6, text: name, size: 10.5, color: tone === 'stale' ? T.stale : T.fg, family: 'mono' });
    s.text({ x: 340, y: y + 6, text: val, size: 10.5, color: T.fg, family: 'mono' });
    s.spark({ x: 404, y: y, w: 480, h: 22, seed, color, n: 36, sw: 1.2 });
    s.chip({ x: 890, y: y + 1, w: 74, h: 18, label: tone === 'stale' ? 'STALE' : 'FRESH', tone, size: 8 });
    s.text({ x: 1062, y: y + 6, text: tone === 'stale' ? 'TTL 0ms' : 'TTL 388ms', size: 8.5, color: tone === 'stale' ? T.stale : T.muted, family: 'mono', anchor: 'end' });
  });
  s.line({ x1: 268, y1: 376, x2: 1058, y2: 376, color: T.grid, sw: 1 });

  /* 最近规则触发 */
  s.panel({ x: X0 + 846, y: 336, w: 422, h: 268, title: '最近规则触发（倒序）', badge: '3.1 三态', badgeTone: 'accent' });
  const fires = [
    ['l2_weapon', 'TRUE', 'true', 'just now'],
    ['brake_rigid', 'FALSE', 'false', '−0.2s'],
    ['audio_speak', 'STALE', 'stale', '−0.4s'],
    ['rumble_hold', 'HOLD', 'hold', '−0.6s'],
    ['radio_voice', 'COOLDOWN', 'cooldown', '−1.0s'],
  ];
  fires.forEach(([name, st, tone, ago], i) => {
    const y = 376 + i * 34;
    s.text({ x: X0 + 862, y: y + 3, text: name, size: 10, color: T.fg, family: 'mono' });
    s.chip({ x: X0 + 1000, y, w: 88, h: 18, label: st, tone, size: 8 });
    s.text({ x: X0 + 1248, y: y + 3, text: ago, size: 8.5, color: T.muted, anchor: 'end', family: 'mono' });
    s.line({ x1: X0 + 862, y1: y + 24, x2: X0 + 1248, y2: y + 24, color: T.grid, sw: 1 });
  });
  s.text({ x: X0 + 862, y: 560, text: '点击任一行 → S4 Inspector（保留当前时间基）', size: 8.5, color: T.accent });

  /* 健康度趋势 */
  s.panel({ x: X0, y: 618, w: 830, h: 214, title: '健康度趋势（5min · 定长环形缓冲 300 点）', badge: 'p99 jitter', badgeTone: 'plain' });
  s.axis({ x: 268, y: 658, w: 800, h: 122, yTicks: 2, xLabels: [{ p: 0.25 }, { p: 0.5 }, { p: 0.75 }] });
  s.spark({ x: 268, y: 658, w: 800, h: 122, seed: 61, color: T.fresh, n: 90, amp: 0.78, sw: 1.4 });
  s.spark({ x: 268, y: 658, w: 800, h: 122, seed: 83, color: T.stale, n: 90, amp: 0.42, sw: 1.2 });
  s.text({ x: 268, y: 796, text: 'tick jitter p99 0.8ms（预算 2ms）· 状态流丢帧 0 · 序列化 0.4ms（预算 1ms）· 60Hz 下 UI 58fps', size: 9, color: T.muted });

  /* 会话与录像 */
  s.panel({ x: X0 + 846, y: 618, w: 422, h: 214, title: '会话与录像（1.5）', badge: 'REC', badgeTone: 'error' });
  s.text({ x: X0 + 862, y: 662, text: '● REC 00:02:14', size: 11, color: T.error, family: 'mono', weight: 700 });
  s.text({ x: X0 + 862, y: 686, text: 'session-20261022-120431.stt1', size: 9, color: T.muted, family: 'mono' });
  s.text({ x: X0 + 862, y: 704, text: '4.2 MB · 60Hz · 状态流 + 输出帧', size: 9, color: T.muted, family: 'mono' });
  s.chip({ x: X0 + 862, y: 720, w: 90, h: 18, label: 'pause', tone: 'plain', size: 8, icon: '⏸' });
  s.chip({ x: X0 + 958, y: 720, w: 90, h: 18, label: '回放', tone: 'accent', size: 8, icon: '▶' });
  s.chip({ x: X0 + 1054, y: 720, w: 118, h: 18, label: '导出快照', tone: 'info', size: 8, icon: '⤓' });
  s.text({ x: X0 + 862, y: 758, text: '回放是 macOS / 无设备环境的数据源（§六）', size: 8.5, color: T.muted });
  s.text({ x: X0 + 862, y: 776, text: 'hid.claim / hid.release 只在「写权」按钮出现', size: 8.5, color: T.muted });

  /* 脚注 */
  s.line({ x1: 40, y1: 922, x2: 1560, y2: 922, color: T.hair, sw: 1 });
  s.text({
    x: 40, y: 934, size: 10, color: T.inkMuted, lh: 1.6,
    text: '首屏判定顺序：① 有没有设备（LIVE / 只读 / dry-run）→ ② profile 是否合法（未知键即报错）→ ③ 关键信号是否 fresh → ④ 最近规则触发是否符合预期。'
      + '四步都不需要打开终端。\nS1 只画 hid.claim / hid.release 的「请求」按钮，绝不直接 open hidraw：ds5d 是唯一 owner（§5.2）。',
  });

  return s;
}

/* ============================ 入口 ============================ */
const FIGURES = {
  ia: { name: 'dualsense-c-gui-01-ia', build: figIA },
  input: { name: 'dualsense-c-gui-02-input', build: figInput },
  trigger: { name: 'dualsense-c-gui-03-trigger', build: figTrigger },
  rules: { name: 'dualsense-c-gui-04-rules', build: figRules },
  signals: { name: 'dualsense-c-gui-05-signals', build: figSignals },
  output: { name: 'dualsense-c-gui-06-output', build: figOutput },
  dashboard: { name: 'dualsense-c-gui-07-dashboard', build: figDashboard },
};

function main() {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  const only = arg ? arg.slice('--only='.length).split(',').filter(Boolean) : [];
  const keys = only.length ? only : Object.keys(FIGURES);
  for (const k of keys) {
    const fig = FIGURES[k];
    if (!fig) throw new Error(`未知图：${k}（可选：${Object.keys(FIGURES).join(', ')}）`);
    const paths = fig.build().write(fig.name);
    const kb = (fs.statSync(paths[2]).size / 1024).toFixed(0);
    console.log(`✓ ${path.basename(paths[0])}  +.svg  +.png (${kb} KB)`);
  }
}

main();
