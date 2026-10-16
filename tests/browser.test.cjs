'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');
const source = readFileSync(resolve(__dirname, '../药方.user.js'), 'utf8');
let browser;

before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.YYAWF_BROWSER_CHANNEL ? { channel: process.env.YYAWF_BROWSER_CHANNEL } : {}),
  });
});
after(async () => { await browser?.close(); });

const article = (id, uid, text) => '<article id="' + id + '"><header><a href="/u/' + uid +
  '" usercard="id=' + uid + '">author</a></header><div class="wbpro-feed-content">' + text + '</div></article>';

async function fixture(t, options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], 'unexpected browser exceptions');
  });
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    (options.noProfile ? '' : '<nav><a id="profile" href="/u/111">profile</a><a id="home" href="/">首页</a></nav>') +
    (options.sidebar ?? '') + '<main>' + (options.html ?? article('feed', '222', 'hello')) + '</main></body></html>';
  // Every document is a local fixture; no requests reach Weibo or a live account.
  await page.route('**/*', route => route.request().resourceType() === 'document'
    ? route.fulfill({ status: 200, contentType: 'text/html', body: html }) : route.abort());
  await page.addInitScript(({ source, options }) => {
    window.unsafeWindow = window;
    window.$CONFIG = { uid: '111', islogin: options.noProfile ? '0' : '1' };
    window.__account = '111';
    window.__store = { CONFIG: { 111: options.config ?? {}, ...options.otherConfigs } };
    if (options.cached) window.__store['BLACKLIST:111'] = { ids: options.cached, updatedAt: Date.now() };
    const listeners = [];
    window.__writes = [];
    window.GM_getValue = (key, fallback) => structuredClone(window.__store[key] ?? fallback);
    window.GM_setValue = (key, value) => {
      window.__store[key] = structuredClone(value);
      window.__writes.push(key);
    };
    window.GM_addValueChangeListener = (key, fn) => listeners.push({ key, fn });
    window.GM_registerMenuCommand = (_name, fn) => { window.__openSettings = fn; };
    window.__updateConfig = config => {
      const previous = structuredClone(window.__store.CONFIG);
      window.__store.CONFIG[window.__account] = config;
      for (const { key, fn } of listeners) {
        if (key === 'CONFIG') fn(key, previous, structuredClone(window.__store.CONFIG), true);
      }
    };
    window.__blacklistCalls = [];
    const response = url => {
      const account = window.__account;
      const ids = options.blacklists?.[account] ?? options.blacklist ?? [];
      const page = Number(new URL(url, location.href).searchParams.get('page') ?? 1);
      const entries = options.pages?.[page - 1] ?? ids;
      return options.invalidBlacklist ? { ok: 0 } : {
        ok: 1, uid: account, total: options.total ?? ids.length,
        next_cursor: options.pages && page < options.pages.length ? page + 1 : 0,
        card_group: entries.map(uid => ({ scheme:
          'sinaweibo://shieldoption?uid=' + uid + '&status=1&interact=1&follow=1',
        })),
      };
    };
    window.fetch = async (url, init = {}) => {
      window.__blacklistCalls.push(String(url));
      const json = response(url);
      if (options.delay) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, options.delay);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
      return { ok: true, json: async () => json };
    };
    window.GM_xmlhttpRequest = config => {
      window.__blacklistCalls.push(config.url);
      queueMicrotask(() => config.onload({ status: 200, finalUrl: config.url, response: response(config.url) }));
      return { abort: () => config.onabort?.() };
    };
    (0, eval)(source);
  }, { source, options });
  await page.goto(options.url ?? 'https://weibo.com/mygroups?gid=11000111');
  await page.waitForFunction(() => typeof window.__openSettings === 'function');
  return page;
}

const filtered = (page, id) => page.waitForFunction(id =>
  document.getElementById(id)?.getAttribute('data-yyawf-filtered') === 'true', id);
const restored = (page, id) => page.waitForFunction(id =>
  !document.getElementById(id)?.hasAttribute('data-yyawf-filtered'), id);

test('legacy author filtering, keywords, reposts and mentions remain distinct', async t => {
  const page = await fixture(t, {
    config: { 'filter::authors': ['222'], 'filter::keywords': ['blocked'] },
    html: article('author', '222', 'hello') + article('keyword', '333', 'blocked') +
      article('mention', '333', 'hello <a href="/u/222" usercard="id=222">@mention</a>') +
      article('repost', '333', 'hello').replace('</article>',
        '<div class="wbpro-feed-reText"><a href="/u/222" usercard="id=222">original</a> hello</div></article>'),
  });
  await filtered(page, 'author');
  await filtered(page, 'keyword');
  await filtered(page, 'repost');
  assert.equal(await page.locator('#mention').getAttribute('data-yyawf-filtered'), null);
  await page.evaluate(() => window.__updateConfig({}));
  await restored(page, 'author');
  await restored(page, 'keyword');
  await restored(page, 'repost');
});

test('recycled feeds and dynamically inserted feeds are reclassified', async t => {
  const page = await fixture(t, { config: { 'filter::keywords': ['blocked'] }, html: article('feed', '222', 'blocked') });
  await filtered(page, 'feed');
  await page.locator('#feed .wbpro-feed-content').evaluate(node => { node.textContent = 'safe'; });
  await restored(page, 'feed');
  await page.locator('main').evaluate((node, markup) => node.insertAdjacentHTML('beforeend', markup), article('new', '333', 'blocked'));
  await filtered(page, 'new');
});

test('visited-super-topic cleanup toggles immediately and preserves nearby cards', async t => {
  const page = await fixture(t, { html:
    '<aside><div class="wbpro-side" id="topics"><h2 class="wbpro-side-tit">经常访问的超话</h2><p>topic</p></div>' +
    '<div class="wbpro-side" id="other"><h2>其他内容</h2></div></aside>',
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#topics')).display === 'none');
  assert.notEqual(await page.locator('#other').evaluate(node => getComputedStyle(node).display), 'none');
  await page.evaluate(() => window.__updateConfig({ 'cleanup::visitedSuperTopic': false }));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#topics')).display !== 'none');
  await page.waitForFunction(() => !document.querySelector('#topics').hasAttribute('data-yyawf-role'));
});

test('native blacklist uses all pages and remains separate from local authors', async t => {
  const page = await fixture(t, { pages: [['222'], ['333']], total: 2, config: { 'filter::authors': ['444'] },
    html: article('first', '222', 'one') + article('second', '333', 'two') + article('local', '444', 'three'),
  });
  for (const id of ['first', 'second', 'local']) await filtered(page, id);
  assert.deepEqual(await page.evaluate(() => window.__store['BLACKLIST:111'].ids), ['222', '333']);
  assert.equal(await page.locator('#local').getAttribute('data-yyawf-filter-reason'), 'author:444');
});

test('a malformed blacklist response preserves the previous cache', async t => {
  const page = await fixture(t, { cached: ['222'], invalidBlacklist: true });
  await filtered(page, 'feed');
  await page.evaluate(() => window.__openSettings());
  await page.waitForFunction(() => document.querySelector('[data-yyawf-owned="dialog"]').shadowRoot
    .querySelector('.blacklist-status').textContent.includes('同步失败'));
  assert.deepEqual(await page.evaluate(() => window.__store['BLACKLIST:111'].ids), ['222']);
});

test('a slow first blacklist sync cannot leave the feed invisible', async t => {
  const page = await fixture(t, { delay: 2500, blacklist: ['222'] });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-yyawf-blacklist-loading'), null, { timeout: 2000 });
  assert.notEqual(await page.locator('#feed').evaluate(node => getComputedStyle(node).visibility), 'hidden');
  await filtered(page, 'feed');
});

test('SPA route changes do not re-fetch the blacklist or hijack detail and home navigation', async t => {
  const page = await fixture(t, { config: { 'feed::latest': true } });
  await page.waitForFunction(() => window.__store['BLACKLIST:111']);
  const initialCalls = await page.evaluate(() => window.__blacklistCalls.length);
  await page.evaluate(() => {
    history.pushState({}, '', '/111/post');
    history.replaceState({}, '', '/');
    history.pushState({}, '', '/111/detail');
  });
  await page.waitForFunction(() => location.pathname === '/111/detail');
  assert.equal(await page.evaluate(() => window.__blacklistCalls.length), initialCalls);
  await page.evaluate(() => document.querySelector('#home').addEventListener('click', event => {
    window.__homePrevented = event.defaultPrevented;
    event.preventDefault();
  }));
  await page.locator('#home').click();
  assert.equal(await page.evaluate(() => window.__homePrevented), false);
});

test('initial home redirect migrates the legacy setting and happens only once', async t => {
  const page = await fixture(t, { url: 'https://weibo.com/', config: { 'home::newest': true } });
  await page.waitForURL('**/mygroups?gid=11000111');
  assert.equal(await page.evaluate(() => window.__store.CONFIG[111]['feed::latest']), true);
  await page.evaluate(() => history.pushState({}, '', '/'));
  await page.waitForFunction(() => location.pathname === '/');
  assert.equal(new URL(page.url()).pathname, '/');
});

test('direct post and hash detail URLs never redirect', async t => {
  const page = await fixture(t, { url: 'https://weibo.com/111/post', config: { 'feed::latest': true } });
  await page.waitForFunction(() => window.__store['BLACKLIST:111']);
  assert.equal(new URL(page.url()).pathname, '/111/post');
  await page.goto('https://weibo.com/#/detail/123');
  await page.waitForFunction(() => typeof window.__openSettings === 'function');
  assert.equal(new URL(page.url()).hash, '#/detail/123');
});

test('local author profiles remain readable', async t => {
  const page = await fixture(t, { url: 'https://weibo.com/u/222', config: { 'filter::authors': ['222'] } });
  await page.waitForFunction(() => window.__store['BLACKLIST:111']);
  assert.equal(await page.locator('#feed').getAttribute('data-yyawf-filtered'), null);
});

test('search pages share account settings and fetch the blacklist through the GM bridge', async t => {
  const card = '<div class="card-wrap" action-type="feed_list_item" id="search"><div class="card-feed">' +
    '<div class="content"><div class="info"><a class="name" href="https://weibo.com/u/222">author</a></div>' +
    '<p node-type="feed_list_content">hello</p></div></div></div>';
  const page = await fixture(t, { url: 'https://s.weibo.com/weibo?q=test', blacklist: ['222'], html: card });
  await filtered(page, 'search');
  assert.equal(await page.evaluate(() => window.__blacklistCalls[0].startsWith('https://weibo.com/ajax/')), true);
});

test('list edits re-read storage and retain concurrent additions and unrelated settings', async t => {
  const page = await fixture(t, { config: { 'filter::keywords': ['one'], custom: 42 } });
  await page.evaluate(() => window.__openSettings());
  await page.evaluate(() => { window.__store.CONFIG[111]['filter::keywords'] = ['one', 'remote']; });
  await page.locator('.keyword-input').fill('local');
  await page.locator('.keyword-form button').click();
  assert.deepEqual(await page.evaluate(() => window.__store.CONFIG[111]['filter::keywords']), ['one', 'remote', 'local']);
  await page.evaluate(() => { window.__store.CONFIG[111]['filter::keywords'].push('later'); });
  await page.locator('.keyword-list button[aria-label="删除 one"]').click();
  assert.deepEqual(await page.evaluate(() => window.__store.CONFIG[111]['filter::keywords']), ['remote', 'local', 'later']);
  assert.equal(await page.evaluate(() => window.__store.CONFIG[111].custom), 42);
  await page.locator('.author-input').fill('https://weibo.com/u/222');
  await page.locator('.author-submit').click();
  await filtered(page, 'feed');
  await page.locator('.author-list button').click();
  await restored(page, 'feed');
});

test('switching accounts clears old rules and aborts the old account sync', async t => {
  const page = await fixture(t, { config: { 'filter::authors': ['222'] }, otherConfigs: { 333: {} }, delay: 400 });
  await filtered(page, 'feed');
  await page.evaluate(() => {
    window.__account = '333';
    document.querySelector('#profile').href = '/u/333';
  });
  await restored(page, 'feed');
  await page.waitForFunction(() => window.__store['BLACKLIST:333']);
  assert.equal(await page.evaluate(() => Boolean(window.__store['BLACKLIST:111'])), false);
});

test('an unconfirmed account cannot change stored configuration', async t => {
  const page = await fixture(t, { noProfile: true });
  await page.evaluate(() => window.__openSettings());
  assert.equal(await page.locator('.author-input').isDisabled(), true);
  await page.locator('.keyword-input').fill('blocked');
  await page.locator('.keyword-form button').click();
  assert.equal(await page.evaluate(() => window.__writes.includes('CONFIG')), false);
});

test('ad cleanup hides metadata ads without matching ordinary content and is reversible', async t => {
  const page = await fixture(t, { config: { 'cleanup::ad': true },
    html: article('ad', '222', 'hello').replace('<article ', '<article data-ad="1" ') +
      article('ordinary', '333', '这条微博讨论广告与推广'),
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#ad')).display === 'none');
  assert.notEqual(await page.locator('#ordinary').evaluate(node => getComputedStyle(node).display), 'none');
  await page.evaluate(() => window.__updateConfig({ 'cleanup::ad': false }));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#ad')).display !== 'none');
});

const comments = '<div class="wbpro-list"><div class="item1" id="comment"><div class="item1in">' +
  '<div><a href="/u/222">avatar</a></div><div class="con1"><div class="text">' +
  '<a href="/u/222">author</a>：blocked text</div></div></div></div></div>';

test('comment filters can be removed live', async t => {
  const page = await fixture(t, { config: { 'filter::authors': ['222'] }, html: comments });
  await filtered(page, 'comment');
  await page.evaluate(() => window.__updateConfig({}));
  await restored(page, 'comment');
});

test('legacy local filters keep the mentions page readable', async t => {
  const page = await fixture(t, { url: 'https://weibo.com/at/weibo',
    config: { 'filter::authors': ['222'], 'filter::keywords': ['blocked'] }, html: comments,
  });
  await page.waitForFunction(() => window.__store['BLACKLIST:111']);
  assert.equal(await page.locator('#comment').getAttribute('data-yyawf-filtered'), null);
});

test('native blacklist still filters mentions-page comments', async t => {
  const page = await fixture(t, { url: 'https://weibo.com/at/weibo', blacklist: ['222'], html: comments });
  await filtered(page, 'comment');
});

test('duplicate blacklist pages cannot replace a complete cache', async t => {
  const page = await fixture(t, { cached: ['222'], pages: [['333'], ['333']], total: 2 });
  await filtered(page, 'feed');
  await page.evaluate(() => window.__openSettings());
  await page.waitForFunction(() => document.querySelector('[data-yyawf-owned="dialog"]').shadowRoot
    .querySelector('.blacklist-status').textContent.includes('同步失败'));
  assert.deepEqual(await page.evaluate(() => window.__store['BLACKLIST:111'].ids), ['222']);
});

test('batch keyword import appends, deduplicates and refreshes remote additions', async t => {
  const page = await fixture(t, { config: { 'filter::keywords': ['one'] } });
  await page.evaluate(() => window.__openSettings());
  await page.locator('.keyword-transfer summary').click();
  await page.evaluate(() => { window.__store.CONFIG[111]['filter::keywords'].push('remote'); });
  await page.locator('.keyword-batch').fill('one\nremote\nlocal\nlocal');
  await page.locator('.keyword-import').click();
  assert.deepEqual(await page.evaluate(() => window.__store.CONFIG[111]['filter::keywords']), ['one', 'remote', 'local']);
  assert.equal(await page.locator('.keyword-list li').count(), 3);
  await page.evaluate(() => { window.__store.CONFIG[111]['filter::keywords'].push('later'); });
  await page.locator('.keyword-batch').fill('later');
  await page.locator('.keyword-import').click();
  assert.equal(await page.locator('.keyword-list li').count(), 4);
});

// Structure captured from the live page: built-ins and custom links share one list.
const customSidebar = '<aside><div class="woo-panel-main"><div id="group-list">' +
  '<a id="all-following" href="/"><div role="link" title="全部关注">全部关注</div></a>' +
  '<a id="latest" href="/mygroups?gid=11000111"><div role="link" title="最新微博">最新微博</div></a>' +
  '<a id="special" href="/mygroups?gid=3568799875773881"><div role="link" title="特别关注">特别关注</div></a>' +
  '<a id="friends" href="/mygroups?gid=10009111"><div role="link" title="好友圈">好友圈</div></a>' +
  '<div id="group-divider" class="woo-divider-main"></div>' +
  '<div id="group-heading" class="woo-box-flex"><h3>自定义分组</h3><button>管理</button></div>' +
  '<a id="quiet-following" href="/mygroups?gid=10005111">悄悄关注</a>' +
  '</div></div></aside>';

const bannerLayout = '<div id="homeWrap"><section id="publisher"><textarea aria-label="发微博"></textarea></section><div>' +
  '<div id="top-banner" class="woo-box-flex"><div class="woo-picture-main">' +
  '<img id="banner-image" src="https://kadmimage.biz.weibo.com/example/banner.jpeg"></div></div>' +
  '<div id="ordinary-picture" class="woo-box-flex"><div class="woo-picture-main">' +
  '<img src="https://h5.sinaimg.cn/example/ordinary.jpeg"></div></div>' +
  '<div class="scroller">' + article('safe-feed', '222',
    '<img src="https://kadmimage.biz.weibo.com/example/shared.jpeg">正文提到自定义分组') +
  '</div></div></div>';

const hidden = (page, id) => page.waitForFunction(id =>
  getComputedStyle(document.getElementById(id)).display === 'none', id);
const visible = (page, id) => page.waitForFunction(id => {
  const node = document.getElementById(id);
  return node && getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0;
}, id);

test('custom groups hide by default while preserving built-in navigation and feed content', async t => {
  const page = await fixture(t, { sidebar: customSidebar,
    html: article('feed', '222', '<h3>自定义分组</h3>普通正文'),
  });
  for (const id of ['group-divider', 'group-heading', 'quiet-following']) await hidden(page, id);
  for (const id of ['all-following', 'latest', 'special', 'friends', 'feed']) await visible(page, id);
  await page.evaluate(() => window.__openSettings());
  await page.locator('button[data-tab="cleanup"]').click();
  const toggle = page.locator('input[data-key="cleanup::customGroups"]');
  assert.equal(await toggle.count(), 1);
  await toggle.uncheck();
  for (const id of ['group-heading', 'quiet-following']) await visible(page, id);
  assert.equal(await page.evaluate(() => window.__store.CONFIG[111]['cleanup::customGroups']), false);
});

test('custom groups inserted dynamically are hidden and stop at the next sidebar section', async t => {
  const page = await fixture(t, { sidebar: customSidebar });
  await page.locator('#group-list').evaluate(node => node.insertAdjacentHTML('beforeend',
    '<a id="new-group" href="/mygroups?gid=123456">新分组</a>' +
    '<div id="next-heading"><h3>其他功能</h3></div><a id="other-group" href="/mygroups?gid=789">其他入口</a>'));
  await hidden(page, 'new-group');
  await visible(page, 'next-heading');
  await visible(page, 'other-group');
});

test('the top commercial banner hides without removing the publisher, normal pictures or posts', async t => {
  const page = await fixture(t, { html: bannerLayout });
  await hidden(page, 'top-banner');
  for (const id of ['publisher', 'ordinary-picture', 'safe-feed']) await visible(page, id);
  await page.evaluate(() => window.__openSettings());
  await page.locator('button[data-tab="cleanup"]').click();
  const toggle = page.locator('input[data-key="cleanup::feedBanner"]');
  assert.equal(await toggle.count(), 1);
  await toggle.uncheck();
  await visible(page, 'top-banner');
  await toggle.check();
  await hidden(page, 'top-banner');
});

test('banner image replacement and lazy loading update only the banner classification', async t => {
  const page = await fixture(t, { html: bannerLayout });
  await hidden(page, 'top-banner');
  await page.locator('#banner-image').evaluate(image => {
    image.src = 'https://h5.sinaimg.cn/example/ordinary.jpeg';
  });
  await visible(page, 'top-banner');
  await page.locator('#banner-image').evaluate(image => {
    image.setAttribute('data-src', 'https://kadmimage.biz.weibo.com/example/lazy.jpeg');
  });
  await hidden(page, 'top-banner');
  await page.locator('#banner-image').evaluate(image => image.removeAttribute('data-src'));
  await visible(page, 'top-banner');
});

test('new cleanup switches respect explicit disabled settings', async t => {
  const page = await fixture(t, {
    sidebar: customSidebar, html: bannerLayout,
    config: { 'cleanup::customGroups': false, 'cleanup::feedBanner': false },
  });
  await page.waitForFunction(() => window.__store['BLACKLIST:111']);
  for (const id of ['group-heading', 'quiet-following', 'top-banner']) await visible(page, id);
});
