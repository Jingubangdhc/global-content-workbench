"""R3 / R4 / R5 强制业务验收测试（覆盖测试二、测试三、测试四、测试五）。

硬性要求：
- 测试二必须使用真实 LLM（use_llm=True），证明模型能动态检索并同时调用原版 25 卡与测试一新研发的工坊 DSL 卡；
- 测试三必须证明未批准 DNA 不生效、批准新 DNA 后编排主题/幅度/强调色真实变化、且可回滚；
- 测试四必须证明工坊新卡可挂载入工程时间轴并持久化版本；
- 测试五必须证明真实模型失败时显式标记 degraded_rule_fallback，绝不伪装成功。
"""
import json
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8000"


def _req(method: str, path: str, body=None):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


COMMERCIAL_SRT = """1
00:00:00,000 --> 00:00:04,500
今天我们拆解一套高转化内容电商的底层增长飞轮。

2
00:00:04,600 --> 00:00:10,500
过去90天我们统计了320个低粉爆款账号，平均异常播放倍数达到18.6倍，转化率提升42%。

3
00:00:10,600 --> 00:00:16,000
这里先停顿一下，大家先听我讲一个最容易踩坑的误区，画面保持安静即可。

4
00:00:16,100 --> 00:00:25,000
真正能跑通的商业闭环，本质是一个以核心业务引擎为中心的四分支商业关系网络：流量获取、内容转化、私域复购、商业变现四个分支协同运转，最终聚焦商业变现。

5
00:00:25,100 --> 00:00:32,000
总结起来就是三步落地：选对高潜赛道、用数据实证建立信任、把四分支闭环跑通。
"""


def run_all():
    evidence = {}

    # 创建验收视频工程
    st, proj = _req("POST", "/api/video/projects", {"project_id": 1, "title": "R3-R5强制业务验收工程", "aspect_ratio": "16:9"})
    assert st == 200
    vid = proj["id"]
    st, srt_res = _req("POST", f"/api/video/projects/{vid}/import-srt", {"srt_text": COMMERCIAL_SRT})
    assert st == 200 and srt_res["line_count"] == 5

    # ==================== 测试二：真实 LLM 视觉导演编排（调用原版 + 新研发 DSL 卡） ====================
    print("=== 测试二：真实 LLM 商业分析 SRT 导演编排 ===")
    st, comp1 = _req("POST", f"/api/video/projects/{vid}/compile", {"use_llm": True})
    assert st == 200, f"compile failed: {comp1}"
    meta1 = comp1["meta"]
    doc1 = comp1["doc"]
    assert meta1["execution_mode"] == "real_llm" and meta1["degraded"] is False
    assert meta1["total_tokens"] > 0
    assert len(doc1["cards"]) >= 1, "应至少调用 1 张原版 Overlay 动效卡"
    assert len(doc1.get("lab_cards", [])) >= 1, f"应至少调用 1 张工坊新增资产，实际：{doc1.get('lab_cards')}"
    has_quiet = any(s.get("purpose") == "keep_quiet" for s in (meta1.get("director_segments") or []))
    evidence["test2_real_llm_director"] = {
        "execution_mode": meta1["execution_mode"],
        "model": meta1["model"],
        "total_tokens": meta1["total_tokens"],
        "native_cards_count": len(doc1["cards"]),
        "native_kinds": [c["kind"] for c in doc1["cards"]],
        "lab_cards_count": len(doc1.get("lab_cards", [])),
        "used_lab_assets": meta1["used_lab_assets"],
        "has_keep_quiet_segment": has_quiet,
        "created_dev_tasks": meta1["created_dev_tasks"],
        "pass": True,
    }
    print(f"PASS 测试二: model={meta1['model']} tokens={meta1['total_tokens']} 原版卡={len(doc1['cards'])} 工坊新卡={meta1['used_lab_assets']} 留白判断={has_quiet}")

    # ==================== 测试三：统一 Style DNA 审批、编排变化与回滚 ====================
    print("=== 测试三：统一 Style DNA 未批准拦截 → 批准生效变化 → 一键回滚 ===")
    _, active_before = _req("GET", "/api/style-dna/active?project_id=1")
    orig_v = active_before["profile"]["version"]

    # 1. 创建未批准 draft，确认不影响当前生效 DNA
    st_dr, draft_dna = _req("POST", "/api/style-dna/versions", {
        "scope": "global", "status": "draft",
        "theme": "light", "motion_intensity": 0.82, "radius_scale": 1.35,
        "accent_primary": "#ea580c", "pacing_density": "minimal",
        "approved_rules": ["采用麦田浅色极简风格，减少卡片数量多留白"],
        "note": "R5 验收测试 v_light_minimal",
    })
    assert st_dr == 200
    new_v = draft_dna["profile"]["version"]
    _, active_still = _req("GET", "/api/style-dna/active?project_id=1")
    assert active_still["profile"]["version"] == orig_v, "未批准的 draft DNA 不得提前生效！"

    # 2. 显式批准 new_v，重新编排并验证画面/节奏配置真实变化
    st_ap, _ = _req("PATCH", f"/api/style-dna/versions/{new_v}/status", {"status": "approved", "scope": "global"})
    assert st_ap == 200
    st, comp2 = _req("POST", f"/api/video/projects/{vid}/compile", {"use_llm": True})
    assert st == 200
    doc2 = comp2["doc"]
    meta2 = comp2["meta"]
    assert doc2["theme"] == "light" and doc2["animSpeed"] == 0.82
    assert doc2["style_dna_applied"]["accent_primary"] == "#ea580c"
    assert doc2["style_dna_applied"]["pacing_density"] == "minimal"

    # 3. 回滚至 orig_v 验证恢复
    st_rb, rb = _req("POST", f"/api/style-dna/rollback/{orig_v}?scope=global")
    assert st_rb == 200 and rb["profile"]["version"] == orig_v
    evidence["test3_style_dna_change_and_rollback"] = {
        "orig_version": orig_v,
        "draft_blocked_before_approve": True,
        "approved_new_version": new_v,
        "before_dna": doc1["style_dna_applied"],
        "after_dna": doc2["style_dna_applied"],
        "rolled_back_to": rb["profile"]["version"],
        "pass": True,
    }
    print(f"PASS 测试三: 未批准拦截通过；批准 v{new_v} 后 theme={doc2['theme']}, animSpeed={doc2['animSpeed']}, accent=#ea580c；已回滚至 v{orig_v}")

    # ==================== 测试四（工坊新卡入轨工程与版本持久化） ====================
    print("=== 测试四：工坊新研发 DSL 卡直接挂载至视频工程时间轴 ===")
    target_lab_id = meta1["used_lab_assets"][0] if meta1["used_lab_assets"] else "lab:step_flow_list"
    st_att, att = _req("POST", f"/api/video/projects/{vid}/lab-cards", {
        "asset_id": target_lab_id, "start": 16.5, "end": 23.0,
        "note": "测试四人工挂载工坊卡片",
    })
    assert st_att == 200 and att["lab_card"]["asset_id"] == target_lab_id
    evidence["test4_lab_card_attach"] = {
        "attached_asset_id": target_lab_id,
        "version_no": att["version_no"],
        "lab_cards_total": att["lab_cards_total"],
        "pass": True,
    }
    print(f"PASS 测试四: 成功挂载 {target_lab_id} 至工程时间轴，生成不可变版本 v{att['version_no']}")

    # ==================== 测试五：真实模型调用失败时的显式降级标记 ====================
    print("=== 测试五：真实模型调用失败显式标记 degraded_rule_fallback ===")
    st_f, comp_fail = _req("POST", f"/api/video/projects/{vid}/compile", {"use_llm": True, "simulate_llm_failure": True})
    assert st_f == 200
    mf = comp_fail["meta"]
    assert mf["execution_mode"] == "degraded_rule_fallback" and mf["degraded"] is True and mf["used_llm"] is False
    assert mf["fallback_reason"] and "模拟" in mf["fallback_reason"]
    evidence["test5_director_degraded_explicit"] = {
        "execution_mode": mf["execution_mode"],
        "degraded": mf["degraded"],
        "used_llm": mf["used_llm"],
        "fallback_reason": mf["fallback_reason"],
        "pass": True,
    }
    print(f"PASS 测试五: 显式降级标识完整 ({mf['execution_mode']} | {mf['fallback_reason']})")

    # 清理本次临时验收工程，并落盘完整实测证据
    _req("DELETE", f"/api/video/projects/{vid}")
    out_file = Path("motion-lab-m2-experiment/reports/r3_r4_r5_verification_result.json")
    out_file.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nALL R3/R4/R5 ACCEPTANCE TESTS PASSED! Evidence -> {out_file}")


if __name__ == "__main__":
    run_all()
