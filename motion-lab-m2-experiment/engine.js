/**
 * AI Motion & Style Lab · M2 纯函数确定性动效白模解耦引擎
 *
 * 强制技术规范：
 * 1. 100% 纯函数时间驱动：renderFrame(ctx, W, H, t, duration, state) 仅依赖输入时间 t 与参数，
 *    绝不使用 performance.now()、setInterval 或自播放 CSS 动画。
 * 2. 支持任意时间点暂停定位、正向/反向连续拖动、以及预览与透明导出像素级一致。
 * 3. 六层严格解耦：Content / Layout / Skeleton / Skin / Sound / Style DNA。
 */

export const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export const segProgress = (u, a, b) => clamp((u - a) / Math.max(0.0001, b - a), 0, 1);

export const EASINGS = {
  linear: (x) => x,
  easeOutCubic: (x) => 1 - Math.pow(1 - x, 3),
  easeInCubic: (x) => x * x * x,
  easeOutQuart: (x) => 1 - Math.pow(1 - x, 4),
  easeOutExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  easeOutBackSoft: (x) => {
    const c1 = 1.15;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
};

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawSurface(ctx, x, y, w, h, skin, dna) {
  const t = skin.tokens;
  const r = t.radius * (dna.radius_scale ?? 1);
  ctx.save();
  if (t.shadow && t.shadow !== 'none') {
    ctx.shadowColor = skin.id === 'cyber_glass' ? 'rgba(34,211,238,0.28)' : 'rgba(15,23,42,0.14)';
    ctx.shadowBlur = skin.id === 'cyber_glass' ? 28 : 26;
    ctx.shadowOffsetY = skin.id === 'cyber_glass' ? 0 : 12;
  }
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = t.surface_bg;
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.lineWidth = t.border_width || 1;
  ctx.strokeStyle = t.border_color;
  if (t.border_style === 'dashed') ctx.setLineDash([8, 6]);
  ctx.stroke();
  ctx.restore();
}

function drawWireframeGuides(ctx, x, y, w, h, phaseName, u, motionVector) {
  ctx.save();
  // 十字中心辅助线
  ctx.strokeStyle = 'rgba(107,114,128,0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y - 24);
  ctx.lineTo(x + w / 2, y + h + 24);
  ctx.moveTo(x - 24, y + h / 2);
  ctx.lineTo(x + w + 24, y + h / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // 顶部骨架遥测标尺
  ctx.fillStyle = '#374151';
  ctx.font = '600 13px "JetBrains Mono", Consolas, monospace';
  ctx.fillText(`WIREFRAME · PHASE: ${phaseName} · u=${u.toFixed(3)} · ${motionVector}`, x, y - 10);
  ctx.restore();
}

/** 骨架 1：数值实证递增骨架 (stat_counter) */
function renderStatCounter(ctx, W, H, u, skin, content, dna) {
  const t = skin.tokens;
  const accent = dna.accent_override || t.accent_primary;
  const amp = dna.motion_intensity ?? 1;

  const enterP = EASINGS.easeOutCubic(segProgress(u, 0.0, 0.18));
  const countP = EASINGS.easeOutExpo(segProgress(u, 0.12, 0.72));
  const exitP = EASINGS.easeInCubic(segProgress(u, 0.90, 1.0));

  const opacity = enterP * (1 - exitP);
  const offsetY = (1 - enterP) * 32 * amp - exitP * 18 * amp;
  const scale = 0.94 + 0.06 * enterP;
  const phase = u < 0.18 ? 'ENTER' : u < 0.72 ? 'COUNT_AND_RING' : u < 0.90 ? 'HOLD' : 'EXIT';

  const cardW = 760;
  const cardH = 340;
  const cx = W / 2;
  const cy = H / 2;

  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);
  ctx.translate(cx, cy + offsetY);
  ctx.scale(scale, scale);

  const x = -cardW / 2;
  const y = -cardH / 2;
  drawSurface(ctx, x, y, cardW, cardH, skin, dna);

  // 左侧文字与超大数字
  ctx.fillStyle = accent;
  ctx.font = `700 18px ${t.font_display}`;
  ctx.fillText(String(content.kicker || 'MARKET SIGNAL'), x + 44, y + 64);

  const targetVal = Number(content.value ?? 18.6);
  const curVal = targetVal * countP;
  const formatted = Number.isInteger(targetVal) ? Math.round(curVal).toString() : curVal.toFixed(1);
  ctx.fillStyle = t.text_primary;
  ctx.font = `800 96px ${t.font_display}`;
  ctx.fillText(`${content.prefix || ''}${formatted}${content.suffix || ''}`, x + 40, y + 178);

  ctx.fillStyle = t.text_secondary;
  ctx.font = `600 24px ${t.font_body}`;
  ctx.fillText(String(content.label || ''), x + 44, y + 236);

  ctx.fillStyle = t.text_muted;
  ctx.font = `400 16px ${t.font_body}`;
  ctx.fillText(`来源：${content.source || '真实实测样本'}`, x + 44, y + 286);

  // 右侧环形表盘（纯角度插值）
  const rx = x + cardW - 140;
  const ry = y + cardH / 2;
  const rad = 82;
  const pct = clamp(Number(content.percent ?? 84), 0, 100);
  const sweep = (pct / 100) * countP * Math.PI * 2;

  ctx.beginPath();
  ctx.arc(rx, ry, rad, 0, Math.PI * 2);
  ctx.lineWidth = 16;
  ctx.strokeStyle = t.surface_alt;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(rx, ry, rad, -Math.PI / 2, -Math.PI / 2 + sweep);
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  ctx.strokeStyle = accent;
  ctx.stroke();

  ctx.fillStyle = t.text_primary;
  ctx.font = `700 30px ${t.font_display}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(pct * countP)}%`, rx, ry + 10);
  ctx.textAlign = 'left';

  if (t.show_motion_guides) {
    drawWireframeGuides(ctx, x, y, cardW, cardH, phase, u, `dy=${offsetY.toFixed(1)}px count=${(countP * 100).toFixed(0)}%`);
  }
  ctx.restore();
}

/** 骨架 2：阶梯柱状生长骨架 (bar_race_rank) */
function renderBarRaceRank(ctx, W, H, u, skin, content, dna) {
  const t = skin.tokens;
  const accent = dna.accent_override || t.accent_primary;
  const amp = dna.motion_intensity ?? 1;

  const titleP = EASINGS.easeOutCubic(segProgress(u, 0.0, 0.14));
  const exitP = EASINGS.easeInCubic(segProgress(u, 0.90, 1.0));
  const opacity = titleP * (1 - exitP);
  const phase = u < 0.14 ? 'HEADER_ENTER' : u < 0.78 ? 'STAGGER_BARS' : u < 0.90 ? 'HOLD' : 'EXIT';

  const rows = String(content.rows_text || '真实账单对比:92|医院实地探访:74|流程避坑指南:58|纯口播科普:31')
    .split('|')
    .map((s) => {
      const [name, val] = s.split(':');
      return { name: (name || '').trim(), val: Math.max(1, Number(val) || 10) };
    })
    .slice(0, 5);
  const maxVal = Math.max(...rows.map((r) => r.val), 1);

  const cardW = 860;
  const cardH = 150 + rows.length * 68;
  const x = (W - cardW) / 2;
  const y = (H - cardH) / 2;

  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);
  drawSurface(ctx, x, y, cardW, cardH, skin, dna);

  ctx.fillStyle = t.text_primary;
  ctx.font = `700 28px ${t.font_display}`;
  ctx.fillText(String(content.title || '多维排行对比'), x + 40 + (1 - titleP) * -28 * amp, y + 60);

  const barMaxW = cardW - 310;
  const barRadius = Math.min(8, t.radius * (dna.radius_scale ?? 1));

  rows.forEach((row, idx) => {
    const startU = 0.12 + idx * 0.08;
    const rowP = EASINGS.easeOutQuart(segProgress(u, startU, startU + 0.36));
    const ry = y + 98 + idx * 66;

    ctx.save();
    ctx.globalAlpha = clamp(opacity * rowP, 0, 1);
    ctx.fillStyle = t.text_secondary;
    ctx.font = `600 20px ${t.font_body}`;
    ctx.fillText(`${idx + 1}. ${row.name}`, x + 40, ry + 26);

    // 轨道背景
    roundRectPath(ctx, x + 220, ry + 6, barMaxW, 28, barRadius);
    ctx.fillStyle = t.surface_alt;
    ctx.fill();

    // 生长柱
    const bw = Math.max(8, (row.val / maxVal) * barMaxW * rowP);
    roundRectPath(ctx, x + 220, ry + 6, bw, 28, barRadius);
    ctx.fillStyle = idx === 0 ? accent : t.accent_secondary;
    ctx.fill();

    // 实时递增数字
    ctx.fillStyle = t.text_primary;
    ctx.font = `700 20px ${t.font_display}`;
    ctx.fillText(`${(row.val * rowP).toFixed(0)}${content.unit || ''}`, x + 234 + bw, ry + 27);
    ctx.restore();
  });

  ctx.fillStyle = t.text_muted;
  ctx.font = `400 15px ${t.font_body}`;
  ctx.fillText(String(content.source || ''), x + 40, y + cardH - 22);

  if (t.show_motion_guides) {
    drawWireframeGuides(ctx, x, y, cardW, cardH, phase, u, `rows=${rows.length} stagger=0.08`);
  }
  ctx.restore();
}

/** 骨架 3：焦点金句逐块浮现骨架 (callout_reveal) */
function renderCalloutReveal(ctx, W, H, u, skin, content, dna) {
  const t = skin.tokens;
  const accent = dna.accent_override || t.accent_primary;
  const amp = dna.motion_intensity ?? 1;

  const enterP = EASINGS.easeOutCubic(segProgress(u, 0.0, 0.16));
  const metaP = EASINGS.easeOutCubic(segProgress(u, 0.58, 0.80));
  const exitP = EASINGS.easeInCubic(segProgress(u, 0.90, 1.0));
  const opacity = enterP * (1 - exitP);
  const phase = u < 0.16 ? 'ACCENT_BAR' : u < 0.72 ? 'CHUNK_FOCUS' : u < 0.90 ? 'META_REVEAL' : 'EXIT';

  const chunks = String(content.chunks_text || '动效骨架决定节奏|视觉皮肤决定调性|*解耦后可无限混搭*')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);

  const cardW = 860;
  const cardH = 190 + chunks.length * 68;
  const x = (W - cardW) / 2;
  const y = (H - cardH) / 2;

  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);
  drawSurface(ctx, x, y, cardW, cardH, skin, dna);

  // 左侧竖向引导条生长
  const barH = (cardH - 72) * enterP;
  roundRectPath(ctx, x + 36, y + 36, 7, barH, 4);
  ctx.fillStyle = accent;
  ctx.fill();

  // 顶部标签
  ctx.fillStyle = accent;
  ctx.font = `700 17px ${t.font_display}`;
  ctx.fillText(String(content.badge || '核心洞察'), x + 64, y + 62);

  // 逐块聚焦清晰浮现（纯函数计算模糊半径与位移）
  chunks.forEach((raw, idx) => {
    const startU = 0.10 + idx * 0.14;
    const cp = EASINGS.easeOutExpo(segProgress(u, startU, startU + 0.28));
    const isHl = raw.startsWith('*') && raw.endsWith('*');
    const clean = isHl ? raw.slice(1, -1) : raw;
    const cy = y + 124 + idx * 66 + (1 - cp) * 26 * amp;
    const blurPx = (1 - cp) * 10;

    ctx.save();
    ctx.globalAlpha = clamp(opacity * cp, 0, 1);
    if (blurPx > 0.3 && typeof ctx.filter === 'string') {
      ctx.filter = `blur(${blurPx.toFixed(1)}px)`;
    }
    ctx.fillStyle = isHl ? accent : t.text_primary;
    ctx.font = `${isHl ? 800 : 700} 42px ${t.font_display}`;
    ctx.fillText(clean, x + 64, cy);
    ctx.restore();
  });

  // 署名浮现
  ctx.save();
  ctx.globalAlpha = clamp(opacity * metaP, 0, 1);
  ctx.fillStyle = t.text_muted;
  ctx.font = `500 18px ${t.font_body}`;
  ctx.fillText(`—— ${content.author || ''}`, x + 64 + (1 - metaP) * -16 * amp, y + cardH - 34);
  ctx.restore();

  if (t.show_motion_guides) {
    drawWireframeGuides(ctx, x, y, cardW, cardH, phase, u, `chunks=${chunks.length} barH=${barH.toFixed(0)}px`);
  }
  ctx.restore();
}

/** 骨架 4：双栏对撞对比骨架 (versus_split) */
function renderVersusSplit(ctx, W, H, u, skin, content, dna) {
  const t = skin.tokens;
  const accent = dna.accent_override || t.accent_primary;
  const amp = dna.motion_intensity ?? 1;

  const colP = EASINGS.easeOutBackSoft(segProgress(u, 0.0, 0.28));
  const vsP = EASINGS.easeOutExpo(segProgress(u, 0.22, 0.42));
  const winP = EASINGS.easeOutCubic(segProgress(u, 0.46, 0.72));
  const exitP = EASINGS.easeInCubic(segProgress(u, 0.90, 1.0));
  const opacity = clamp(segProgress(u, 0.0, 0.12), 0, 1) * (1 - exitP);
  const phase = u < 0.28 ? 'COLLIDE' : u < 0.46 ? 'VS_BADGE' : u < 0.90 ? 'WINNER_GLOW' : 'EXIT';

  const cardW = 400;
  const cardH = 300;
  const gap = 64;
  const cy = H / 2 - cardH / 2;
  const leftTargetX = W / 2 - gap / 2 - cardW;
  const rightTargetX = W / 2 + gap / 2;

  const leftX = leftTargetX - (1 - colP) * 140 * amp;
  const rightX = rightTargetX + (1 - colP) * 140 * amp;
  const winner = content.winner || 'right';

  ctx.save();
  // 左卡
  ctx.save();
  const leftDim = winner === 'right' ? 1 - 0.3 * winP : 1;
  ctx.globalAlpha = clamp(opacity * leftDim, 0, 1);
  drawSurface(ctx, leftX, cy, cardW, cardH, skin, dna);
  ctx.fillStyle = t.text_muted;
  ctx.font = `700 16px ${t.font_display}`;
  ctx.fillText(String(content.left_kicker || '方案 A'), leftX + 32, cy + 58);
  ctx.fillStyle = t.text_primary;
  ctx.font = `800 32px ${t.font_display}`;
  ctx.fillText(String(content.left_title || '旧方案'), leftX + 32, cy + 132);
  ctx.fillStyle = t.text_secondary;
  ctx.font = `400 20px ${t.font_body}`;
  ctx.fillText(String(content.left_sub || ''), leftX + 32, cy + 198);
  ctx.restore();

  // 右卡
  ctx.save();
  const rightDim = winner === 'left' ? 1 - 0.3 * winP : 1;
  ctx.globalAlpha = clamp(opacity * rightDim, 0, 1);
  drawSurface(ctx, rightX, cy, cardW, cardH, skin, dna);
  if (winner === 'right' && winP > 0.05) {
    ctx.save();
    roundRectPath(ctx, rightX, cy, cardW, cardH, t.radius * (dna.radius_scale ?? 1));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3 * winP;
    ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = accent;
  ctx.font = `700 16px ${t.font_display}`;
  ctx.fillText(String(content.right_kicker || '方案 B'), rightX + 32, cy + 58);
  ctx.fillStyle = t.text_primary;
  ctx.font = `800 32px ${t.font_display}`;
  ctx.fillText(String(content.right_title || '新方案'), rightX + 32, cy + 132);
  ctx.fillStyle = t.text_secondary;
  ctx.font = `400 20px ${t.font_body}`;
  ctx.fillText(String(content.right_sub || ''), rightX + 32, cy + 198);
  ctx.restore();

  // 中央 VS 徽章
  ctx.save();
  ctx.globalAlpha = clamp(opacity * vsP, 0, 1);
  ctx.translate(W / 2, H / 2);
  ctx.scale(0.3 + 0.7 * vsP, 0.3 + 0.7 * vsP);
  ctx.rotate(((1 - vsP) * -25 * Math.PI) / 180);
  ctx.beginPath();
  ctx.arc(0, 0, 40, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `900 26px ${t.font_display}`;
  ctx.textAlign = 'center';
  ctx.fillText('VS', 0, 9);
  ctx.restore();

  if (t.show_motion_guides) {
    drawWireframeGuides(ctx, leftTargetX, cy, cardW * 2 + gap, cardH, phase, u, `colP=${colP.toFixed(2)} vsP=${vsP.toFixed(2)}`);
  }
  ctx.restore();
}

/** 骨架 5：步骤流程清单骨架 (step_flow_list · 还原《三步出片》高清矢量级结构) */
function renderStepFlowList(ctx, W, H, u, skin, content, dna) {
  const t = skin.tokens;
  const accent = dna.accent_override || t.accent_primary;
  const amp = dna.motion_intensity ?? 1;

  const enterP = EASINGS.easeOutCubic(segProgress(u, 0.0, 0.16));
  const underlineP = EASINGS.easeOutQuart(segProgress(u, 0.12, 0.30));
  const stepsP = segProgress(u, 0.22, 0.80);
  const exitP = EASINGS.easeInCubic(segProgress(u, 0.90, 1.0));

  const opacity = enterP * (1 - exitP);
  const offsetY = (1 - enterP) * 24 * amp - exitP * 16 * amp;
  const phase = u < 0.16 ? 'HEADER_ENTER' : u < 0.30 ? 'UNDERLINE_DRAW' : u < 0.80 ? 'STEPS_CASCADE' : u < 0.90 ? 'HOLD' : 'EXIT';

  const steps = String(content.steps_text || '丢一份字幕稿|AI 按语义编排|一键透明导出')
    .split('|').map((s) => s.trim()).filter(Boolean).slice(0, 5);

  const cardW = 720;
  const cardH = Math.max(410, 225 + steps.length * 76);
  const x = (W - cardW) / 2;
  const y = (H - cardH) / 2 + offsetY;

  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);
  drawSurface(ctx, x, y, cardW, cardH, skin, dna);

  // 1. 眉题（前缀高亮 + 后缀次要灰）
  const kickerAccent = String(content.kicker_accent || '出片流程');
  const kickerSub = String(content.kicker_sub || ` · 共 ${steps.length} 部分`);
  ctx.font = `700 22px ${t.font_display}`;
  ctx.fillStyle = accent;
  ctx.fillText(kickerAccent, x + 48, y + 66);
  const kaW = ctx.measureText(kickerAccent).width;
  ctx.fillStyle = t.text_muted;
  ctx.font = `500 22px ${t.font_body}`;
  ctx.fillText(kickerSub, x + 48 + kaW, y + 66);

  // 2. 主标题（支持 *高亮词* 着色 + 动态绘制粗圆角下划线）
  const rawTitle = String(content.title || '《*三步*出片》');
  const parts = rawTitle.split(/(\*[^*]+\*)/g).filter(Boolean);
  ctx.font = `900 54px ${t.font_display}`;
  let curX = x + 44;
  const titleY = y + 136;
  parts.forEach((seg) => {
    const isHl = seg.startsWith('*') && seg.endsWith('*');
    const txt = isHl ? seg.slice(1, -1) : seg;
    const w = ctx.measureText(txt).width;
    ctx.fillStyle = isHl ? accent : t.text_primary;
    ctx.fillText(txt, curX, titleY);
    if (isHl && underlineP > 0.01) {
      ctx.save();
      ctx.fillStyle = accent;
      roundRectPath(ctx, curX + 2, titleY + 12, Math.max(4, (w - 4) * underlineP), 6, 3);
      ctx.fill();
      ctx.restore();
    }
    curX += w;
  });

  // 3. 横向细分割线（随 underlineP 展开）
  ctx.save();
  ctx.strokeStyle = t.border_color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 48, y + 178);
  ctx.lineTo(x + 48 + (cardW - 96) * underlineP, y + 178);
  ctx.stroke();
  ctx.restore();

  // 4. 纵向时间轨道线 + 逐条依次点亮的序号步骤
  const listTop = y + 236;
  const rowGap = 76;
  const nodeX = x + 76;

  if (steps.length > 1) {
    const lineEnd = listTop + (steps.length - 1) * rowGap;
    ctx.save();
    ctx.strokeStyle = t.border_color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nodeX, listTop + 14);
    ctx.lineTo(nodeX, lineEnd);
    ctx.stroke();
    ctx.restore();
  }

  const activeIdx = Math.min(steps.length - 1, Math.floor(stepsP * steps.length));
  steps.forEach((label, i) => {
    const itemP = EASINGS.easeOutCubic(segProgress(stepsP, i * 0.20, i * 0.20 + 0.35));
    const ry = listTop + i * rowGap + (1 - itemP) * 16 * amp;
    const isActive = i === activeIdx;

    ctx.save();
    ctx.globalAlpha = clamp(opacity * itemP * (isActive ? 1 : 0.52), 0, 1);

    // 圆形节点
    ctx.beginPath();
    ctx.arc(nodeX, ry - 10, 13, 0, Math.PI * 2);
    ctx.fillStyle = t.surface_bg;
    ctx.fill();
    ctx.lineWidth = isActive ? 2.5 : 1.8;
    ctx.strokeStyle = isActive ? accent : t.text_muted;
    ctx.stroke();
    if (isActive) {
      ctx.beginPath();
      ctx.arc(nodeX, ry - 10, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }

    // 两位序号
    ctx.fillStyle = isActive ? accent : t.text_muted;
    ctx.font = `700 22px "JetBrains Mono", Consolas, monospace`;
    ctx.fillText(String(i + 1).padStart(2, '0'), nodeX + 32, ry - 3);

    // 步骤文案
    ctx.fillStyle = isActive ? t.text_primary : t.text_secondary;
    ctx.font = `800 34px ${t.font_display}`;
    ctx.fillText(label, nodeX + 76, ry);
    ctx.restore();
  });

  if (t.show_motion_guides) {
    drawWireframeGuides(ctx, x, y, cardW, cardH, phase, u, `steps=${steps.length} active=${activeIdx + 1}`);
  }
  ctx.restore();
}

export function renderFrame(ctx, W, H, t, duration, skeletonId, skinObj, content, dna, transparentBg = false) {
  ctx.clearRect(0, 0, W, H);
  if (!transparentBg) {
    ctx.fillStyle = skinObj.tokens.stage_bg;
    ctx.fillRect(0, 0, W, H);
  }
  const u = clamp(t / Math.max(0.001, duration), 0, 1);
  if (skeletonId === 'stat_counter') renderStatCounter(ctx, W, H, u, skinObj, content, dna);
  else if (skeletonId === 'bar_race_rank') renderBarRaceRank(ctx, W, H, u, skinObj, content, dna);
  else if (skeletonId === 'callout_reveal') renderCalloutReveal(ctx, W, H, u, skinObj, content, dna);
  else if (skeletonId === 'versus_split') renderVersusSplit(ctx, W, H, u, skinObj, content, dna);
  else if (skeletonId === 'step_flow_list') renderStepFlowList(ctx, W, H, u, skinObj, content, dna);
}
