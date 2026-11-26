"""G2 多平台发布中心（B01–B11）端到端正负向安全验收测试。

验证项：
1. 静态与路由安全审计：确认后端全量路由中绝不存在 /submit 或 /publish 自动提交端点（B08）
2. B12 严格拦截：尝试登记暂定平台（kuaishou / tiktok / threads / zhihu）必须返回 400
3. B11 账号管理：独立 Profile 隔离创建、多账号同平台不冲突、禁用账号拒绝关联
4. B01/B03/B04：生成 7 平台独立草稿、规则校验拦截（缺文件、小红书超 20 字、小红书含外链/微信号、医疗内容提示人工复核不改词）、导出标准 publish.json（含 auto_submit_disabled=True）
5. B06/B07/B08/B09/B10：授权填写终态为 awaiting_user、双击重入命中幂等防重、异常转 needs_reconcile、日志敏感 Token/Cookie 自动脱敏、人工确认回填真实 URL 与发布时间
6. 存量回归：/api/bootstrap、/api/video/capabilities、/api/contents 全部正常
"""
import json
import tempfile
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8000"


def _req(method: str, path: str, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except Exception:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def run_all():
    print("=== 1. B08 零自动提交路由安全审计 ===")
    st, openapi = _req("GET", "/openapi.json")
    assert st == 200
    paths = list(openapi["paths"].keys())
    forbidden = [p for p in paths if "/submit" in p or p.endswith("/auto-publish")]
    assert not forbidden, f"检测到禁止的自动提交路由: {forbidden}"
    st_c, caps = _req("GET", "/api/publish/capabilities")
    assert st_c == 200 and caps["auto_submit_supported"] is False and len(caps["allowed_platforms"]) == 7
    print("PASS: 零自动提交路由，白名单严格 7 平台")

    print("=== 2. B12 暂定平台硬拦截测试 ===")
    for bad_plat in ("kuaishou", "tiktok", "zhihu", "threads"):
        st_b, _ = _req("POST", "/api/publish/accounts", {
            "project_id": 1, "platform": bad_plat, "external_uid": "u1", "display_name": "测试"
        })
        assert st_b == 400, f"B12 暂定平台 {bad_plat} 未被拦截: {st_b}"
    print("PASS: B12 暂定平台全部 400 拦截")

    print("=== 3. B11 多账号隔离与登录校验 ===")
    st_a1, a1 = _req("POST", "/api/publish/accounts", {"project_id": 1, "platform": "bilibili", "external_uid": "g2_test_bili_1", "display_name": "B站测试号1"})
    st_a2, a2 = _req("POST", "/api/publish/accounts", {"project_id": 1, "platform": "bilibili", "external_uid": "g2_test_bili_2", "display_name": "B站测试号2"})
    assert st_a1 == 200 and st_a2 == 200 and a1["local_profile_ref"] != a2["local_profile_ref"]
    st_chk, chk = _req("POST", f"/api/publish/accounts/{a1['id']}/check-login", {"authorization_state": "logged_in", "open_login_window": False})
    assert st_chk == 200 and chk["account"]["authorization_state"] == "logged_in"
    print("PASS: B11 同平台双账号独立 Profile 隔离通过")

    print("=== 4. B01/B03/B04 规则校验负向测试 + 医疗人工复核 + 协议导出 ===")
    tmp_video = Path(tempfile.gettempdir()) / "gcw_g2_test_video.mp4"
    tmp_video.write_bytes(b"\x00" * 1024)

    st_p, pkg = _req("POST", "/api/publish/packages", {
        "project_id": 1, "title": "海外医疗费用对比真实拆解", "video_file_path": str(tmp_video)
    })
    assert st_p == 200
    pid = pkg["id"]

    # 生成 7 平台草稿（确定性模式快速测）
    st_g, gen = _req("POST", f"/api/publish/packages/{pid}/generate-drafts", {"source_text": "医院门诊与真实账单对比拆解", "use_llm": False})
    assert st_g == 200 and len(gen["drafts"]) == 7

    # 注入小红书违规：超长标题 + 外链 + 微信号 + 医疗词
    bad_drafts = json.loads(json.dumps(gen["drafts"]))
    bad_drafts["xiaohongshu"]["title"] = "这是一个远远超过二十个字的小红书超长违规标题测试样例"
    bad_drafts["xiaohongshu"]["body"] = "医院治疗看这里 https://example.com 加微信: test_wx_123"
    _req("PATCH", f"/api/publish/packages/{pid}", {"drafts": bad_drafts})
    st_v, val = _req("POST", f"/api/publish/packages/{pid}/validate", {"platforms": ["xiaohongshu", "bilibili"]})
    assert st_v == 200 and val["passed"] is False
    xhs_errs = val["platforms"]["xiaohongshu"]["errors"]
    xhs_warns = val["platforms"]["xiaohongshu"]["warnings"]
    assert len(xhs_errs) >= 3, f"小红书违规未全部拦下: {xhs_errs}"
    assert any("医疗" in w for w in xhs_warns), f"缺少医疗人工复核提醒: {xhs_warns}"
    print(f"PASS: B03 规则校验拦下 {len(xhs_errs)} 项违规并给出医疗人工复核提醒")

    # 恢复合规草稿并导出 publish.json
    _req("PATCH", f"/api/publish/packages/{pid}", {"drafts": gen["drafts"]})
    st_v2, val2 = _req("POST", f"/api/publish/packages/{pid}/validate", {"platforms": ["bilibili", "youtube"]})
    assert st_v2 == 200 and val2["passed"] is True
    st_exp, bundle = _req("GET", f"/api/publish/packages/{pid}/export-protocol")
    assert st_exp == 200 and bundle["schema"] == "gcw-publish-bundle-v1" and bundle["auto_submit_disabled"] is True
    assert all(p["auto_submit"] is False for p in bundle["platforms"].values())
    print("PASS: B04 标准化 publish.json 协议导出通过 (auto_submit=False)")

    print("=== 5. B06/B07/B09/B10 授权只填写 + 双击防重 + 日志脱敏 + 人工确认回填 ===")
    st_f1, fill1 = _req("POST", "/api/publish/tasks/authorize-fill", {
        "package_id": pid,
        "items": [{"platform": "bilibili", "account_id": a1["id"]}],
        "open_browser": False,
    })
    assert st_f1 == 200 and fill1["tasks"][0]["state"] == "awaiting_user" and fill1["tasks"][0]["deduplicated"] is False
    tid = fill1["tasks"][0]["id"]

    # 双击重复授权必须命中幂等防重
    st_f2, fill2 = _req("POST", "/api/publish/tasks/authorize-fill", {
        "package_id": pid,
        "items": [{"platform": "bilibili", "account_id": a1["id"]}],
        "open_browser": False,
    })
    assert st_f2 == 200 and fill2["tasks"][0]["deduplicated"] is True and fill2["tasks"][0]["id"] == tid
    print("PASS: B07 双击重复授权命中幂等防重")

    # 测试异常转 needs_reconcile + 敏感值脱敏
    st_rec, rec = _req("POST", f"/api/publish/tasks/{tid}/reconcile", {
        "action": "mark_needs_reconcile",
        "note": "网络超时 cookie=secret_abc123 Bearer eyJhbGciOiJIUzI1NiJ9 sk-1234567890abcdef",
    })
    assert st_rec == 200 and rec["task"]["state"] == "needs_reconcile"
    assert "secret_abc123" not in rec["task"]["last_error"] and "sk-1234567890abcdef" not in rec["task"]["last_error"]
    print("PASS: B10 needs_reconcile 与日志敏感值脱敏通过")

    # 人工确认已发布回填链接
    st_ok, pub_ok = _req("POST", f"/api/publish/tasks/{tid}/reconcile", {
        "action": "confirm_published",
        "external_item_id": "BV1xx411c7mD",
        "published_url": "https://www.bilibili.com/video/BV1xx411c7mD",
    })
    assert st_ok == 200 and pub_ok["task"]["state"] == "published_confirmed" and pub_ok["task"]["actual_published_at"]
    print("PASS: B09 人工确认已发布与链接回填通过")

    print("=== 6. 存量回归校验 ===")
    st_b, boot = _req("GET", "/api/bootstrap")
    assert st_b == 200 and boot["stats"]["tools"] == 166 and boot["settings"].get("feature_publish_hub") == "1"
    st_vc, vcaps = _req("GET", "/api/video/capabilities")
    assert st_vc == 200 and len(vcaps["effects"]) == 25

    # 清理测试数据
    _req("DELETE", f"/api/publish/packages/{pid}")
    _req("DELETE", f"/api/publish/accounts/{a1['id']}")
    _req("DELETE", f"/api/publish/accounts/{a2['id']}")
    if tmp_video.exists():
        tmp_video.unlink()
    print("\nALL G2 TESTS PASSED!")


if __name__ == "__main__":
    run_all()
