/**
 * GCW-STABLE-FIX-02 · 真实网页元数据提取脚本 JavaScript 异常与多场景自动化回归测试
 * 覆盖：
 *  1. 抖音精选页（播放态）：验证不会触发 TypeError: Assignment to constant variable，且命中视口中央视频而非推荐列表首个
 *  2. 抖音精选页（暂停态）：验证所有视频暂停时仍准确命中当前视口主视频
 *  3. 抖音搜索结果视频弹层（React Fiber 提取 awemeId）：验证命中弹层作品而非背景搜索页
 *  4. 抖音普通视频详情页（/video/<id>）
 *  5. 抖音纯搜索列表页无作品 ID：验证返回 extract_status = 'identity_unverified'
 *  6. YouTube & B站回归
 *  7. 静态断言 desktop/main.js 异常处理绝不返回 ok: true 伪装成功
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildReadonlyVideoMetaScript } = require('./video_meta_extractor');

function makeEl({
  tag = 'div',
  attrs = {},
  text = '',
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
  children = [],
  props = {},
  matches = [],
} = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    innerText: text,
    textContent: text,
    href: attrs.href || '',
    src: attrs.src || '',
    poster: attrs.poster || '',
    parentElement: null,
    children: [],
    ...props,
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
    },
    getBoundingClientRect() {
      return rect;
    },
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    },
    _matches(sel) {
      if (matches.includes(sel)) return true;
      if (sel === tag) return true;
      const mAttr = sel.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (mAttr) {
        const val = this.getAttribute(mAttr[1]);
        return mAttr[2] !== undefined ? val === mAttr[2] : val !== null;
      }
      if (sel.startsWith('.')) return (attrs.class || '').split(/\s+/).includes(sel.slice(1));
      if (sel.includes('a[href*="/video/"]')) return this.tagName === 'A' && (this.href || '').includes('/video/');
      if (sel.includes('a[href*="/user/"]')) return this.tagName === 'A' && (this.href || '').includes('/user/');
      return false;
    },
    closest(selectorList) {
      const sels = selectorList.split(',').map((s) => s.trim());
      let cur = this;
      while (cur) {
        for (const s of sels) {
          if (cur._matches && cur._matches(s)) return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll(selectorList) {
      const sels = selectorList.split(',').map((s) => s.trim());
      const res = [];
      const walk = (node) => {
        for (const ch of node.children || []) {
          for (const s of sels) {
            if (ch._matches && ch._matches(s)) {
              res.push(ch);
              break;
            }
          }
          walk(ch);
        }
      };
      walk(this);
      return res;
    },
    querySelector(selectorList) {
      return this.querySelectorAll(selectorList)[0] || null;
    },
  };
  for (const ch of children) {
    ch.parentElement = el;
    el.children.push(ch);
  }
  return el;
}

function runScriptInMockDom({ href, hostname, title = '', rootChildren = [], windowExtras = {} }) {
  const root = makeEl({ tag: 'html', children: rootChildren });
  const sandbox = {
    location: { href, hostname },
    document: {
      title,
      documentElement: { clientWidth: 1280, clientHeight: 800 },
      querySelector: (s) => root.querySelector(s),
      querySelectorAll: (s) => root.querySelectorAll(s),
    },
    window: { innerWidth: 1280, innerHeight: 800, ...windowExtras },
    Array,
    Object,
    Number,
    Math,
    JSON,
    Boolean,
    String,
    RegExp,
  };
  const code = buildReadonlyVideoMetaScript();
  return vm.runInNewContext(code, sandbox);
}

// 场景 1：抖音精选页（播放态），列表第 1 个不在视口，第 2 个在视口中央播放
{
  const card1 = makeEl({
    attrs: { 'data-e2e': 'feed-active-video', 'data-e2e-vid': '7111111111111111111' },
    rect: { left: 0, top: -900, right: 800, bottom: -100, width: 800, height: 800 },
    children: [
      makeEl({ tag: 'video', rect: { left: 0, top: -900, right: 800, bottom: -100, width: 800, height: 800 }, props: { paused: true, ended: false, readyState: 4, duration: 30 } }),
      makeEl({ attrs: { 'data-e2e': 'video-desc' }, text: '旧推荐视频1' }),
      makeEl({ attrs: { 'data-e2e': 'feed-video-nickname' }, text: '旧作者1' }),
    ],
  });
  const card2 = makeEl({
    attrs: { 'data-e2e': 'feed-active-video', 'data-e2e-vid': '7702420505361452297' },
    rect: { left: 100, top: 40, right: 900, bottom: 760, width: 800, height: 720 },
    children: [
      makeEl({ tag: 'video', rect: { left: 100, top: 40, right: 900, bottom: 760, width: 800, height: 720 }, props: { paused: false, ended: false, readyState: 4, duration: 128, poster: 'https://p3.douyinpic.com/cover2.jpg' } }),
      makeEl({ attrs: { 'data-e2e': 'video-desc' }, text: '当前正在观看的真实视频2' }),
      makeEl({ attrs: { 'data-e2e': 'feed-video-nickname' }, text: '@当前作者2' }),
      makeEl({ attrs: { 'data-e2e': 'video-player-digg' }, text: '1.2万' }),
    ],
  });
  const r = runScriptInMockDom({
    href: 'https://www.douyin.com/jingxuan/',
    hostname: 'www.douyin.com',
    title: '抖音精选',
    rootChildren: [card1, card2],
  });
  assert.strictEqual(r.platform, 'douyin');
  assert.strictEqual(r.platform_item_id, '7702420505361452297');
  assert.strictEqual(r.raw_page_url, 'https://www.douyin.com/jingxuan/');
  assert.strictEqual(r.url, 'https://www.douyin.com/video/7702420505361452297');
  assert.strictEqual(r.title, '当前正在观看的真实视频2');
  assert.strictEqual(r.author, '当前作者2');
  assert.strictEqual(r.duration_sec, 128);
  assert.strictEqual(r.extract_status, 'complete');
}

// 场景 2：抖音精选页（暂停态），所有 video.paused=true，依然命中视口中央视频
{
  const card1 = makeEl({
    attrs: { 'data-e2e': 'feed-active-video', 'data-e2e-vid': '7111111111111111111' },
    rect: { left: 0, top: -900, right: 800, bottom: -100, width: 800, height: 800 },
    children: [
      makeEl({ tag: 'video', rect: { left: 0, top: -900, right: 800, bottom: -100, width: 800, height: 800 }, props: { paused: true, ended: false, readyState: 4, duration: 30 } }),
      makeEl({ attrs: { 'data-e2e': 'video-desc' }, text: '屏幕外视频1' }),
    ],
  });
  const card2 = makeEl({
    attrs: { 'data-e2e': 'feed-active-video', 'data-e2e-vid': '7609876543210987654' },
    rect: { left: 100, top: 40, right: 900, bottom: 760, width: 800, height: 720 },
    children: [
      makeEl({ tag: 'video', rect: { left: 100, top: 40, right: 900, bottom: 760, width: 800, height: 720 }, props: { paused: true, ended: false, readyState: 4, duration: 95 } }),
      makeEl({ attrs: { 'data-e2e': 'video-desc' }, text: '已暂停的当前视频' }),
      makeEl({ attrs: { 'data-e2e': 'feed-video-nickname' }, text: '暂停作者' }),
    ],
  });
  const r = runScriptInMockDom({
    href: 'https://www.douyin.com/jingxuan/',
    hostname: 'www.douyin.com',
    rootChildren: [card1, card2],
  });
  assert.strictEqual(r.platform_item_id, '7609876543210987654');
  assert.strictEqual(r.title, '已暂停的当前视频');
  assert.strictEqual(r.author, '暂停作者');
  assert.strictEqual(r.duration_sec, 95);
}

// 场景 3：抖音搜索结果页打开视频弹层（React Fiber 提供 awemeId）
{
  const modal = makeEl({
    attrs: { 'data-e2e': 'video-detail' },
    rect: { left: 80, top: 30, right: 1200, bottom: 770, width: 1120, height: 740 },
    props: { __reactFiber$abc: { memoizedProps: { awemeInfo: { awemeId: '7512345678901234567' } } } },
    children: [
      makeEl({ tag: 'video', rect: { left: 100, top: 50, right: 860, bottom: 750, width: 760, height: 700 }, props: { paused: false, ended: false, readyState: 4, duration: 205 } }),
      makeEl({ attrs: { 'data-e2e': 'detail-video-desc' }, text: '搜索弹层真实视频标题' }),
      makeEl({ attrs: { 'data-e2e': 'detail-video-author-name' }, text: '弹层作者' }),
    ],
  });
  const r = runScriptInMockDom({
    href: 'https://www.douyin.com/search/AI%E6%A8%A1%E5%9E%8B',
    hostname: 'www.douyin.com',
    title: 'AI模型 - 抖音搜索',
    rootChildren: [modal],
  });
  assert.strictEqual(r.platform, 'douyin');
  assert.strictEqual(r.platform_item_id, '7512345678901234567');
  assert.strictEqual(r.url, 'https://www.douyin.com/video/7512345678901234567');
  assert.strictEqual(r.title, '搜索弹层真实视频标题');
  assert.strictEqual(r.author, '弹层作者');
}

// 场景 4：抖音普通视频详情页
{
  const r = runScriptInMockDom({
    href: 'https://www.douyin.com/video/7400000000000000001',
    hostname: 'www.douyin.com',
    title: '普通详情页标题 - 抖音',
    rootChildren: [
      makeEl({ attrs: { 'data-e2e': 'detail-video-author-name' }, text: '详情页作者' }),
    ],
  });
  assert.strictEqual(r.platform, 'douyin');
  assert.strictEqual(r.platform_item_id, '7400000000000000001');
  assert.strictEqual(r.url, 'https://www.douyin.com/video/7400000000000000001');
  assert.strictEqual(r.extract_status, 'complete');
}

// 场景 5：抖音纯搜索列表页无视频 ID -> identity_unverified（不伪造 ID）
{
  const r = runScriptInMockDom({
    href: 'https://www.douyin.com/search/test',
    hostname: 'www.douyin.com',
    title: 'test - 抖音搜索',
    rootChildren: [],
  });
  assert.strictEqual(r.platform, 'douyin');
  assert.strictEqual(r.platform_item_id, '');
  assert.strictEqual(r.extract_status, 'identity_unverified');
}

// 场景 6：YouTube & B站回归
{
  const yt = runScriptInMockDom({
    href: 'https://www.youtube.com/watch?v=BR_Nm6kvLSw',
    hostname: 'www.youtube.com',
    title: 'Hospitals in Shanghai - YouTube',
    windowExtras: { ytInitialPlayerResponse: { videoDetails: { videoId: 'BR_Nm6kvLSw', title: 'Hospitals in Shanghai', author: 'ShanghaiEye', lengthSeconds: '448', viewCount: '56732' } } },
  });
  assert.strictEqual(yt.platform, 'youtube');
  assert.strictEqual(yt.platform_item_id, 'BR_Nm6kvLSw');
  assert.strictEqual(yt.author, 'ShanghaiEye');
  assert.strictEqual(yt.extract_status, 'complete');

  const bili = runScriptInMockDom({
    href: 'https://www.bilibili.com/video/BV1xx411c7mD',
    hostname: 'www.bilibili.com',
    title: '测试B站视频_哔哩哔哩_bilibili',
    windowExtras: { __INITIAL_STATE__: { videoData: { bvid: 'BV1xx411c7mD', title: '测试B站视频', duration: 180, owner: { name: '测试UP主', mid: 12345 }, stat: { view: 9999, like: 500 } } } },
  });
  assert.strictEqual(bili.platform, 'bilibili');
  assert.strictEqual(bili.platform_item_id, 'BV1xx411c7mD');
  assert.strictEqual(bili.author, '测试UP主');
  assert.strictEqual(bili.extract_status, 'complete');
}

// 场景 7：静态校验 desktop/main.js 异常处理不再吞异常返回 ok: true
{
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.ok(mainSrc.includes("extract_status: 'script_error'"), 'main.js must return extract_status: script_error on catch');
  assert.ok(!mainSrc.includes('const url = location.href'), 'main.js must not contain old const url script');
  const extractorSrc = fs.readFileSync(path.join(__dirname, 'video_meta_extractor.js'), 'utf8');
  assert.ok(!/\bconst\s+url\b/.test(extractorSrc), 'video_meta_extractor.js must not declare const url');
}

console.log('ALL_7_VIDEO_META_EXTRACTOR_TESTS_PASS');
