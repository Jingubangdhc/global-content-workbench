"""导出模块：支持 Markdown、Word (.docx) 与兼容原 SOP 表头的 Excel (.xlsx)。"""
import io
from docx import Document
import openpyxl


def build_markdown(content: dict, transcript: dict | None) -> str:
    tr = transcript or {}
    lines = [
        f"# {content.get('title') or '未命名素材'}",
        "",
        f"- **平台**：{content.get('platform', '')}",
        f"- **原链接**：{content.get('url', '')}",
        f"- **作者**：{content.get('creator_name') or '未知'}",
        f"- **播放量**：{content.get('view_count') if content.get('view_count') is not None else '待补'}",
        f"- **异常爆款倍数**：{(str(content['outlier_score']) + 'x') if content.get('outlier_score') else '—'}",
        f"- **收藏理由**：{content.get('collect_reason') or '—'}",
        "",
        "## 前 5 秒钩子与结构笔记",
        tr.get("hook_analysis") or "（待补充）",
        "",
        "## 我的二创改写稿",
        tr.get("my_draft_text") or "（待撰写）",
        "",
        "## 中文译文参考",
        tr.get("translated_zh") or "（未翻译）",
        "",
        "## 原始提取文案（只读存证）",
        tr.get("raw_text") or "（未提取）",
        "",
    ]
    return "\n".join(lines)


def build_docx_bytes(content: dict, transcript: dict | None) -> bytes:
    tr = transcript or {}
    doc = Document()
    doc.add_heading(content.get("title") or "未命名素材", level=1)
    doc.add_paragraph(
        f"平台：{content.get('platform', '')}  |  作者：{content.get('creator_name') or '未知'}  |  "
        f"播放：{content.get('view_count') if content.get('view_count') is not None else '待补'}  |  "
        f"异常倍数：{content.get('outlier_score') or '—'}"
    )
    doc.add_paragraph(f"原链接：{content.get('url', '')}")

    doc.add_heading("一、前 5 秒钩子与结构笔记", level=2)
    doc.add_paragraph(tr.get("hook_analysis") or "（待补充）")

    doc.add_heading("二、我的二创改写稿", level=2)
    doc.add_paragraph(tr.get("my_draft_text") or "（待撰写）")

    if tr.get("translated_zh"):
        doc.add_heading("三、中文译文参考", level=2)
        doc.add_paragraph(tr["translated_zh"])

    doc.add_heading("四、原始提取文案（只读存证）", level=2)
    doc.add_paragraph(tr.get("raw_text") or "（未提取）")

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def build_sop_excel_bytes(contents: list[dict], creators: list[dict]) -> bytes:
    """生成兼容 HuaHui SOP 的 05_对标账号 与 06_视频拆解 工作表。"""
    wb = openpyxl.Workbook()
    ws_vid = wb.active
    ws_vid.title = "06_视频拆解"
    ws_vid.append([
        "视频ID", "所属频道", "视频标题", "视频URL", "发布日期",
        "视频播放数", "该频道同类视频典型播放", "异常倍数",
        "前5秒钩子", "脚本结构类型", "收藏理由", "是否已提文案", "状态",
    ])
    for c in contents:
        ws_vid.append([
            f"V-{c['id']}",
            c.get("creator_name") or "",
            c.get("title") or "",
            c.get("url") or "",
            c.get("published_at") or "",
            c.get("view_count"),
            c.get("baseline_median_views"),
            c.get("outlier_score"),
            c.get("hook_analysis") or "",
            c.get("script_template_type") or "",
            c.get("collect_reason") or "",
            "是" if c.get("has_transcript") else "否",
            c.get("status") or "",
        ])

    ws_cr = wb.create_sheet("05_对标账号")
    ws_cr.append([
        "账号ID", "平台", "对标频道名", "频道链接", "粉丝数",
        "近期典型播放量", "已扫变现线索", "强项与备注", "收益观察备注",
    ])
    for cr in creators:
        ws_cr.append([
            f"C-{cr['id']}",
            cr.get("platform") or "",
            cr.get("name") or "",
            cr.get("profile_url") or "",
            cr.get("follower_count"),
            cr.get("baseline_median_views"),
            cr.get("monetization_tags") or "",
            cr.get("strengths_note") or "",
            cr.get("estimated_monthly_rev_note") or "",
        ])

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
