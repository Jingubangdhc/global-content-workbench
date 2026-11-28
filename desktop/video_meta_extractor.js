/**
 * GCW-STABLE-FIX-02 · 受控只读页面视频元数据提取脚本构造器
 * - 独立分离 rawPageUrl（原始页面 URL）与 canonicalUrl（规范化作品 URL），绝不对 const 重新赋值
 * - 精准识别用户当前正在观看的视频（兼容抖音精选页、搜索结果视频弹层、普通详情页，兼容播放态与暂停态）
 * - 区分完整提取（complete）、部分数据缺失（partial）与作品身份无法确认（identity_unverified）
 * - 独立导出便于自动化 JavaScript 异常回归测试直接执行
 */

function buildReadonlyVideoMetaScript() {
  return `
    (() => {
      const rawPageUrl = location.href || '';
      let canonicalUrl = rawPageUrl;
      const host = (location.hostname || '').toLowerCase();

      const getMeta = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.getAttribute('content') || '').trim() : '';
      };
      const getText = (sel, root = document) => {
        if (!root || !root.querySelector) return '';
        const el = root.querySelector(sel);
        return el ? (el.innerText || el.textContent || '').trim() : '';
      };

      // 计算元素在当前视口内的可见交集面积与距视口中心距离，避免误选推荐流第一个视频
      const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
      const vh = window.innerHeight || document.documentElement.clientHeight || 800;
      const getViewportScore = (el) => {
        if (!el || !el.getBoundingClientRect) return { visibleArea: 0, centerDist: 1e9 };
        const r = el.getBoundingClientRect();
        const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        const visibleArea = ix * iy;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const centerDist = Math.hypot(cx - vw / 2, cy - vh / 2);
        return { visibleArea, centerDist };
      };

      let ld = {};
      try {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          const parsed = JSON.parse(s.textContent || '{}');
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of arr) {
            if (item && (item['@type'] === 'VideoObject' || item.interactionStatistic)) {
              ld = item;
              break;
            }
          }
        }
      } catch (_) {}

      // 优先选择视口内正在播放的主 <video>；若均已暂停，则选视口可见面积最大且最居中的 <video>
      const vids = Array.from(document.querySelectorAll('video'));
      let mainVideo = null;
      let bestVideoScore = -1;
      for (const v of vids) {
        const { visibleArea, centerDist } = getViewportScore(v);
        const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
        const isPlaying = !v.paused && !v.ended && (v.readyState || 0) >= 2;
        const isLoaded = dur > 0 || (v.readyState || 0) >= 1 || Boolean(v.currentSrc || v.src);
        let score = 0;
        if (visibleArea > 0) score += 1e7 + Math.min(visibleArea, 5e6) - Math.min(centerDist * 50, 5e5);
        if (isPlaying && visibleArea > 0) score += 5e7;
        if (isLoaded) score += 1e5;
        if (score > bestVideoScore) {
          bestVideoScore = score;
          mainVideo = v;
        }
      }
      if (!mainVideo && vids.length) mainVideo = vids[0];
      const videoDuration = (mainVideo && Number.isFinite(mainVideo.duration) && mainVideo.duration > 0) ? Math.round(mainVideo.duration) : null;

      let platform = 'web';
      let platformItemId = '';
      let title = getMeta('meta[property="og:title"]') || getMeta('meta[name="title"]') || document.title || '';
      let thumbnail = getMeta('meta[property="og:image"]') || (Array.isArray(ld.thumbnailUrl) ? ld.thumbnailUrl[0] : (ld.thumbnailUrl || '')) || '';
      let author = '';
      let authorUrl = '';
      let publishedAt = getMeta('meta[itemprop="datePublished"]') || getMeta('meta[itemprop="uploadDate"]') || ld.uploadDate || '';
      let durationSec = videoDuration;
      let rawViews = '', rawLikes = '', rawComments = '', rawFavorites = '', rawShares = '', rawFollowers = '';

      if (host.includes('youtube.com') || host.includes('youtu.be')) {
        platform = 'youtube';
        const m = rawPageUrl.match(/(?:v=|shorts\\/|youtu\\.be\\/)([A-Za-z0-9_-]{11})/);
        if (m) platformItemId = m[1];
        const vd = (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails) || {};
        if (!platformItemId && vd.videoId) platformItemId = vd.videoId;
        if (platformItemId && !rawPageUrl.includes(platformItemId)) {
          canonicalUrl = 'https://www.youtube.com/watch?v=' + platformItemId;
        }
        if (!thumbnail && platformItemId) thumbnail = 'https://i.ytimg.com/vi/' + platformItemId + '/hqdefault.jpg';
        title = getText('h1.ytd-watch-metadata yt-formatted-string') || getText('h1.ytd-watch-metadata') || vd.title || title.replace(/\\s*-\\s*YouTube$/i, '');
        const chLink = document.querySelector('#owner ytd-channel-name a, ytd-video-owner-renderer a.yt-simple-endpoint');
        author = (chLink && (chLink.textContent || '').trim()) || vd.author || getMeta('link[itemprop="name"]') || '';
        if (chLink && chLink.href) authorUrl = chLink.href;
        rawFollowers = getText('#owner-sub-count');
        if (!durationSec && vd.lengthSeconds) durationSec = Number(vd.lengthSeconds) || null;
        rawViews = vd.viewCount || getMeta('meta[itemprop="interactionCount"]') || '';
        if (!rawViews) {
          const infoText = getText('#info-strings') || getText('#description-inner') || getText('ytd-watch-metadata');
          const vm = infoText.match(/([\\d.,]+\\s*[万亿KMBkmb]?)\\s*(?:次观看|views)/i);
          if (vm && vm[1]) rawViews = vm[1].trim();
        }
        const likeBtn = document.querySelector('like-button-view-model button, ytd-toggle-button-renderer button[aria-label*="赞"], button[aria-label*="like"]');
        if (likeBtn) rawLikes = (likeBtn.innerText || likeBtn.getAttribute('aria-label') || '').trim();
        const cmtCount = getText('ytd-comments-header-renderer #count .count-text') || getText('ytd-comments-header-renderer #count');
        if (cmtCount && /\\d/.test(cmtCount)) rawComments = cmtCount;
      } else if (host.includes('bilibili.com')) {
        platform = 'bilibili';
        const m = rawPageUrl.match(/(BV[A-Za-z0-9]{10})/i);
        if (m) platformItemId = m[1];
        const bvd = (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.videoData) || {};
        const bst = bvd.stat || {};
        if (!platformItemId && bvd.bvid) platformItemId = bvd.bvid;
        if (platformItemId && !rawPageUrl.includes(platformItemId)) {
          canonicalUrl = 'https://www.bilibili.com/video/' + platformItemId;
        }
        title = getText('h1.video-title') || bvd.title || title.replace(/_哔哩哔哩_bilibili$/i, '');
        if (!thumbnail && bvd.pic) thumbnail = bvd.pic;
        if (!durationSec && bvd.duration) durationSec = Number(bvd.duration) || null;
        const upLink = document.querySelector('a.up-name, .up-info--right a.up-name');
        author = (upLink && (upLink.textContent || '').trim()) || (bvd.owner && bvd.owner.name) || '';
        authorUrl = (upLink && upLink.href) || (bvd.owner && bvd.owner.mid ? ('https://space.bilibili.com/' + bvd.owner.mid) : '');
        publishedAt = getText('.pubdate-ip-text') || publishedAt;
        rawViews = getText('.view-text') || (bst.view != null ? String(bst.view) : '');
        rawLikes = getText('.video-like-info') || (bst.like != null ? String(bst.like) : '');
        rawFavorites = getText('.video-fav-info') || (bst.favorite != null ? String(bst.favorite) : '');
        rawShares = getText('.video-share-info') || (bst.share != null ? String(bst.share) : '');
        rawComments = getText('.total-reply') || (bst.reply != null ? String(bst.reply) : '');
      } else if (host.includes('douyin.com')) {
        platform = 'douyin';
        const m = rawPageUrl.match(/(?:video|note)\\/(\\d{15,22})/) || rawPageUrl.match(/modal_id=(\\d{15,22})/);
        if (m) platformItemId = m[1];

        // 1. 优先从当前正在观看的 mainVideo 向上定位其所属活跃容器（覆盖精选页、搜索结果视频弹层、详情页及暂停状态）
        let activeScope = null;
        const pickBestVisible = (selector) => {
          const nodes = Array.from(document.querySelectorAll(selector));
          let best = null;
          let bestScore = -1;
          for (const n of nodes) {
            const { visibleArea, centerDist } = getViewportScore(n);
            if (visibleArea <= 0) continue;
            const hasMain = mainVideo && n.contains(mainVideo) ? 5e7 : 0;
            const sc = hasMain + visibleArea - centerDist * 50;
            if (sc > bestScore) { bestScore = sc; best = n; }
          }
          return best;
        };

        if (mainVideo && mainVideo.closest) {
          activeScope =
            mainVideo.closest('[data-e2e="video-detail"]') ||
            mainVideo.closest('[data-e2e="feed-active-video"]') ||
            mainVideo.closest('.video-detail-container') ||
            mainVideo.closest('[role="dialog"]') ||
            mainVideo.closest('[data-e2e-vid]') ||
            mainVideo.closest('[data-aweme-id]');
        }
        if (!activeScope) {
          activeScope =
            pickBestVisible('[data-e2e="video-detail"]') ||
            pickBestVisible('[data-e2e="feed-active-video"]') ||
            pickBestVisible('.video-detail-container') ||
            document.querySelector('[data-e2e="feed-active-video"]') ||
            document.querySelector('[data-e2e="video-detail"]') ||
            document;
        }

        // 确保用于提取时长的 video 与 activeScope 一致
        if (activeScope && activeScope !== document) {
          const scopedVid = activeScope.querySelector('video');
          if (scopedVid && Number.isFinite(scopedVid.duration) && scopedVid.duration > 0) {
            durationSec = Math.round(scopedVid.duration);
          }
        }

        // 2. 从 activeScope / mainVideo 提取真实 19 位 aweme_id（只读，绝不扫无关推荐卡片）
        const extractAwemeIdFromNode = (node) => {
          if (!node) return '';
          if (node.getAttribute) {
            for (const attr of ['data-e2e-vid', 'data-aweme-id', 'data-vid', 'href']) {
              const v = node.getAttribute(attr) || '';
              const dm = v.match(/(\\d{15,22})/);
              if (dm) return dm[1];
            }
          }
          return '';
        };

        const extractAwemeIdFromFiber = (node) => {
          if (!node) return '';
          try {
            const fiberKey = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
            let cur = fiberKey ? node[fiberKey] : null;
            for (let depth = 0; cur && depth < 18; depth++) {
              const p = cur.memoizedProps || cur;
              const candidates = [
                p && p.awemeId,
                p && p.itemId,
                p && p.awemeInfo && p.awemeInfo.awemeId,
                p && p.awemeInfo && p.awemeInfo.itemId,
                p && p.data && p.data.awemeId,
                p && p.data && p.data.aweme_id,
                p && p.videoInfo && p.videoInfo.awemeId,
                p && p.item && p.item.awemeId,
              ];
              for (const aid of candidates) {
                if (aid != null && /^\\d{15,22}$/.test(String(aid))) {
                  return String(aid);
                }
              }
              cur = cur.return;
            }
          } catch (_) {}
          return '';
        };

        if (!platformItemId) {
          platformItemId = extractAwemeIdFromNode(activeScope);
        }
        if (!platformItemId && activeScope && activeScope.querySelector) {
          const vidNode = activeScope.querySelector('[data-e2e-vid], [data-aweme-id], a[href*="/video/"], a[href*="modal_id="]');
          if (vidNode) platformItemId = extractAwemeIdFromNode(vidNode);
        }
        if (!platformItemId) {
          platformItemId = extractAwemeIdFromFiber(activeScope) || extractAwemeIdFromFiber(mainVideo);
        }
        if (platformItemId) {
          canonicalUrl = 'https://www.douyin.com/video/' + platformItemId;
        }

        // 3. 在同一 activeScope 内提取标题、作者、互动数据与缩略图（若不在具体作品容器中则不强抓搜索页标题）
        const scopedTitle =
          getText('[data-e2e="video-desc"]', activeScope) ||
          getText('[data-e2e="detail-video-desc"]', activeScope) ||
          getText('h1', activeScope);
        if (scopedTitle) {
          title = scopedTitle;
        } else {
          title = title.replace(/\\s*-\\s*抖音$/i, '');
        }

        const cleanAt = (s) => (s || '').replace(/^@+/, '').trim();
        const authorCandidates = [
          '[data-e2e="feed-video-nickname"]',
          '[data-e2e="detail-video-author-name"]',
          '[data-e2e="user-info"] [data-e2e="user-info-nickname"]',
          '.account-name',
          '.author-card-user-name',
          '[data-e2e="user-info"] span',
        ];
        for (const sel of authorCandidates) {
          const val = cleanAt(getText(sel, activeScope));
          if (val && val.length <= 40 && !/^(关注|已关注|私信|粉丝|获赞)$/.test(val)) {
            author = val;
            break;
          }
        }
        const allAuthorLinks = activeScope && activeScope.querySelectorAll
          ? Array.from(activeScope.querySelectorAll('[data-e2e="user-info"] a[href*="/user/"], a[data-e2e="feed-video-nickname"], a[href*="/user/MS4w"]'))
          : [];
        const authorA = allAuthorLinks.find((a) => {
          const inDesc = a.closest && (a.closest('[data-e2e="video-desc"]') || a.closest('[data-e2e="detail-video-desc"]'));
          return !inDesc;
        }) || null;
        if (authorA) {
          authorUrl = authorA.href || '';
          if (!author) {
            const atxt = cleanAt(authorA.innerText || authorA.textContent || '');
            if (atxt && atxt.length <= 40 && !/^(DOU\+小助手|抖音小助手|抖音作者助手)$/.test(atxt)) author = atxt;
          }
        }
        publishedAt = getText('[data-e2e="detail-video-publish-time"]', activeScope) || getText('.video-create-time', activeScope) || publishedAt;
        rawLikes = getText('[data-e2e="detail-video-like-count"]', activeScope) || getText('[data-e2e="video-player-digg"]', activeScope);
        rawComments = getText('[data-e2e="detail-video-comment-count"]', activeScope) || getText('[data-e2e="video-player-comment"]', activeScope);
        rawFavorites = getText('[data-e2e="detail-video-collect-count"]', activeScope) || getText('[data-e2e="video-player-collect"]', activeScope);
        rawShares = getText('[data-e2e="detail-video-share-count"]', activeScope) || getText('[data-e2e="video-player-share"]', activeScope);
        rawFollowers = getText('[data-e2e="user-info-fans"]', activeScope) || '';
        const scopedVideoEl = (activeScope && activeScope.querySelector && activeScope.querySelector('video')) || mainVideo;
        if (thumbnail && /emblem-new\.png|douyin.*logo/i.test(thumbnail)) thumbnail = '';
        if (!thumbnail && scopedVideoEl && scopedVideoEl.poster) thumbnail = scopedVideoEl.poster;
        if (!thumbnail && activeScope && activeScope.querySelector) {
          const posterImg = activeScope.querySelector('img[src*="douyinpic"], img[src*="byteimg"], .xgplayer-poster img');
          if (posterImg && posterImg.src && !/emblem-new\.png/i.test(posterImg.src)) thumbnail = posterImg.src;
        }
      } else if (host.includes('zhihu.com')) {
        platform = 'zhihu';
      } else if (host.includes('xiaohongshu.com')) {
        platform = 'xiaohongshu';
      } else if (host.includes('reddit.com')) {
        platform = 'reddit';
      }

      const cleanTitle = (title || '').trim();
      const cleanAuthor = (author || '').trim();
      const extractStatus = !platformItemId
        ? 'identity_unverified'
        : (cleanTitle && cleanAuthor ? 'complete' : 'partial');

      return {
        raw_page_url: rawPageUrl,
        url: canonicalUrl,
        platform,
        platform_item_id: platformItemId,
        extract_status: extractStatus,
        title: cleanTitle,
        thumbnail_url: (thumbnail || '').trim(),
        author: cleanAuthor,
        author_url: (authorUrl || '').trim(),
        published_at: (publishedAt || '').trim(),
        duration_sec: durationSec,
        raw_metrics: {
          views: rawViews,
          likes: rawLikes,
          comments: rawComments,
          favorites: rawFavorites,
          shares: rawShares,
          followers: rawFollowers,
        },
      };
    })()
  `;
}

module.exports = { buildReadonlyVideoMetaScript };
