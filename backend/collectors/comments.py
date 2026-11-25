"""优化③：YouTube 高赞评论拉取（免 Key yt-dlp）+ 0-Token 提问句与高频痛点词统计。"""
import collections
import re

import yt_dlp

QUESTION_RE = re.compile(r"(\?|？|\bhow\b|\bwhy\b|\bwhat\b|\bwhere\b|\bcan i\b|\bcost\b|怎么|如何|多少|为什么|能不能|请问|哪里)", re.IGNORECASE)
STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "you", "are", "was", "have", "from", "not",
    "they", "your", "but", "what", "all", "can", "just", "like", "about", "more", "out",
    "would", "there", "their", "when", "who", "will", "how", "has", "been", "very", "really",
    "video", "thanks", "great", "good", "much", "also", "only", "even", "than", "into",
}


def fetch_video_comments(video_url: str, max_comments: int = 50) -> list[dict]:
    """免 API Key 拉取视频高赞评论（限制前 50 条以控制耗时与防风控）。"""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "getcomments": True,
        "socket_timeout": 25,
        "extractor_args": {
            "youtube": {
                "comment_sort": ["top"],
                "max_comments": [str(max_comments), str(max_comments), "0", "0"],
            }
        },
    }
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(video_url, download=False)
    raw_comments = (info or {}).get("comments") or []
    out = []
    for c in raw_comments[:max_comments]:
        txt = (c.get("text") or "").strip()
        if not txt:
            continue
        out.append({
            "platform_comment_id": str(c.get("id") or hash(txt)),
            "author": c.get("author") or "",
            "text": txt,
            "like_count": int(c.get("like_count") or 0),
            "is_question": 1 if QUESTION_RE.search(txt) else 0,
        })
    out.sort(key=lambda x: x["like_count"], reverse=True)
    return out


def summarize_comment_keywords(comments: list[dict], top_n: int = 15) -> list[dict]:
    """0-Token 纯程序统计英文词频与中文短词频，帮助快速发现重复痛点。"""
    counter = collections.Counter()
    for c in comments:
        t = c.get("text") or ""
        # 英文词
        for w in re.findall(r"[a-zA-Z]{3,}", t.lower()):
            if w not in STOPWORDS:
                counter[w] += 1
        # 中文 2-4 字片段简单统计
        for seg in re.findall(r"[\u4e00-\u9fff]{2,4}", t):
            counter[seg] += 1
    return [{"word": w, "count": n} for w, n in counter.most_common(top_n) if n >= 2]
