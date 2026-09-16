// ==UserScript==
// @name         Facebook Ad Library 视频下载助手
// @namespace    fo-tools
// @version      1.0.2
// @downloadURL  https://facebook-monkey-toolkit.d2bot.workers.dev/facebook-ad-video-downloader.user.js
// @updateURL    https://facebook-monkey-toolkit.d2bot.workers.dev/facebook-ad-video-downloader.user.js
// @description  在 Facebook Ad Library 的视频广告菜单中增加视频解析与下载入口
// @match        https://www.facebook.com/ads/library/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      www.facebook.com
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const MENU_ITEM_CLASS = 'fo-facebook-ad-video-menu-item';
  const VIDEO_SELECTOR = 'video, [aria-label*="Play video"], [aria-label*="Play Video"]';
  const REQUEST_TIMEOUT_MS = 20_000;

  installStyles();
  runLibraryPage();

  function runLibraryPage() {
    const pendingRequests = new Map();
    const observer = new MutationObserver(function () {
      decorateOpenMenus();
    });

    whenBodyReady(function () {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ownerid'],
        childList: true,
        subtree: true
      });
      decorateOpenMenus();
    });

    window.addEventListener('pagehide', function () {
      observer.disconnect();
    }, { once: true });

    function decorateOpenMenus() {
      document.querySelectorAll('[role="menu"]').forEach(function (menu) {
        const existingItem = menu.querySelector('.' + MENU_ITEM_CLASS);
        const card = findAdCard(menu);
        const id = getVideoAdId(card);

        if (!id) {
          if (existingItem) existingItem.remove();
          return;
        }

        const pendingRequest = pendingRequests.get(id);
        if (existingItem && existingItem.dataset.libraryId === id) {
          setDownloadMenuItemState(
            existingItem,
            pendingRequest ? 'loading' : 'idle'
          );
          return;
        }

        if (existingItem) existingItem.remove();

        const item = createDownloadMenuItem(id, function () {
          if (pendingRequests.has(id)) return;

          const request = setRequestPending(id, true);
          requestVideoUrls(id, function (urls) {
            if (pendingRequests.get(id) !== request) return;
            setRequestPending(id, false);
            showVideoPicker(id, urls);
          }, function (message) {
            if (pendingRequests.get(id) !== request) return;
            setRequestPending(id, false);
            showToast(message, 'error');
          });
        });

        if (pendingRequest) {
          setDownloadMenuItemState(item, 'loading');
        }
        menu.appendChild(item);
      });
    }

    function setRequestPending(id, isPending) {
      let request = null;
      if (isPending) {
        request = {};
        pendingRequests.set(id, request);
      } else {
        pendingRequests.delete(id);
      }

      document.querySelectorAll(
        '.' + MENU_ITEM_CLASS + '[data-library-id="' + id + '"]'
      ).forEach(function (item) {
        setDownloadMenuItemState(item, isPending ? 'loading' : 'idle');
      });

      return request;
    }
  }

  function requestVideoUrls(id, onSuccess, onError) {
    const detailUrl = new URL('https://www.facebook.com/ads/library');
    detailUrl.searchParams.set('id', id);

    if (typeof GM_xmlhttpRequest !== 'function') {
      onError('当前用户脚本环境不支持后台请求。');
      return;
    }

    try {
      GM_xmlhttpRequest({
        method: 'GET',
        url: detailUrl.toString(),
        timeout: REQUEST_TIMEOUT_MS,
        onload: function (response) {
          if (!response || response.status < 200 || response.status >= 300) {
            const status = response && response.status ? '（HTTP ' + response.status + '）' : '';
            onError('请求广告详情失败' + status + '。');
            return;
          }

          const urls = extractVideoUrls(response.responseText);
          if (urls.length === 0) {
            onError('广告详情原始 HTML 中没有找到 MP4 视频链接。');
            return;
          }

          onSuccess(urls);
        },
        onerror: function () {
          onError('请求广告详情失败，请重试。');
        },
        ontimeout: function () {
          onError('请求广告详情超时，请重试。');
        }
      });
    } catch (_error) {
      onError('无法发起广告详情请求。');
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
        .replace(/\\u0026/gi, '&')
        .replace(/\\u003D/gi, '=')
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
    item.dataset.libraryId = id;
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '0');
    const icon = document.createElement('span');
    icon.className = 'fo-facebook-ad-video-menu-icon';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'fo-facebook-ad-video-menu-label';
    item.append(icon, label);
    setDownloadMenuItemState(item, 'idle');

    item.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (item.dataset.state === 'loading') return;
      onClick(id);
    });

    item.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      if (item.dataset.state === 'loading') return;
      onClick(id);
    });

    return item;
  }

  function setDownloadMenuItemState(item, state) {
    if (item.dataset.state === state) return;

    const isLoading = state === 'loading';
    const icon = item.querySelector('.fo-facebook-ad-video-menu-icon');
    const label = item.querySelector('.fo-facebook-ad-video-menu-label');

    item.dataset.state = state;
    item.className = MENU_ITEM_CLASS +
      (isLoading ? ' ' + MENU_ITEM_CLASS + '-loading' : '');
    item.setAttribute('aria-busy', isLoading ? 'true' : 'false');
    item.setAttribute('aria-disabled', isLoading ? 'true' : 'false');

    if (isLoading) {
      item.setAttribute('aria-label', '正在获取视频，请稍候');
      item.title = '';
      icon.textContent = '';
      label.textContent = '正在获取视频…';
      return;
    }

    item.setAttribute('aria-label', '下载视频');
    item.title = '';
    icon.textContent = '↓';
    label.textContent = '下载视频';
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
    let card = null;

    while (current && current !== document.body) {
      const ids = extractLibraryIds(current);

      if (ids.length > 1) {
        break;
      }

      if (ids.length === 1) {
        card = current;
      }

      current = current.parentElement;
    }

    return card;
  }

  function getVideoAdId(card) {
    if (!card || !card.querySelector(VIDEO_SELECTOR)) return '';
    return extractLibraryId(card);
  }

  function extractLibraryId(root) {
    return extractLibraryIds(root)[0] || '';
  }

  function extractLibraryIds(root) {
    if (!root) return [];

    const ids = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();

    while (textNode) {
      const text = (textNode.nodeValue || '').trim();
      const match = text.match(/^(?:Library ID|资料库编号|檔案庫編號)\s*[:：]\s*(\d+)$/i);
      if (match) ids.add(match[1]);
      textNode = walker.nextNode();
    }

    return Array.from(ids);
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
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    (document.body || document.documentElement).appendChild(toast);
    window.setTimeout(function () {
      toast.remove();
    }, 4500);
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
      .${MENU_ITEM_CLASS}-loading {
        color: #65676b;
        cursor: progress;
      }
      .${MENU_ITEM_CLASS}-loading:hover,
      .${MENU_ITEM_CLASS}-loading:focus-visible {
        background: rgba(0, 0, 0, .04);
      }
      .fo-facebook-ad-video-menu-icon {
        align-items: center;
        color: #050505;
        display: inline-flex;
        font-size: 18px;
        font-weight: 600;
        height: 24px;
        justify-content: center;
        line-height: 1;
        width: 24px;
      }
      .${MENU_ITEM_CLASS}-loading .fo-facebook-ad-video-menu-icon::before {
        animation: fo-facebook-ad-video-spin 700ms linear infinite;
        border: 2px solid rgba(5, 5, 5, .28);
        border-radius: 50%;
        border-top-color: #050505;
        box-sizing: border-box;
        content: "";
        height: 12px;
        width: 12px;
      }
      @keyframes fo-facebook-ad-video-spin {
        to { transform: rotate(360deg); }
      }
      @media (prefers-reduced-motion: reduce) {
        .${MENU_ITEM_CLASS}-loading .fo-facebook-ad-video-menu-icon::before {
          animation: none;
        }
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
