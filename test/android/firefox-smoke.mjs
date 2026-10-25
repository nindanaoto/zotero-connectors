// Exercises the actual Firefox MV2 build, translators, cookies, and binary transport.
// The local HTTP receiver stands in for the Android app; no Zotero account is used.
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionId = 'zotero-android-connector@nindanaoto.github.io';
const uuid = 'bcd267f0-bbaf-4cea-9d2d-e4156c785c71';
let metadata;
let uploaded;
let cookieUsed = false;
let browser;
const receipt = () => ({itemKey: 'ABCDEFGH', localStored: true, metadataSynced: true,
    attachments: [{id: 'pdf-0', received: !!uploaded, webdavUploaded: !!uploaded}]});
const api = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer smoke-token') { res.writeHead(401); res.end('{"error":"Unauthorized"}'); return; }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.endsWith('/status')) res.end(JSON.stringify({protocolVersion: 1, storageMode: 'webdav'}));
    else if (url.pathname.endsWith('/collections')) res.end('[{"key":"COLLECT1","name":"Research","parentKey":null}]');
    else if (/\/attachments\//.test(url.pathname)) { uploaded = body; res.end(JSON.stringify(receipt())); }
    else if (req.method === 'PUT') { metadata = JSON.parse(body); res.end(JSON.stringify(receipt())); }
    else res.end(JSON.stringify(receipt()));
});
const publisher = http.createServer((req, res) => {
    if (req.url === '/paper.pdf') {
        cookieUsed = (req.headers.cookie || '').includes('university-session=authenticated');
        res.writeHead(cookieUsed ? 200 : 403, {'Content-Type': cookieUsed ? 'application/pdf' : 'text/html'});
        res.end(cookieUsed ? '%PDF-1.7\nAuthenticated PDF fixture\n%%EOF' : '<html>Please sign in</html>');
        return;
    }
    res.writeHead(200, {'Content-Type': 'text/html', 'Set-Cookie': 'university-session=authenticated; Path=/; HttpOnly; SameSite=Lax'});
    res.end(`<!doctype html><title>Authenticated paper</title>
        <meta name="citation_title" content="Authenticated paper">
        <meta name="citation_author" content="Researcher, Example">
        <meta name="citation_journal_title" content="Fixture Journal">
        <meta name="citation_date" content="2026/10/25">
        <meta name="citation_pdf_url" content="http://127.0.0.1:${publisher.address().port}/paper.pdf">
        <h1>Authenticated paper</h1>`);
});
try {
    await new Promise(resolve => api.listen(23119, '127.0.0.1', resolve));
    await new Promise(resolve => publisher.listen(0, '127.0.0.1', resolve));
    browser = await puppeteer.launch({browser: 'firefox', headless: true, protocolTimeout: 20000,
        extraPrefsFirefox: {'extensions.webextensions.uuids': JSON.stringify({[extensionId]: uuid})}});
    await browser.installExtension(path.join(root, 'build/firefox-android'));
    console.log('Installed Android build in Firefox.');
    const panel = await browser.newPage();
    panel.on('pageerror', error => console.error('Panel:', error.message));
    // Firefox BiDi can omit navigation events for extension pages even after the DOM loads.
    await panel.goto(`moz-extension://${uuid}/android/panel.html`, {waitUntil: 'domcontentloaded', timeout: 2000}).catch(async error => {
        if (!await panel.evaluate(() => location.pathname === '/android/panel.html' && !!browser.runtime)) throw error;
    });
    console.log('Opened save panel.');
    const startup = await panel.evaluate(async () => {
        const bg = await browser.runtime.getBackgroundPage();
        return {initialized: bg?.Zotero?.initialized, android: bg?.Zotero?.isAndroid,
            errors: await bg?.Zotero?.Errors?.getErrors()};
    });
    console.log('Background:', startup);
    assert.equal(startup.initialized, true, 'The extension background must initialize');
    assert.equal(await panel.evaluate(async () => (await browser.runtime.getBackgroundPage()).Zotero.Proxies.proxyToProper(
        'https://www-nature-com.kyoto-u.idm.oclc.org/articles/example')), 'https://www.nature.com/articles/example');
    const code = await fs.readFile(path.join(root, 'src/zotero/translators/Embedded Metadata.js'), 'utf8');
    const translatorMetadata = JSON.parse(code.match(/^\s*{[\s\S]*?}\s*?[\r\n]/)[0]);
    await panel.evaluate(async ({code, metadata}) => {
        const bg = await browser.runtime.getBackgroundPage();
        const Zotero = bg.Zotero;
        await Zotero.Prefs.set('translatorMetadata', [metadata]);
        await Zotero.Prefs.set(Zotero.Translators.PREFS_TRANSLATOR_CODE_PREFIX + metadata.translatorID, code);
        Zotero.Translators._loadTranslator(new Zotero.Translator(metadata));
        // First-run repository initialization can still be in flight. This fixture already
        // supplied its complete translator cache and must not depend on the public repo.
        Zotero.Translators.init = async () => {};
        await browser.storage.local.set({androidClient: {clientId: 'smoke', token: 'smoke-token'}, androidCollection: 'COLLECT1'});
    }, {code, metadata: translatorMetadata});
    console.log('Seeded translator and connection.');
    const article = await browser.newPage();
    await article.goto(`http://127.0.0.1:${publisher.address().port}/article`, {waitUntil: 'domcontentloaded'});
    console.log('Opened authenticated article.');
    const articleId = await panel.evaluate(async url => (await browser.tabs.query({})).find(tab => tab.url === url).id, article.url());
    console.log('Saving source tab', articleId);
    const result = await panel.evaluate(async tabId => browser.runtime.sendMessage({kind: 'android-panel', action: 'save', tabId, collectionKey: 'COLLECT1'}), articleId);
    assert.equal(result.ok, true, result.error);
    assert.equal(metadata.item.title, 'Authenticated paper');
    assert.equal(metadata.collectionKey, 'COLLECT1');
    assert.ok(uploaded, JSON.stringify(result.data));
    assert.equal(uploaded.subarray(0, 5).toString(), '%PDF-');
    assert.equal(cookieUsed, true, 'The download must use the authenticated browser session');
    console.log('Firefox smoke passed: real translator metadata and authenticated PDF delivered to the local bridge.');
} finally {
    await browser?.close();
    api.closeAllConnections(); publisher.closeAllConnections();
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => publisher.close(resolve))]);
}
