import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../../src/common/http.js', import.meta.url), 'utf8');
function handlers(maxSize) {
    const Zotero = {Promise: {defer() {
        const result = {};
        result.promise = new Promise((resolve, reject) => Object.assign(result, {resolve, reject}));
        return result;
    }}};
    vm.runInNewContext(source, {Zotero});
    const xhr = {responseType: 'arraybuffer', abort() { this.aborted = true; this.onabort(); }};
    return {xhr, promise: Zotero.HTTP._attachHandlers('https://publisher.example/paper.pdf', xhr, {maxSize, successCodes: false})};
}

test('binary size limit aborts before the full response is buffered', async () => {
    const {xhr, promise} = handlers(100);
    xhr.onprogress({loaded: 20, total: 101, lengthComputable: true});
    await assert.rejects(promise, /size limit/);
    assert.equal(xhr.aborted, true);
});

test('responses within the limit complete normally', async () => {
    const {xhr, promise} = handlers(100);
    xhr.onprogress({loaded: 50, total: 50, lengthComputable: true});
    xhr.onload();
    assert.equal(await promise, xhr);
    assert.equal(xhr.aborted, undefined);
});
