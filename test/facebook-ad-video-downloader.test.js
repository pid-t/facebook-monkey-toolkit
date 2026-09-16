const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const userscriptPath = path.join(
  __dirname,
  '..',
  'public',
  'facebook-ad-video-downloader.user.js'
);

function textNode(value) {
  return { nodeType: 3, nodeValue: value };
}

function element(children, options = {}) {
  const node = {
    childNodes: children,
    parentElement: options.parentElement || null,
    textContent: children.map((child) => child.nodeValue || child.textContent || '').join(''),
    querySelector(selector) {
      if (selector.includes('video') && options.hasVideo) return { tagName: 'VIDEO' };
      return null;
    }
  };

  for (const child of children) {
    if (child.nodeType !== 3) child.parentElement = node;
  }

  return node;
}

function createTreeWalker(root) {
  const textNodes = [];

  function visit(node) {
    if (node.nodeType === 3) {
      textNodes.push(node);
      return;
    }
    for (const child of node.childNodes || []) visit(child);
  }

  visit(root);
  let index = 0;
  return {
    nextNode() {
      return textNodes[index++] || null;
    }
  };
}

function mockElement(tagName) {
  const attributes = new Map();
  const listeners = new Map();
  let textContent = '';
  const node = {
    children: [],
    className: '',
    dataset: {},
    tagName: tagName.toUpperCase(),
    textContentWrites: 0,
    title: '',
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    dispatch(type, properties = {}) {
      const event = {
        key: properties.key,
        preventDefault() {},
        stopPropagation() {}
      };
      for (const listener of listeners.get(type) || []) listener(event);
    },
    getAttribute(name) {
      return attributes.get(name) || null;
    },
    querySelector(selector) {
      if (!selector.startsWith('.')) return null;
      const className = selector.slice(1);
      const queue = [...this.children];
      while (queue.length > 0) {
        const child = queue.shift();
        if ((child.className || '').split(/\s+/).includes(className)) return child;
        queue.push(...(child.children || []));
      }
      return null;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    }
  };
  Object.defineProperty(node, 'textContent', {
    get() {
      return textContent;
    },
    set(value) {
      textContent = String(value);
      this.textContentWrites += 1;
    }
  });
  return node;
}

function loadTestHooks() {
  const document = {
    body: {
      appendChild() {},
      querySelector() { return null; }
    },
    documentElement: {},
    createElement(tagName) {
      if (tagName !== 'textarea') return mockElement(tagName);
      return {
        set innerHTML(value) {
          this.value = value.replace(/&amp;/g, '&');
        },
        value: ''
      };
    },
    createTreeWalker,
    getElementById() { return null; },
    querySelectorAll() { return []; }
  };
  const context = {
    BroadcastChannel: undefined,
    console,
    document,
    globalThis: null,
    GM_addStyle() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    NodeFilter: { SHOW_TEXT: 4 },
    URL,
    URLSearchParams,
    window: {
      addEventListener() {},
      location: { hash: '', search: '' }
    }
  };
  context.globalThis = context;

  const source = fs.readFileSync(userscriptPath, 'utf8');
  const instrumented = source.replace(
    /\}\)\(\);\s*$/,
    `globalThis.__testHooks = {
      extractLibraryId,
      findAdCard,
      getVideoAdId: typeof getVideoAdId === 'function' ? getVideoAdId : undefined,
      extractVideoUrls,
      requestVideoUrls: typeof requestVideoUrls === 'function' ? requestVideoUrls : undefined,
      createDownloadMenuItem: typeof createDownloadMenuItem === 'function' ? createDownloadMenuItem : undefined,
      setDownloadMenuItemState: typeof setDownloadMenuItemState === 'function' ? setDownloadMenuItemState : undefined
    };
})();`
  );
  vm.runInNewContext(instrumented, context, { filename: userscriptPath });

  return { context, hooks: context.__testHooks };
}

test('extractLibraryId supports English, Simplified Chinese, and Traditional Chinese', () => {
  const { hooks } = loadTestHooks();
  const cases = [
    ['Library ID: 1919390142798191', '1919390142798191'],
    ['资料库编号：1919390142798191', '1919390142798191'],
    ['檔案庫編號：1919390142798191', '1919390142798191']
  ];

  for (const [label, expected] of cases) {
    assert.equal(hooks.extractLibraryId(element([textNode(label)])), expected);
  }
});

test('extractLibraryId reads the independent ID node without consuming an adjacent date', () => {
  const { hooks } = loadTestHooks();
  const card = element([
    textNode('资料库编号：1919390142798191'),
    textNode('2026年7月19日开始投放')
  ]);

  assert.equal(card.textContent, '资料库编号：19193901427981912026年7月19日开始投放');
  assert.equal(hooks.extractLibraryId(card), '1919390142798191');
});

test('findAdCard follows data-ownerid to the triggering video card', () => {
  const { context, hooks } = loadTestHooks();
  const card = element([textNode('资料库编号：1919390142798191')], { hasVideo: true });
  const trigger = element([], { parentElement: card });
  trigger.parentElement = card;
  context.document.getElementById = (id) => id === 'menu-trigger' ? trigger : null;
  const menu = {
    closest() {
      return { getAttribute: () => 'menu-trigger' };
    }
  };

  assert.equal(hooks.findAdCard(menu), card);
  assert.equal(hooks.getVideoAdId(card), '1919390142798191');
});

test('getVideoAdId rejects an image-only ad card', () => {
  const { hooks } = loadTestHooks();
  const imageCard = element([textNode('Library ID: 1919390142798191')]);

  assert.equal(hooks.getVideoAdId(imageCard), '');
});

test('findAdCard keeps image and video ads inside their own cards', () => {
  const { context, hooks } = loadTestHooks();
  const imageCard = element([
    textNode('Library ID: 1720202429228436'),
    element([textNode('Library ID: 1720202429228436')])
  ]);
  const videoCard = element([textNode('Library ID: 1919390142798191')], { hasVideo: true });
  const resultList = element([imageCard, videoCard], { hasVideo: true });
  const imageTrigger = element([], { parentElement: imageCard });
  const videoTrigger = element([], { parentElement: videoCard });

  context.document.getElementById = (id) => ({
    'image-trigger': imageTrigger,
    'video-trigger': videoTrigger
  }[id] || null);

  const menuFor = (ownerId) => ({
    closest() {
      return { getAttribute: () => ownerId };
    }
  });

  assert.equal(hooks.findAdCard(menuFor('image-trigger')), imageCard);
  assert.equal(hooks.getVideoAdId(imageCard), '');
  assert.equal(hooks.findAdCard(menuFor('video-trigger')), videoCard);
  assert.equal(hooks.getVideoAdId(videoCard), '1919390142798191');
});

test('extractVideoUrls returns a valid Facebook CDN MP4 URL from a detail page', () => {
  const { hooks } = loadTestHooks();
  const html = String.raw`<script>"browser_native_hd_url":"https:\/\/video.xx.fbcdn.net\/v\/t42.1790-2\/video.mp4?efg=abc&amp;_nc_sid=123"</script>`;

  const urls = Array.from(hooks.extractVideoUrls(html));

  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/video\.xx\.fbcdn\.net\/.*\.mp4\?/);
});

test('extractVideoUrls decodes Unicode-escaped query separators', () => {
  const { hooks } = loadTestHooks();
  const html = String.raw`<script>"browser_native_sd_url":"https:\/\/video.xx.fbcdn.net\/v\/video.mp4?foo\u00253Dbar\u0026baz\u00253Dqux"</script>`;

  const urls = Array.from(hooks.extractVideoUrls(html));

  assert.deepEqual(urls, [
    'https://video.xx.fbcdn.net/v/video.mp4?foo=bar&baz=qux'
  ]);
});

test('requestVideoUrls fetches detail HTML without opening a browser tab', () => {
  const { context, hooks } = loadTestHooks();
  const html = String.raw`<script>"browser_native_hd_url":"https:\/\/video.xx.fbcdn.net\/v\/video.mp4?efg=abc"</script>`;
  let requestDetails;
  let receivedUrls;
  let receivedError;

  context.GM_xmlhttpRequest = (details) => {
    requestDetails = details;
    details.onload({ status: 200, responseText: html });
  };

  hooks.requestVideoUrls(
    '1763677405065671',
    (urls) => { receivedUrls = Array.from(urls); },
    (message) => { receivedError = message; }
  );

  assert.equal(requestDetails.method, 'GET');
  assert.equal(
    requestDetails.url,
    'https://www.facebook.com/ads/library?id=1763677405065671'
  );
  assert.deepEqual(receivedUrls, [
    'https://video.xx.fbcdn.net/v/video.mp4?efg=abc'
  ]);
  assert.equal(receivedError, undefined);

  const source = fs.readFileSync(userscriptPath, 'utf8');
  assert.match(source, /@grant\s+GM_xmlhttpRequest/);
  assert.match(source, /@connect\s+www\.facebook\.com/);
  assert.doesNotMatch(source, /GM_openInTab/);
});

test('download menu item blocks repeat activation while loading and allows retry after reset', () => {
  const { hooks } = loadTestHooks();
  let activationCount = 0;
  const item = hooks.createDownloadMenuItem('1763677405065671', () => {
    activationCount += 1;
  });

  item.dispatch('click');
  assert.equal(activationCount, 1);

  hooks.setDownloadMenuItemState(item, 'loading');
  item.dispatch('click');
  item.dispatch('keydown', { key: 'Enter' });

  assert.equal(activationCount, 1);
  assert.equal(item.dataset.state, 'loading');
  assert.equal(item.getAttribute('aria-busy'), 'true');
  assert.equal(item.getAttribute('aria-disabled'), 'true');
  assert.equal(
    item.querySelector('.fo-facebook-ad-video-menu-label').textContent,
    '正在获取视频…'
  );

  hooks.setDownloadMenuItemState(item, 'idle');
  item.dispatch('keydown', { key: ' ' });

  assert.equal(activationCount, 2);
  assert.equal(item.dataset.state, 'idle');
  assert.equal(item.getAttribute('aria-busy'), 'false');
  assert.equal(item.getAttribute('aria-disabled'), 'false');
  assert.equal(item.getAttribute('aria-label'), '下载视频');
  assert.equal(
    item.querySelector('.fo-facebook-ad-video-menu-icon').textContent,
    '↓'
  );
  assert.equal(
    item.querySelector('.fo-facebook-ad-video-menu-label').textContent,
    '下载视频'
  );
});

test('setting the same menu state does not rewrite observed child nodes', () => {
  const { hooks } = loadTestHooks();
  const item = hooks.createDownloadMenuItem('1763677405065671', () => {});
  const icon = item.querySelector('.fo-facebook-ad-video-menu-icon');
  const label = item.querySelector('.fo-facebook-ad-video-menu-label');
  const iconWrites = icon.textContentWrites;
  const labelWrites = label.textContentWrites;

  hooks.setDownloadMenuItemState(item, 'idle');

  assert.equal(icon.textContentWrites, iconWrites);
  assert.equal(label.textContentWrites, labelWrites);
});
