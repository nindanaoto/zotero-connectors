import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../../src/browserExt/webRequestIntercept.js', import.meta.url), 'utf8');
test('mobile proxy header overrides exclude localhost and unrelated concurrent requests', async () => {
    let rule;
    const Zotero = {
        isAndroid: true,
        Utilities: {quotemeta: value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},
        Connector_Browser: {setKeepServiceWorkerAlive() {}}, debug() {}, logError(error) { throw error; },
    };
    const browser = {runtime: {getURL: () => 'moz-extension://test/'},
        declarativeNetRequest: {updateSessionRules: async ({addRules}) => { rule = addRules[0]; }}};
    vm.runInNewContext(source, {Zotero, browser, URL, setTimeout() {}});
    const pdfURL = 'https://www-nature-com.kyoto-u.idm.oclc.org/paper.pdf?token=a.b';
    await Zotero.WebRequestIntercept.replaceHeadersDNR(pdfURL, [{name: 'Cookie', value: 'session=fixture'}]);
    const matcher = new RegExp(rule.condition.regexFilter);
    assert.equal(matcher.test(pdfURL), true);
    assert.equal(matcher.test('http://127.0.0.1:23119/android-connector/v1/status'), false);
    assert.equal(matcher.test(pdfURL + '&other=1'), false);
    assert.deepEqual([...rule.condition.initiatorDomains], ['test']);
});
