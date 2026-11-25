"""纯正则 0-Token 变现指纹扫描器：自动识别作者简介与视频描述区中的变现外链与私域线索。"""
import re
from urllib.parse import urlparse

URL_RE = re.compile(r"https?://[^\s<>\"'\]\)]+", re.IGNORECASE)
CODE_RE = re.compile(r"(?:code|coupon|promo|折扣码|优惠码)\s*[:：\-]?\s*([A-Z0-9]{3,16})", re.IGNORECASE)

# 排除常见纯内容平台域名，聚焦变现外链
SOCIAL_SKIP = {
    "youtube.com", "youtu.be", "tiktok.com", "douyin.com", "bilibili.com",
    "xiaohongshu.com", "instagram.com", "twitter.com", "x.com", "facebook.com",
    "weibo.com", "zhihu.com", "reddit.com", "google.com", "wikipedia.org",
}

AFFILIATE_DOMAINS = (
    "amzn.to", "amazon.", "rstyle.me", "go.magik.ly", "impact.", "sjv.io",
    "pxf.io", "shareasale.", "awin1.com", "linktr.ee", "beacons.ai",
    "stan.store", "hoo.be", "linkin.bio", "bit.ly", "tinyurl.com", "geni.us",
)

COURSE_DOMAINS = (
    "patreon.com", "substack.com", "gumroad.com", "skool.com", "teachable.com",
    "kajabi.com", "thinkific.com", "ko-fi.com", "buymeacoffee.com",
    "xiaoe-tech.com", "zsxq.com", "memberful.com", "whop.com",
)

DM_DOMAINS = (
    "wa.me", "whatsapp.com", "t.me", "telegram.me", "calendly.com",
    "cal.com", "typeform.com", "tally.so", "manychat.com", "line.me",
)

DM_KEYWORDS = (
    "whatsapp", "wechat", "微信", "加v", "私信", "咨询", "预约",
    "dm me", "book a call", "consultation", "free consult", "contact us",
)


def scan_monetization_signals(text: str) -> dict:
    """
    扫描简介或视频描述中的变现线索。
    返回结构：
    {
      "affiliate": [...],
      "course_sub": [...],
      "dm_lead": [...],
      "indie_sites": [...],
      "discount_codes": [...],
      "tags": [...]
    }
    """
    if not text:
        return {"affiliate": [], "course_sub": [], "dm_lead": [], "indie_sites": [], "discount_codes": [], "tags": []}

    raw_urls = list(dict.fromkeys(u.rstrip(".,;!?") for u in URL_RE.findall(text)))
    affiliate, course_sub, dm_lead, indie_sites = [], [], [], []
    seen_domains = set()

    for u in raw_urls:
        try:
            parsed = urlparse(u)
            host = parsed.netloc.lower().lstrip("www.")
        except Exception:
            continue
        if not host:
            continue

        if any(k in host for k in AFFILIATE_DOMAINS) or "tag=" in u.lower() or "aff" in parsed.query.lower():
            affiliate.append({"url": u, "domain": host})
        elif any(k in host for k in COURSE_DOMAINS):
            course_sub.append({"url": u, "domain": host})
        elif any(k in host for k in DM_DOMAINS):
            dm_lead.append({"url": u, "domain": host, "type": "link"})
        elif not any(host == s or host.endswith("." + s) for s in SOCIAL_SKIP):
            if host not in seen_domains:
                seen_domains.add(host)
                indie_sites.append({"url": u, "domain": host})

    low_text = text.lower()
    matched_dm_kw = [kw for kw in DM_KEYWORDS if kw in low_text]
    if matched_dm_kw:
        dm_lead.append({"keywords": matched_dm_kw[:6], "type": "keyword"})

    codes = list(dict.fromkeys(m.upper() for m in CODE_RE.findall(text)))[:6]

    tags = []
    if affiliate or codes:
        tags.append("联盟/带货外链")
    if course_sub:
        tags.append("知识付费/订阅")
    if indie_sites:
        tags.append("独立站/官网")
    if dm_lead:
        tags.append("私信/咨询获客")

    return {
        "affiliate": affiliate[:10],
        "course_sub": course_sub[:8],
        "dm_lead": dm_lead[:8],
        "indie_sites": indie_sites[:8],
        "discount_codes": codes,
        "tags": tags,
    }
