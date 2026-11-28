import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * KOUBO-SKILL-P2 · 独立原创 ChatCut/Remotion JSX 动效组件：P2SignalOrbitCard（因果信号轨道卡）
 *
 * 特点：
 * - 完全自主原创，非换色或静态图；
 * - 使用 useCurrentFrame() + spring() + SVG strokeDashoffset 实现确定性逐帧因果路径动画；
 * - 支持参数化 SPEC（标题、3 个逻辑节点、强调色、出现时刻）与口播关键词触发。
 */
const SPEC = /*SPEC*/ {
  "component": "P2SignalOrbitCard",
  "version": "1.0.0",
  "dur": 7.0,
  "kicker": "原创 JSX 动效 · 因果信号轨道",
  "title": "视觉结构如何锁住完播率",
  "accent": "#B98732",
  "bg": "rgba(250, 248, 244, 0.96)",
  "ink": "#2B2620",
  "nodes": [
    {"tag": "01 因", "title": "抽象概念难消化", "sub": "纯口播缺少视觉锚点", "at": 0.4},
    {"tag": "02 桥", "title": "动态结构即时翻译", "sub": "关键词逐帧触发画面", "at": 2.2},
    {"tag": "03 果", "title": "观众看懂且看完", "sub": "完播与信任同步提升", "at": 4.2}
  ]
} /*END*/;

export default function P2SignalOrbitCard() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const dur = SPEC.dur || 7.0;

  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 130 } });
  const exitOpacity = interpolate(t, [dur - 0.35, dur], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cardY = interpolate(enter, [0, 1], [-48, 0]);
  const lineProgress = interpolate(t, [0.4, 4.4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pathLen = 680;
  const dashOffset = pathLen * (1 - lineProgress);

  return (
    <AbsoluteFill style={{ pointerEvents: "none", fontFamily: '"Noto Sans SC", "PingFang SC", sans-serif' }}>
      <div
        style={{
          position: "absolute",
          top: 165,
          left: 64,
          right: 64,
          transform: `translateY(${cardY}px)`,
          opacity: enter * exitOpacity,
          background: SPEC.bg || "#FAF8F4",
          border: `2px solid ${SPEC.accent || "#B98732"}`,
          borderRadius: 28,
          padding: "30px 34px 34px",
          boxShadow: "0 20px 52px rgba(43, 38, 32, 0.22)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 99,
              background: SPEC.accent || "#B98732",
              display: "inline-block",
            }}
          />
          <span style={{ fontSize: 22, fontWeight: 700, color: SPEC.accent || "#B98732", letterSpacing: 1 }}>
            {SPEC.kicker}
          </span>
        </div>

        <div style={{ fontSize: 40, fontWeight: 800, color: SPEC.ink || "#2B2620", marginBottom: 22 }}>
          {SPEC.title}
        </div>

        {/* 动态 SVG 因果信号轨道 */}
        <svg width="884" height="58" viewBox="0 0 884 58" style={{ display: "block", marginBottom: 14 }}>
          <path d="M 30 29 C 210 29, 240 29, 442 29 C 644 29, 674 29, 854 29" fill="none" stroke="#E5DCCB" strokeWidth="6" strokeLinecap="round" />
          <path
            d="M 30 29 C 210 29, 240 29, 442 29 C 644 29, 674 29, 854 29"
            fill="none"
            stroke={SPEC.accent || "#B98732"}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={pathLen}
            strokeDashoffset={dashOffset}
          />
          {[30, 442, 854].map((cx, idx) => {
            const nodeAt = (SPEC.nodes[idx]?.at ?? idx * 1.6);
            const s = spring({ frame: Math.max(0, Math.round((t - nodeAt) * fps)), fps, config: { damping: 14, stiffness: 160 } });
            const active = t >= nodeAt;
            return (
              <g key={idx}>
                <circle cx={cx} cy={29} r={active ? 14 + 4 * Math.sin(frame * 0.18) : 10} fill={active ? (SPEC.accent || "#B98732") : "#D8CFC0"} opacity={active ? 0.25 : 0.4} />
                <circle cx={cx} cy={29} r={9 * (active ? Math.max(0.5, s) : 0.7)} fill={active ? (SPEC.accent || "#B98732") : "#B9B0A2"} />
              </g>
            );
          })}
        </svg>

        {/* 三节点卡片 */}
        <div style={{ display: "flex", gap: 18 }}>
          {(SPEC.nodes || []).map((n, idx) => {
            const localF = Math.max(0, Math.round((t - (n.at || 0)) * fps));
            const pop = t >= (n.at || 0) ? spring({ frame: localF, fps, config: { damping: 15, stiffness: 150 } }) : 0;
            const yOff = interpolate(pop, [0, 1], [24, 0]);
            return (
              <div
                key={idx}
                style={{
                  flex: 1,
                  opacity: interpolate(pop, [0, 1], [0.22, 1]),
                  transform: `translateY(${yOff}px)`,
                  background: "#FFFFFF",
                  border: `1.5px solid ${pop > 0.5 ? (SPEC.accent || "#B98732") : "#E7DFD1"}`,
                  borderRadius: 18,
                  padding: "16px 18px",
                }}
              >
                <div style={{ fontSize: 20, fontWeight: 700, color: SPEC.accent || "#B98732", marginBottom: 6 }}>{n.tag}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: SPEC.ink || "#2B2620", marginBottom: 4 }}>{n.title}</div>
                <div style={{ fontSize: 20, color: "#6E655A", lineHeight: 1.35 }}>{n.sub}</div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}
