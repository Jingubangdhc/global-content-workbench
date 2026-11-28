/**
 * FIX-F02 · 分享文本与短链接安全提取工具
 * - 支持直接粘贴完整抖音/B站/YouTube/小红书/知乎分享文本（含分享口令、日期、e@o.Du 等非网址字符）
 * - 仅允许 http:// 与 https:// 协议，拒绝 bytedance://、snssdk://、javascript: 等非预期协议
 * - 若包含多个链接，返回全部候选链接供人工选择
 */

const ALLOWED_HOST_SUFFIXES = [
  'douyin.com',
  'iesdouyin.com',
  'youtube.com',
  'youtu.be',
  'bilibili.com',
  'b23.tv',
  'xiaohongshu.com',
  'xhslink.com',
  'zhihu.com',
  'tiktok.com',
  'baidu.com',
  'google.com',
  'reddit.com',
  'oceanengine.com',
];

export interface ExtractedShareLinks {
  urls: string[];
  rejectedUrls: string[];
  rawInput: string;
}

export function isAllowedWebUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
  } catch {
    return false;
  }
}

export function extractShareLinks(rawText: string): ExtractedShareLinks {
  const input = (rawText || '').trim();
  if (!input) return { urls: [], rejectedUrls: [], rawInput: '' };

  // 匹配 http(s) 网址，忽略中文标点、括号、引号及空白字符
  const matches = input.match(/https?:\/\/[^\s<>"'，。！？、；：（）【】《》]+/gi) || [];
  const urls: string[] = [];
  const rejectedUrls: string[] = [];
  const seen = new Set<string>();

  for (const m of matches) {
    const cleaned = m.replace(/[.,;:!?)\]}'"，。！？、；：）】》]+$/, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    if (isAllowedWebUrl(cleaned)) {
      urls.push(cleaned);
    } else {
      rejectedUrls.push(cleaned);
    }
  }
  return { urls, rejectedUrls, rawInput: input };
}
