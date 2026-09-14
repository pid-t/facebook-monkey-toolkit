// ==UserScript==
// @name         Facebook Ad Library 视频下载助手
// @namespace    fo-tools
// @version      1.0.0
// @description  在 Facebook Ad Library 的视频广告菜单中增加视频解析与下载入口
// @match        https://www.facebook.com/ads/library/*
// @run-at       document-start
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        GM_openInTab
// @grant        GM_setValue
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const CHANNEL_NAME = 'fo-facebook-ad-video-downloader';
  const RESULT_KEY = 'fo-facebook-ad-video-result';
  const MENU_ITEM_CLASS = 'fo-facebook-ad-video-menu-item';
  const REQUEST_HASH_PREFIX = 'fo-request=';
  const DETAIL_TIMEOUT_MS = 15_000;
  const REQUEST_TIMEOUT_MS = DETAIL_TIMEOUT_MS + 5_000;
  const DETAIL_POLL_INTERVAL_MS = 500;

  installStyles();

  const query = new URLSearchParams(window.location.search);
  const libraryId = query.get('id');
  const requestToken = getRequestToken();

  if (libraryId && requestToken) {
    runDetailParser(libraryId, requestToken);
    return;
  }

  runLibraryPage();

  function runLibraryPage() {
    const pendingRequests = new Map();
    const channel = createChannel(handleResult);

    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(RESULT_KEY, function (_key, _oldValue, newValue) {
        handleResult(parseMessage(newValue));
      });
    }

    const observer = new MutationObserver(function () {
      decorateOpenMenus();
    });

    whenBodyReady(function () {
      observer.observe(document.body, { childList: true, subtree: true });
      decorateOpenMenus();
    });

    window.addEventListener('pagehide', function () {
      observer.disconnect();
      if (channel) channel.close();
    }, { once: true });

    function decorateOpenMenus() {
      document.querySelectorAll('[role="menu"]').forEach(function (menu) {
        if (menu.querySelector('.' + MENU_ITEM_CLASS)) {
          return;
        }

        const card = findAdCard(menu);
        const id = card && extractLibraryId(card.textContent || '');
        const hasVideo = Boolean(card && card.querySelector(
          'video, [aria-label*="Play video"], [aria-label*="Play Video"]'
        ));

        if (!id || !hasVideo) {
          return;
        }

        menu.appendChild(createDownloadMenuItem(id, function () {
          const token = createRequestToken();
          pendingRequests.set(token, { id: id, tab: null, timer: null });
          requestVideoUrls(id, token, pendingRequests);
        }));
      });
    }

    function handleResult(message) {
      if (!message || !message.token || !pendingRequests.has(message.token)) {
        return;
      }

      const request = pendingRequests.get(message.token);
      pendingRequests.delete(message.token);

      if (request.timer) {
        window.clearTimeout(request.timer);
      }

      if (request.tab && typeof request.tab.close === 'function') {
        request.tab.close();
      }

      if (Array.isArray(message.urls) && message.urls.length > 0) {
        showVideoPicker(message.id, message.urls);
        return;
      }

      showToast(message.error || '详情页中没有找到可用的视频链接。', 'error');
    }

    function requestVideoUrls(id, token, requests) {
      const detailUrl = new URL('https://www.facebook.com/ads/library/');
      detailUrl.searchParams.set('id', id);
      detailUrl.hash = REQUEST_HASH_PREFIX + encodeURIComponent(token);

      try {
        const openedTab = GM_openInTab(detailUrl.toString(), {
          active: false,
          insert: true,
          setParent: true
        });

        const request = requests.get(token);
        if (request) {
          request.timer = window.setTimeout(function () {
            const expiredRequest = requests.get(token);
            if (!expiredRequest) return;
            requests.delete(token);
            if (expiredRequest.tab && typeof expiredRequest.tab.close === 'function') {
              expiredRequest.tab.close();
            }
            showToast('广告详情页加载超时，请重试。', 'error');
          }, REQUEST_TIMEOUT_MS);
        }

        if (openedTab && typeof openedTab.then === 'function') {
          openedTab.then(function (tab) {
            const pendingRequest = requests.get(token);
            if (pendingRequest) pendingRequest.tab = tab;
          });
        } else {
          const pendingRequest = requests.get(token);
          if (pendingRequest) pendingRequest.tab = openedTab;
        }
      } catch (error) {
        requests.delete(token);
        showToast('无法打开广告详情页：' + getErrorMessage(error), 'error');
      }
    }

    function createChannel(onMessage) {
      if (typeof BroadcastChannel !== 'function') {
        return null;
      }

      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener('message', function (event) {
        onMessage(parseMessage(event.data));
      });
      return channel;
    }
  }

  function runDetailParser(id, token) {
    let finished = false;
    const startedAt = Date.now();
    const pollTimer = window.setInterval(function () {
      tryParse();
    }, DETAIL_POLL_INTERVAL_MS);

    whenBodyReady(function () {
      window.setTimeout(tryParse, 400);
    });

    tryParse();

    function tryParse() {
      if (finished) return;

      const urls = extractVideoUrls(document.documentElement && document.documentElement.outerHTML);
      if (urls.length > 0) {
        finish({ id: id, token: token, urls: urls });
        return;
      }

      if (Date.now() - startedAt >= DETAIL_TIMEOUT_MS) {
        finish({
          id: id,
          token: token,
          urls: [],
          error: '详情页加载完成，但没有找到 MP4 视频链接。'
        });
      }
    }

    function finish(message) {
      finished = true;
      window.clearInterval(pollTimer);
      publishResult(message);

      // GM_openInTab 返回的标签页由列表页关闭；此处只处理直接被浏览器脚本打开的情况。
      window.setTimeout(function () {
        try {
          window.close();
        } catch (_error) {
          // 浏览器可能禁止页面自行关闭，列表页仍会关闭 GM_openInTab 标签。
        }
      }, 150);
    }
  }

  function publishResult(message) {
    const payload = JSON.stringify(message);

    if (typeof GM_setValue === 'function') {
      GM_setValue(RESULT_KEY, payload);
    }

    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(message);
      channel.close();
    }
  }

  function extractVideoUrls(html) {
    if (!html) return [];

    // 沿用 sample.js：从详情页源码中提取带查询参数的 MP4 URL。
    const regex = /https?:\\?\/\\?\/[^"']+?\.mp4\?[^"'\s]+/g;
    const matches = html.match(regex) || [];

    return Array.from(new Set(matches.map(cleanVideoUrl)))
      .filter(function (url) {
        return /^https?:\/\//i.test(url) && /\.mp4\?/i.test(url) && isFacebookVideoUrl(url);
      });
  }

  function isFacebookVideoUrl(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname === 'facebook.com' ||
        hostname.endsWith('.facebook.com') ||
        hostname === 'fbcdn.net' ||
        hostname.endsWith('.fbcdn.net');
    } catch (_error) {
      return false;
    }
  }

  function cleanVideoUrl(url) {
    return decodeHtmlEntities(
      url
        .replace(/\\u00253D/gi, '=')
        .replace(/\\/g, '')
    );
  }

  function decodeHtmlEntities(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
  }

  function createDownloadMenuItem(id, onClick) {
    const item = document.createElement('div');
    item.className = MENU_ITEM_CLASS;
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', '下载视频');
    item.innerHTML = '<span class="fo-facebook-ad-video-menu-icon" aria-hidden="true">↓</span>' +
      '<span>下载视频</span>';

    item.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      onClick(id);
    });

    item.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      onClick(id);
    });

    return item;
  }

  function showVideoPicker(id, urls) {
    const existing = document.getElementById('fo-facebook-ad-video-picker');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'fo-facebook-ad-video-picker';
    backdrop.className = 'fo-facebook-ad-video-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'fo-facebook-ad-video-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'fo-facebook-ad-video-title');

    const title = document.createElement('h2');
    title.id = 'fo-facebook-ad-video-title';
    title.textContent = '选择视频 · Library ID ' + id;

    const hint = document.createElement('p');
    hint.textContent = '选择一个版本，在新标签页打开视频链接。';

    const options = document.createElement('div');
    options.className = 'fo-facebook-ad-video-options';

    urls.forEach(function (url, index) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'fo-facebook-ad-video-option';
      option.innerHTML = '<span>' + getVideoLabel(url, index) + '</span>' +
        '<small>' + escapeHtml(formatUrl(url)) + '</small>';
      option.addEventListener('click', function () {
        window.open(url, '_blank', 'noopener,noreferrer');
        backdrop.remove();
      });
      options.appendChild(option);
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'fo-facebook-ad-video-cancel';
    cancel.textContent = '取消';
    cancel.addEventListener('click', function () {
      backdrop.remove();
    });

    dialog.append(title, hint, options, cancel);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) backdrop.remove();
    });

    dialog.querySelector('button')?.focus();
  }

  function getVideoLabel(url, index) {
    const isHD = url.includes('720p') || url.includes('m366');
    return (isHD ? '高清版 (HD)' : '标清版 (SD)') + ' · 版本 ' + (index + 1);
  }

  function formatUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname + parsed.pathname.slice(-42);
    } catch (_error) {
      return url.slice(0, 70);
    }
  }

  function findAdCard(menu) {
    const layer = menu.closest('[data-ownerid]');
    const ownerId = layer && layer.getAttribute('data-ownerid');
    const trigger = ownerId && document.getElementById(ownerId);
    let current = trigger;
    let candidate = null;

    while (current && current !== document.body) {
      const text = current.textContent || '';
      if (extractLibraryId(text)) {
        candidate = current;
        if (current.querySelector('video, [aria-label*="Play video"], [aria-label*="Play Video"]')) {
          return current;
        }
      }
      current = current.parentElement;
    }

    return candidate;
  }

  function extractLibraryId(text) {
    const match = text.match(/Library ID:\s*(\d+)/i);
    return match ? match[1] : '';
  }

  function createRequestToken() {
    return 'fo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function getRequestToken() {
    const hash = window.location.hash.slice(1);
    if (!hash.startsWith(REQUEST_HASH_PREFIX)) return '';
    try {
      return decodeURIComponent(hash.slice(REQUEST_HASH_PREFIX.length));
    } catch (_error) {
      return '';
    }
  }

  function parseMessage(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch (_error) {
        return null;
      }
    }
    return value;
  }

  function whenBodyReady(callback) {
    if (document.body) {
      callback();
      return;
    }
    document.addEventListener('DOMContentLoaded', callback, { once: true });
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'fo-facebook-ad-video-toast fo-facebook-ad-video-toast-' + type;
    toast.textContent = message;
    (document.body || document.documentElement).appendChild(toast);
    window.setTimeout(function () {
      toast.remove();
    }, 4500);
  }

  function getErrorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character];
    });
  }

  function installStyles() {
    const styles = `
      .${MENU_ITEM_CLASS} {
        align-items: center;
        border-radius: 8px;
        box-sizing: border-box;
        color: inherit;
        cursor: pointer;
        display: flex;
        font: inherit;
        gap: 10px;
        min-height: 44px;
        padding: 8px 12px;
        user-select: none;
      }
      .${MENU_ITEM_CLASS}:hover,
      .${MENU_ITEM_CLASS}:focus-visible {
        background: rgba(0, 0, 0, .06);
        outline: none;
      }
      .fo-facebook-ad-video-menu-icon {
        align-items: center;
        background: #1877f2;
        border-radius: 50%;
        color: white;
        display: inline-flex;
        font-size: 16px;
        font-weight: 700;
        height: 24px;
        justify-content: center;
        line-height: 1;
        width: 24px;
      }
      .fo-facebook-ad-video-backdrop {
        align-items: center;
        background: rgba(0, 0, 0, .42);
        display: flex;
        inset: 0;
        justify-content: center;
        position: fixed;
        z-index: 2147483647;
      }
      .fo-facebook-ad-video-dialog {
        background: #fff;
        border-radius: 14px;
        box-shadow: 0 14px 44px rgba(0, 0, 0, .24);
        box-sizing: border-box;
        color: #1c1e21;
        max-height: min(680px, calc(100vh - 40px));
        max-width: min(600px, calc(100vw - 32px));
        overflow: auto;
        padding: 22px;
        width: 600px;
      }
      .fo-facebook-ad-video-dialog h2 {
        font: 700 19px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
      }
      .fo-facebook-ad-video-dialog p {
        color: #65676b;
        font: 400 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 8px 0 16px;
      }
      .fo-facebook-ad-video-options {
        display: grid;
        gap: 8px;
      }
      .fo-facebook-ad-video-option,
      .fo-facebook-ad-video-cancel {
        border: 0;
        border-radius: 9px;
        box-sizing: border-box;
        cursor: pointer;
        font: inherit;
        text-align: left;
      }
      .fo-facebook-ad-video-option {
        background: #f0f2f5;
        color: #1c1e21;
        display: grid;
        gap: 4px;
        padding: 12px 14px;
      }
      .fo-facebook-ad-video-option:hover,
      .fo-facebook-ad-video-option:focus-visible {
        background: #e4e6eb;
        outline: 2px solid #1877f2;
        outline-offset: 1px;
      }
      .fo-facebook-ad-video-option span {
        font-size: 15px;
        font-weight: 650;
      }
      .fo-facebook-ad-video-option small {
        color: #65676b;
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fo-facebook-ad-video-cancel {
        background: transparent;
        color: #65676b;
        display: block;
        font-size: 14px;
        margin: 14px 0 0 auto;
        padding: 8px 12px;
      }
      .fo-facebook-ad-video-cancel:hover,
      .fo-facebook-ad-video-cancel:focus-visible {
        background: #f0f2f5;
        outline: none;
      }
      .fo-facebook-ad-video-toast {
        border-radius: 8px;
        bottom: 24px;
        box-shadow: 0 5px 18px rgba(0, 0, 0, .18);
        color: #fff;
        font: 500 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        left: 50%;
        max-width: min(560px, calc(100vw - 32px));
        padding: 11px 16px;
        position: fixed;
        transform: translateX(-50%);
        z-index: 2147483647;
      }
      .fo-facebook-ad-video-toast-error { background: #b42318; }
      .fo-facebook-ad-video-toast-success { background: #18794e; }
    `;

    if (typeof GM_addStyle === 'function') {
      GM_addStyle(styles);
      return;
    }

    const style = document.createElement('style');
    style.textContent = styles;
    (document.head || document.documentElement).appendChild(style);
  }
})();
