"""R1 统一动效注册中心自动化验收测试。"""
import json
import urllib.error
import urllib.request

from backend.db import get_conn

BASE = "http://127.0.0.1:8000"


def _req(method: str, path: str, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def run_all():
    print("=== 1. 存量核心接口回归 ===")
    st, boot = _req("GET", "/api/bootstrap")
    assert st == 200 and boot["stats"]["tools"] == 166
    st_c, contents = _req("GET", "/api/contents")
    assert st_c == 200 and len(contents) == 17
    print("PASS: 存量回归 (166 tools, 17 contents)")

    print("=== 2. 统一可执行动效资产核验 ===")
    st, res = _req("GET", "/api/motion/assets?status=approved")
    assert st == 200 and res["asset_class"] == "executable"
    items = res["items"]
    native_cnt = sum(1 for x in items if x["engine_type"] == "overlay_native")
    builtin_cnt = sum(1 for x in items if x["engine_type"] == "motion_lab_builtin")
    assert native_cnt == 25, f"Expected 25 native assets, got {native_cnt}"
    assert builtin_cnt >= 5, f"Expected >=5 lab builtin assets, got {builtin_cnt}"
    # 校验 11 项必填元数据存在
    sample = items[0]
    for key in (
        "asset_id", "version", "engine_type", "skeleton_spec", "params_schema",
        "narrative_purposes", "default_content", "default_skin", "sound_cues",
        "timeline_behavior", "capabilities", "source_type", "license_note", "status",
    ):
        assert key in sample, f"Missing protocol key: {key}"
    print(f"PASS: 统一注册中心已纳管 {native_cnt} 原版卡 + {builtin_cnt} 工坊卡（总计 {len(items)} 张可执行已验收资产）")

    print("=== 3. 严禁 reference_only 与空 DSL 混入反测 ===")
    st_ref, err_ref = _req("POST", "/api/motion/assets", {
        "asset_id": "fake:atlas-1bit",
        "name": "伪装参考图",
        "engine_type": "motion_lab_dsl",
        "asset_class": "reference_only",
        "is_executable": False,
    })
    assert st_ref == 400, f"Expected 400 for reference_only, got {st_ref}"
    st_dsl, err_dsl = _req("POST", "/api/motion/assets", {
        "asset_id": "fake:empty-dsl",
        "name": "空图元 DSL",
        "engine_type": "motion_lab_dsl",
        "skeleton_spec": {"dsl": {"layers": []}},
    })
    assert st_dsl == 400, f"Expected 400 for empty DSL, got {st_dsl}"
    print("PASS: 成功拦截 reference_only 与空图层 DSL 伪资产")

    print("=== 4. 新 DSL 资产创建、不可变版本与状态流转 ===")
    test_id = "lab:r1-smoke-dsl"
    st_add, added = _req("POST", "/api/motion/assets", {
        "asset_id": test_id,
        "version": "1.0.0",
        "name": "R1 冒烟测试 DSL",
        "engine_type": "motion_lab_dsl",
        "group_id": "G20",
        "skeleton_spec": {"dsl": {"version": 1, "layers": [{"id": "core", "type": "circle", "x": 640, "y": 360, "r": 50}]}},
        "narrative_purposes": ["relation_graph"],
        "source_type": "ai_dsl_original",
        "status": "draft",
        "change_note": "R1 smoke create",
    })
    assert st_add == 200 and added["asset"]["status"] == "draft"
    st_p, patched = _req("PATCH", f"/api/motion/assets/{test_id}/status", {"status": "approved", "note": "R1 smoke approve"})
    assert st_p == 200 and patched["asset"]["status"] == "approved"
    st_d, detail = _req("GET", f"/api/motion/assets/{test_id}")
    assert st_d == 200 and len(detail["asset"]["versions"]) >= 1
    print("PASS: 新 DSL 资产注册、状态流转与版本快照校验通过")

    print("=== 5. 28 组覆盖率 + 参考资料分离接口 + 研发任务单 ===")
    st_g, grp = _req("GET", "/api/motion/groups")
    assert st_g == 200 and grp["total_groups"] == 28 and grp["approved_executable_assets"] >= 30
    st_r1, ref_atlas = _req("GET", "/api/motion/references?source=atlas&limit=3")
    st_r2, ref_motion = _req("GET", "/api/motion/references?source=motion&limit=3")
    assert st_r1 == 200 and ref_atlas["asset_class"] == "reference_only" and ref_atlas["total"] == 504
    assert st_r2 == 200 and ref_motion["asset_class"] == "reference_only" and ref_motion["total"] == 264
    st_t, task = _req("POST", "/api/motion/tasks", {
        "title": "四分支商业关系动画",
        "requirement_prompt": "中央圆核+4条贝塞尔连线+4分支卡片",
        "group_id": "G20",
    })
    assert st_t == 200 and task["task"]["status"] == "open"
    print(f"PASS: 28 组覆盖 {grp['covered_groups']}/28 组；参考层严格分离（504 Atlas + 264 Motion）；任务单创建成功")

    # 清理本次冒烟写入的临时测试记录
    conn = get_conn()
    conn.execute("DELETE FROM motion_assets WHERE asset_id = ?", (test_id,))
    conn.execute("DELETE FROM motion_dev_tasks WHERE task_uid = ?", (task["task"]["task_uid"],))
    conn.commit()
    conn.close()
    print("\nALL R1 MOTION REGISTRY TESTS PASSED!")


if __name__ == "__main__":
    run_all()
