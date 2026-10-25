import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

const source = await fs.readFile(new URL('../../src/common/android/bridge.js', import.meta.url), 'utf8');
function harness({failPDF = false, storageMode = 'webdav'} = {}) {
    const storage = {};
    const requests = [];
    const openedTabs = [];
    const saves = new Map();
    const tab = {id: 7, url: 'https://www-nature-com.kyoto-u.idm.oclc.org/articles/example'};
    const pdf = new TextEncoder().encode('%PDF-1.7\nfixture').buffer;
    let listener;
    let failing = failPDF;
    const browser = {
        storage: {local: {
            get: async key => ({[key]: storage[key]}),
            set: async value => Object.assign(storage, structuredClone(value)),
            remove: async key => { delete storage[key]; },
        }},
        runtime: {id: 'test-extension', getURL: path => `moz-extension://test/${path}`, onMessage: {addListener: value => { listener = value; }}},
        tabs: {create: async options => openedTabs.push(options), get: async () => tab, query: async () => [tab], sendMessage: async (_id, message) => {
            if (message.kind === 'android-fetch-pdf') return {error: 'Login required'};
            return {item: {itemType: 'journalArticle', title: 'Paper', url: 'https://www.nature.com/articles/example'},
                attachments: [{id: 'pdf-0', title: 'Article PDF', mimeType: 'application/pdf',
                    url: 'https://www.nature.com/paper.pdf', fetchURL: `${tab.url}/paper.pdf`, referrer: tab.url}]};
        }},
    };
    const Zotero = {
        Proxies: {proxies: [], save(proxy) { this.proxies.push(proxy); }},
        Proxy: class {constructor(properties) { Object.assign(this, properties); }},
        ItemSaver: {_fetchAttachment: async (_attachment, originTab) => {
            assert.equal(originTab.id, 7);
            if (failing) throw new Error('Login required');
            return pdf;
        }},
    };
    const chrome = {runtime: {onMessage: {addListener(callback) {
        listener = (message, sender) => {
            let respond;
            const result = new Promise(resolve => { respond = resolve; });
            return callback(message, sender, respond) === true ? result : undefined;
        };
    }}}};
    const context = {Zotero, browser, chrome, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams,
        AbortController, setTimeout, clearTimeout, setInterval: () => {}, fetch: async (url, options) => {
            requests.push({url, options});
            const path = new URL(url).pathname.replace('/android-connector/v1', '');
            let data;
            let status = 200;
            if (path === '/pair') data = {token: 'paired-token'};
            else if (options.headers.Authorization !== 'Bearer paired-token') { status = 401; data = {error: 'Unauthorized'}; }
            else if (path === '/status') data = {protocolVersion: 1, storageMode};
            else if (path === '/collections') data = [];
            else {
                const [, , saveId, action] = path.split('/');
                if (options.method === 'PUT' && !action) {
                    if (!saves.has(saveId)) saves.set(saveId, {itemKey: 'ABCDEFGH', attachments: [{id: 'pdf-0', received: false}]});
                } else if (action === 'attachments') {
                    assert.ok(options.body instanceof ArrayBuffer);
                    assert.equal(new TextDecoder().decode(options.body.slice(0, 5)), '%PDF-');
                    saves.get(saveId).attachments[0].received = true;
                }
                data = structuredClone(saves.get(saveId));
            }
            return {ok: status === 200, status, json: async () => data};
        }};
    vm.runInNewContext(source, context);
    return {
        storage, requests, saves, openedTabs, setFailing(value) { failing = value; },
        openPanel: tab => Zotero.AndroidBridge.openPanel(tab),
        async init() { await Zotero.AndroidBridge.init(); },
        async call(action, extra = {}) { return listener({kind: 'android-panel', action, ...extra}, {id: 'test-extension', url: browser.runtime.getURL('android/panel.html')}); },
        untrusted() { return listener({kind: 'android-panel', action: 'link'}, {tab, url: tab.url}); },
    };
}

test('opening the panel in a regular tab preserves the article for app switching and saving', async () => {
    const h = harness();
    const article = {id: 7, url: 'https://example.org/paper'};
    await h.openPanel(article);
    assert.equal(h.storage.androidPendingTab.tabId, article.id);
    assert.equal(h.storage.androidPendingTab.sourceURL, article.url);
    assert.equal(h.openedTabs[0].url, 'moz-extension://test/android/panel.html');
    await h.openPanel({id: 8, url: h.openedTabs[0].url});
    assert.equal(h.storage.androidPendingTab.tabId, article.id);
});

test('pairing link contains a challenge, not a reusable credential; web content cannot request it', async () => {
    const h = harness(); await h.init();
    const link = await h.call('link');
    assert.equal(link.ok, true);
    const url = new URL(link.data);
    assert.match(url.searchParams.get('challenge'), /^[a-f0-9]{64}$/);
    assert.ok(!link.data.includes(h.storage.androidClient.verifier));
    assert.equal(h.untrusted(), undefined);
    assert.equal((await h.call('connect')).ok, true);
    assert.equal(h.storage.androidClient.token, 'paired-token');
});

test('proxy PDF failure keeps metadata and retry reuses the same item and attachment IDs', async () => {
    const h = harness({failPDF: true}); await h.init();
    await h.call('connect');
    const first = await h.call('save', {tabId: 7, collectionKey: 'COLLECT1'});
    assert.equal(first.ok, true);
    assert.equal(first.data.stage, 'metadata saved; PDF retry needed');
    const saveId = first.data.saveId;
    assert.equal(h.saves.size, 1);
    h.setFailing(false);
    const retry = await h.call('save', {tabId: 7, collectionKey: 'COLLECT1'});
    assert.equal(retry.ok, true);
    assert.equal(retry.data.saveId, saveId);
    assert.equal(retry.data.receipt.attachments[0].received, true);
    assert.equal(h.saves.size, 1);
    const metadata = h.requests.filter(request => /\/saves\/[^/]+$/.test(request.url) && request.options.method === 'PUT');
    assert.equal(metadata[0].options.body, metadata[1].options.body);
    assert.ok(!metadata[0].options.body.includes('kyoto-u.idm.oclc.org'));
    assert.equal(JSON.parse(metadata[0].options.body).collectionKey, 'COLLECT1');
});

test('disabled WebDAV never accepts metadata or falls back to online-library storage', async () => {
    const h = harness({storageMode: 'disabled'}); await h.init();
    const result = await h.call('save', {tabId: 7});
    assert.equal(result.ok, false);
    assert.match(result.error, /WebDAV/);
    assert.equal(h.saves.size, 0);
    assert.ok(h.requests.every(request => request.url.startsWith('http://127.0.0.1:23119/')));
});
