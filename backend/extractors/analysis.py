"""优化①：0-Token YouTube 最多重播热力高光提取 + 按次强锚定爆款拆解与引用校验。"""
import json
import os
import re

import yt_dlp
from openai import OpenAI


def fetch_youtube_heatmap_highlights(video_url: str, segments: list[dict] | None = None, top_k: int = 5) -> dict:
    """
    0-Token 底层逻辑：通过 yt-dlp 读取 YouTube 播放器的 Most Replayed (heatmap) 观众重播热力曲线，
    找出重播热度最高的 Top K 时间区间，并自动匹配带时间戳的字幕原文。
    """
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True, "socket_timeout": 20}) as y:
        info = y.extract_info(video_url, download=False)
    hm = (info or {}).get("heatmap") or []
    if not hm:
        return {"ok": False, "highlights": [], "message": "该视频播放量不足或平台未生成最多重播热力图（Most Replayed）。"}

    # 按热度值降序挑选互不紧邻的峰值段
    sorted_hm = sorted(hm, key=lambda x: float(x.get("value", 0)), reverse=True)
    picked = []
    for item in sorted_hm:
        st = float(item.get("start_time", 0))
        ed = float(item.get("end_time", st + 5))
        if any(abs(st - p["start_sec"]) < 12 for p in picked):
            continue
        snippet = ""
        if segments:
            matched = [
                s.get("text", "")
                for s in segments
                if st - 4 <= float(s.get("start", -999)) <= ed + 6
            ]
            snippet = " ".join(matched).strip()
        picked.append({
            "start_sec": round(st, 1),
            "end_sec": round(ed, 1),
            "heat": round(float(item.get("value", 0)), 3),
            "snippet": snippet or "（尚未提取带时间戳字幕，请先点击一键提取文案后重跑匹配）",
        })
        if len(picked) >= top_k:
            break

    return {"ok": True, "highlights": picked, "message": f"成功定位 {len(picked)} 个观众反复重播的高光片段"}


def _verify_quote_in_text(quote: str, raw_text: str) -> bool:
    """普通程序校验：检查 AI 声称引用的原文是否真实存在于原稿中（去除标点与多余空格后比对）。"""
    if not quote or not raw_text:
        return False
    norm = lambda s: re.sub(r"[\s\W_]+", "", s.lower())
    nq, nr = norm(quote), norm(raw_text)
    if len(nq) < 4:
        return False
    return nq in nr or nq[:18] in nr


def run_anchored_breakdown(raw_text: str, title: str = "") -> dict:
    """
    按次手动调用兼容 OpenAI 格式大模型进行强锚定爆款拆解与金句提取，
    并用普通程序逐条核验引用真实性，杜绝 AI 编造原文。
    """
    api_key = os.getenv("LLM_API_KEY", "").strip()
    base_url = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1").strip()
    model = os.getenv("LLM_MODEL", "deepseek-chat").strip()
    if not api_key:
        raise ValueError("尚未配置 LLM_API_KEY。请先在左下角【设置】中填入 DeepSeek / Gemini / OpenAI 兼容 Key。")

    client = OpenAI(api_key=api_key, base_url=base_url)
    snippet = raw_text[:10000]  # 控制单次 Token 成本
    prompt = f"""你是严谨的自媒体爆款文案分析师。请分析以下口播/文章原文（标题：{title}）。
严格要求：
1. 你看不到平台后台真实完播率与CTR，严禁编造因果断言，只能做“结构机制解释”。
2. 每一条 hook_quote、retention_mechanics.quote 和 quotes.text 都必须【一字不差】摘录自下方原文，严禁改写或杜撰！
3. 原文可能是任意语种（英/俄/西/法/日/韩等），所有分析说明请用【简体中文】输出，并对每条外语原话同步提供中文译文（*_zh 字段）。
4. 仅返回合法 JSON，不要任何 markdown 代码块标记，格式如下：
{{
  "hook_type": "前15秒钩子类型（如反常识提问/利益承诺/冲突故事）",
  "hook_quote": "原文开头的原话摘录",
  "hook_quote_zh": "hook_quote 的简体中文译文",
  "hook_why": "为什么能留住前15秒注意力（1-2句话）",
  "retention_mechanics": [
    {{"stage": "阶段名", "quote": "原文原话摘录", "quote_zh": "中文译文", "mechanism": "留存/叙事手法与可迁移模板"}}
  ],
  "business_angle": "潜在变现/转化角度或观众痛点",
  "quotes": [
    {{"text": "原文高传播金句原话", "text_zh": "金句简体中文译文", "category": "反常识|数字冲击|情绪共鸣|提问Hook", "usage": "适合做封面/开头/结尾"}}
  ]
}}

原文如下：
{snippet}"""

    resp = client.chat.completions.create(
        model=model,
        temperature=0.2,
        messages=[{"role": "user", "content": prompt}],
    )
    content = (resp.choices[0].message.content or "").strip()
    # 剥离可能残留的 ```json 包裹
    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.IGNORECASE).strip()
    data = json.loads(content)

    # 程序核验每一条引用是否真实存在于原文
    data["hook_verified"] = _verify_quote_in_text(data.get("hook_quote", ""), raw_text)
    for m in data.get("retention_mechanics") or []:
        m["verified"] = _verify_quote_in_text(m.get("quote", ""), raw_text)
    for q in data.get("quotes") or []:
        q["verified"] = _verify_quote_in_text(q.get("text", ""), raw_text)

    data["_meta"] = {
        "model": model,
        "total_tokens": resp.usage.total_tokens if resp.usage else None,
    }
    return data
