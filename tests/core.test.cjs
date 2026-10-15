'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(resolve(__dirname, '../药方.user.js'), 'utf8');
const context = vm.createContext({ __YYAWF_TEST_MODE__: true, URL });
vm.runInContext(source, context);
const api = context.__YYAWF_TEST_API__;
const plain = value => JSON.parse(JSON.stringify(value));

test('userscript uses its maintained name, retains the upstream namespace and disables foreign updates', () => {
  assert.match(source, /^\/\/ @name +药方$/m);
  assert.match(source, /^\/\/ @namespace +https:\/\/github.com\/tiansh$/m);
  assert.match(source, /^\/\/ @updateURL +none$/m);
  assert.doesNotMatch(source, /^\/\/ @downloadURL /m);
});

test('migrates legacy keys without losing author lists or other accounts', () => {
  const original = {
    111: { 'home::newest': true, 'cleanup::searchTop': true, 'filter::authors': ['222'], future: 7 },
    333: { 'home::newest': false, 'cleanup::visitedSuperTopic': false },
    metadata: { untouched: true },
  };
  const snapshot = JSON.stringify(original);
  const { store, changed } = api.migrateConfigStore(original);
  assert.equal(changed, true);
  assert.equal(store[111]['feed::latest'], true);
  assert.equal(store[333]['feed::latest'], false);
  assert.equal(store[111]['cleanup::searchPromoted'], true);
  assert.deepEqual(plain(store[111]['filter::authors']), ['222']);
  assert.equal(store[111].future, 7);
  assert.equal(store[333]['cleanup::visitedSuperTopic'], false);
  assert.equal(store[111]['home::newest'], undefined);
  assert.equal(store[111]['cleanup::searchTop'], undefined);
  assert.deepEqual(plain(store.metadata), { untouched: true });
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(api.migrateConfigStore(store).changed, false);
});

test('explicit new settings take priority over legacy settings', () => {
  const { store } = api.migrateConfigStore({ 111: {
    'home::newest': true, 'feed::latest': false,
    'cleanup::searchTop': true, 'cleanup::searchPromoted': false,
  } });
  assert.equal(store[111]['feed::latest'], false);
  assert.equal(store[111]['cleanup::searchPromoted'], false);
});

test('invalid stores and wrong input types do not become valid settings', () => {
  for (const value of [null, [], 'invalid', 9]) {
    assert.deepEqual(plain(api.migrateConfigStore(value)), { store: {}, changed: false });
  }
  assert.deepEqual(plain(api.sanitizeConfig({
    'cleanup::ad': 'true', 'filter::keywords': [' x ', 'x', 5, null],
    'filter::authors': ['222', ' 333 ', '222', 'name', '0', 444], unknown: true,
  })), { 'filter::keywords': ['x'], 'filter::authors': ['222', '333'] });
});

test('retains repository defaults and explicit disabled switches', () => {
  assert.equal(api.resolveConfig({})['feed::latest'], false);
  assert.equal(api.resolveConfig({})['cleanup::visitedSuperTopic'], true);
  assert.equal(api.resolveConfig({ 'cleanup::visitedSuperTopic': false })['cleanup::visitedSuperTopic'], false);
});

test('keyword import handles line endings and literal angle brackets', () => {
  const keywords = api.parseKeywordText('\ufefffirst\r\n second \nfirst\r<tag>\n');
  assert.deepEqual(plain(keywords), ['first', 'second', '<tag>']);
  assert.equal(api.serializeKeywords(keywords), 'first\nsecond\n<tag>');
  const plan = api.compileWorkPlan({ 'filter::keywords': ['<tag>'] });
  assert.equal(api.filterDecision({ text: 'literal <tag>', plan }).hidden, true);
  assert.equal(api.filterDecision({ text: 'literal tag', plan }).hidden, false);
});

test('combines local authors with native blacklist without mutating the native cache', () => {
  const native = new Set(['333']);
  const plan = api.compileWorkPlan({ 'filter::authors': ['222'] }, native);
  assert.equal(plan.hasFilter, true);
  assert.equal(plan.comments, true);
  assert.deepEqual([...native], ['333']);
  assert.equal(api.filterDecision({ userIds: ['222'], plan }).reason, 'author');
  assert.equal(api.filterDecision({ userIds: ['333'], plan }).reason, 'blacklist');
  assert.equal(api.filterDecision({ userIds: ['444'], plan }).hidden, false);
});

test('visiting a local blocked author profile exempts only that author', () => {
  const plan = api.compileWorkPlan({ 'filter::authors': ['222', '333'] }, new Set(['333']));
  assert.equal(api.filterDecision({ userIds: ['222'], profileId: '222', plan }).hidden, false);
  assert.equal(api.filterDecision({ userIds: ['333'], profileId: '333', plan }).hidden, true);
  assert.equal(api.filterDecision({ userIds: ['222'], profileId: '444', plan }).hidden, true);
});

test('disabled cleanup has no work and visited-super-topic cleanup can be restored', () => {
  const off = { 'cleanup::visitedSuperTopic': false };
  assert.equal(api.compileWorkPlan(off).hasDomWork, false);
  const on = api.resolveConfig({});
  assert.equal(api.compileWorkPlan(on).sidebar, true);
  assert.match(api.buildCleanupCss(on), /visited-super-topic/);
  assert.doesNotMatch(api.buildCleanupCss(off), /visited-super-topic/);
});

test('only exact homepage URLs qualify for initial latest-feed redirect', () => {
  const config = { 'feed::latest': true };
  for (const href of ['https://weibo.com/', 'https://weibo.com/home', 'https://www.weibo.com/']) {
    assert.equal(api.shouldRedirectToLatest({ href, profileId: '111', config }), true, href);
  }
  for (const href of ['https://weibo.com/111/post', 'https://weibo.com/?id=post',
    'https://weibo.com/#/detail/123', 'https://s.weibo.com/', 'https://example.com/', '/mygroups']) {
    assert.equal(api.shouldRedirectToLatest({ href, profileId: '111', config }), false, href);
  }
  assert.equal(api.shouldRedirectToLatest({ href: '/', profileId: '111' }), false);
  assert.equal(api.shouldRedirectToLatest({ href: '/', profileId: '', config }), false);
  assert.equal(api.latestFeedPath('111'), '/mygroups?gid=11000111');
});

test('extracts numeric Weibo identities and rejects unrelated domains', () => {
  for (const href of ['/u/222', 'https://weibo.com/222/post', '//www.weibo.com/u/222']) {
    assert.equal(api.extractUserIdFromHref(href), '222');
  }
  for (const href of ['https://evil.example/u/222', 'https://weibo.com.evil.example/u/222', '/nickname']) {
    assert.equal(api.extractUserIdFromHref(href), '');
  }
  assert.equal(api.profileUserIdFromPath('/222'), '222');
  assert.equal(api.profileUserIdFromPath('/u/222'), '222');
  assert.equal(api.profileUserIdFromPath('/222/post'), '');
});

const blacklistPage = overrides => ({
  ok: 1, uid: '111', total: 2, next_cursor: 0,
  card_group: [
    { scheme: 'sinaweibo://shieldoption?uid=222&status=1&interact=1&follow=1' },
    { scheme: 'sinaweibo://shieldoption?uid=333&status=1&interact=0&follow=1' },
  ], ...overrides,
});

test('native blacklist includes only fully selected blocking scopes', () => {
  assert.deepEqual(plain(api.parseBlacklistPage(blacklistPage(), '111')), {
    entries: [{ uid: '222', blocked: true }, { uid: '333', blocked: false }], total: 2, hasMore: false,
  });
});

test('rejects changed accounts, invalid totals and malformed blacklist entries', () => {
  for (const page of [null, blacklistPage({ uid: '333' }), blacklistPage({ total: -1 }),
    blacklistPage({ next_cursor: 'invalid' }), blacklistPage({ card_group: [{ scheme: 'https://example.com/' }] })]) {
    assert.throws(() => api.parseBlacklistPage(page, '111'));
  }
});

test('favorite tag collapse always preserves required tags', () => {
  const visible = api.visibleFavoriteTagIndices([40, 40, 40, 40, 40, 40], 100, 10, [0, 5]);
  assert.equal(visible.has(0), true);
  assert.equal(visible.has(5), true);
  assert.equal(visible.size, 4);
  assert.equal(api.visibleFavoriteTagIndices([40, 40, 40], 0, 10, [0]).size, 3);
});
