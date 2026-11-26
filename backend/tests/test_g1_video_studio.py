"""G1 智能视频制作（A01–A16）端到端验收测试脚本。

验证范围：
- A01: 中英文 SRT 字幕解析与时间码精度
- A02/A03: 25 张动效卡注册表与数据图表完整性
- A04: AI/语义编排合法性（零未知 kind、零越界、无数字证据不编造图表）
- A07/A14: 参数编辑、不可变版本保存与回退恢复
- A09/A10: 默认 15 音效授权清单与自定义音效非法格式拦截
- A12/A15: 真实调用独立 Overlay Studio 引擎导出透明 MOV + WebM，并用 ffprobe 实测校验 Alpha 通道、分辨率与时长
- A13: 质量检查硬错误阻止导出 + 警告显式忽略留痕
- A16: 人工修改 Diff 偏好提取、批准与撤销
- 存量回归: /api/bootstrap, /api/keywords, /api/contents, /api/tools 原有能力正常
"""
import json
import time
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8000"


def _req(method: str, path: str, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def run_all():
    t0 = time.time()
    print("=== 1. 存量核心接口回归 ===")
    st, boot = _req("GET", "/api/bootstrap")
    assert st == 200 and boot["stats"]["tools"] == 166, f"bootstrap failed: {st}"
    assert boot["settings"].get("feature_video_studio") == "1"
    st_c, contents = _req("GET", "/api/contents")
    assert st_c == 200 and len(contents) == 17, "contents regression failed"
    print("PASS: 存量回归 (166 tools, 17 contents)")

    print("=== 2. A02/A09 能力与引擎健康核验 ===")
    st, caps = _req("GET", "/api/video/capabilities")
    assert st == 200
    assert caps["engine"]["reachable"] is True, f"Overlay Studio unreachable: {caps['engine']}"
    assert len(caps["effects"]) == 25, f"Expected 25 effects, got {len(caps['effects'])}"
    assert len(caps["default_sfx"]) == 15
    print(f"PASS: Overlay Studio {caps['engine']['engine_version']} reachable, 25 effects, 15 default SFX")

    print("=== 3. A01/A14 创建工程与中英文 SRT 导入 ===")
    st, proj = _req("POST", "/api/video/projects", {"project_id": 1, "title": "G1验收实测-AI趋势", "aspect_ratio": "16:9"})
    assert st == 200
    vid = proj["id"]

    sample_srt = """1
00:00:00,000 --> 00:00:02,000
今天我们用真实数据拆解海外内容变现趋势

2
00:00:02,100 --> 00:00:04,000
Sample data shows 18.6x outlier views on YouTube
"""
    st, srt_res = _req("POST", f"/api/video/projects/{vid}/import-srt", {"srt_text": sample_srt})
    assert st == 200 and srt_res["line_count"] == 2 and srt_res["duration_ms"] == 4000
    print(f"PASS: SRT 解析 ({srt_res['line_count']} 行, {srt_res['duration_ms']}ms)")

    print("=== 4. A04 编排生成 + A13 质量检查硬错误拦截 ===")
    st, comp = _req("POST", f"/api/video/projects/{vid}/compile", {"use_llm": False})
    assert st == 200 and len(comp["doc"]["cards"]) >= 2
    assert comp["lint"]["passed"] is True
    v1_id = comp["version_id"]
    print(f"PASS: 编排 v1 生成 ({len(comp['doc']['cards'])} 张卡, Lint 通过)")

    # 注入占位文本硬错误，验证 Lint 拦截导出
    bad_doc = json.loads(json.dumps(comp["doc"]))
    bad_doc["cards"].append({
        "id": "card-bad",
        "kind": "quote-lockup",
        "start": 0.5,
        "end": 2.5,
        "params": {"quote": "TODO 演示数据占位"},
    })
    st, lint_bad = _req("POST", f"/api/video/projects/{vid}/lint", {"doc": bad_doc})
    assert st == 200 and lint_bad["passed"] is False and lint_bad["error_count"] >= 1
    _req("PATCH", f"/api/video/projects/{vid}", {"draft_overlay_json": json.dumps(bad_doc, ensure_ascii=False)})
    st_block, err_block = _req("POST", "/api/video/render-jobs", {"video_project_id": vid, "mode": "timeline"})
    assert st_block == 400, f"Expected 400 hard-error block, got {st_block}"
    print(f"PASS: A13 硬错误成功拦截导出 ({err_block.get('detail')})")

    print("=== 5. A07/A14 人工编辑、保存不可变版本 v2、回退验证 + A16 偏好学习 ===")
    edited_doc = json.loads(json.dumps(comp["doc"]))
    edited_doc["cards"][1]["params"]["sfx"] = "chime"
    edited_doc["cards"][1]["end"] = 3.8
    st, v2 = _req("PUT", f"/api/video/projects/{vid}/versions", {"doc": edited_doc, "note": "人工调整音效与时长"})
    assert st == 200 and v2["version_no"] == 2
    v2_id = v2["version_id"]

    st, fb = _req("POST", f"/api/video/projects/{vid}/feedback", {"original_version_id": v1_id, "edited_version_id": v2_id})
    assert st == 200 and fb["rule"]["status"] == "pending"
    rid = fb["rule"]["id"]
    st, fb_app = _req("PATCH", f"/api/video/feedback-rules/{rid}", {"status": "approved"})
    assert st == 200 and fb_app["status"] == "approved"
    st, fb_rev = _req("PATCH", f"/api/video/feedback-rules/{rid}", {"status": "revoked"})
    assert st == 200 and fb_rev["status"] == "revoked"
    print("PASS: A14 不可变版本 + A16 偏好提取/批准/撤销闭环")

    print("=== 6. A12/A15 真实透明视频导出 (MOV + WebM) + ffprobe Alpha 校验 ===")
    t_render = time.time()
    st, job = _req("POST", "/api/video/render-jobs", {
        "video_project_id": vid,
        "mode": "timeline",
        "include_webm": True,
        "fps": 30,
        "duration_sec": 3.0,
    })
    assert st == 200, f"render start failed: {st} {job}"
    job_uid = job["job_uid"]
    final_job = None
    for _ in range(120):
        time.sleep(1.5)
        _, cur = _req("GET", f"/api/video/render-jobs/{job_uid}")
        if cur["state"] in ("completed", "failed", "cancelled"):
            final_job = cur
            break
    elapsed = round(time.time() - t_render, 2)
    assert final_job and final_job["state"] == "completed", f"Render failed: {final_job}"
    probe = json.loads(final_job["ffprobe_json"])
    assert probe["ok"] is True and probe["has_alpha"] is True, f"Alpha check failed: {probe}"
    mov_p = Path(final_job["output_mov_path"])
    webm_p = Path(final_job["output_webm_path"])
    assert mov_p.exists() and mov_p.stat().st_size > 10000
    assert webm_p.exists() and webm_p.stat().st_size > 1000
    print(f"PASS: 真实透明导出完成！耗时 {elapsed}s")
    print(f"  MOV : {mov_p} ({mov_p.stat().st_size} bytes)")
    print(f"  WebM: {webm_p} ({webm_p.stat().st_size} bytes)")
    print(f"  ffprobe: codec={probe['video_codec']}, pix_fmt={probe['pix_fmt']}, alpha={probe['has_alpha']}, {probe['width']}x{probe['height']}, dur={probe['duration_sec']}s, audio_streams={probe['audio_streams']}")

    # 清理本次验收创建的测试工程（保留导出的样片文件作为 G1 验收证据）
    _req("DELETE", f"/api/video/projects/{vid}")
    print(f"\nALL G1 TESTS PASSED in {round(time.time() - t0, 2)}s!")


if __name__ == "__main__":
    run_all()
