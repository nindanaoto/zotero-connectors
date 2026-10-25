/* SPDX-License-Identifier: AGPL-3.0-or-later */
const $ = id => document.getElementById(id);
let sourceId;
let populated = false;
let updating = false;
async function call(action, args = {}) {
    const result = await browser.runtime.sendMessage({kind: 'android-panel', action, ...args});
    if (!result?.ok) throw new Error(result?.error || 'The Connector is starting. Reopen this panel.');
    return result.data;
}

async function refresh() {
    if (updating) return;
    updating = true;
    try {
        const state = await call('state');
        if (!populated && state.collectionKey && !$('collection').querySelector('option[data-remembered]')) {
            const remembered = document.createElement('option');
            remembered.value = state.collectionKey; remembered.textContent = 'Last collection (connect to view)';
            remembered.dataset.remembered = 'true'; $('collection').append(remembered);
            $('collection').value = state.collectionKey;
        }
        sourceId ??= state.pending?.tabId;
        const job = state.job;
        if (!state.busy && (job?.error || job?.receipt?.syncError)) $('error').textContent = job.error || job.receipt.syncError;
        $('progress').textContent = job?.stage || 'Ready to save an individual article and its PDFs.';
        $('attachments').replaceChildren();
        for (const entry of job?.receipt?.attachments || []) {
            const row = document.createElement('li');
            row.textContent = entry.webdavUploaded ? 'PDF synced to WebDAV' : entry.received ? 'PDF saved locally; sync pending' : 'PDF missing; retry after signing into the proxy';
            $('attachments').append(row);
        }
        if (job?.receipt?.metadataSynced && !state.busy) $('progress').textContent = 'Metadata synced. ' + (job.receipt.attachments.length ? '' : 'No PDF was found on this page.');
        $('save').disabled = state.busy || !sourceId;
        $('collection').disabled = state.busy || !!job?.receipt;
        $('new').disabled = state.busy;
        try {
            await call('connect');
            $('connection').textContent = 'Connected to Zotero · WebDAV';
            $('launch').hidden = true;
            $('repair').hidden = true;
            if (!populated) {
                const collections = await call('collections');
                $('collection').replaceChildren();
                const root = document.createElement('option'); root.value = ''; root.textContent = 'My Library';
                $('collection').append(root);
                const byKey = new Map(collections.map(entry => [entry.key, entry]));
                for (const entry of collections) {
                    const ancestors = [];
                    let parent = entry.parentKey;
                    const seen = new Set([entry.key]);
                    while (parent && byKey.has(parent) && !seen.has(parent)) {
                        seen.add(parent); ancestors.unshift(byKey.get(parent).name); parent = byKey.get(parent).parentKey;
                    }
                    const option = document.createElement('option');
                    option.value = entry.key; option.textContent = [...ancestors, entry.name].join(' / ');
                    $('collection').append(option);
                }
                $('collection').value = state.collectionKey || '';
                if (!$('collection').value) $('collection').value = '';
                populated = true;
            }
        } catch (_) {
            $('connection').textContent = 'Open Zotero to connect, or pair again if pairing was revoked.';
            $('launch').href = await call('link');
            $('launch').hidden = false;
            $('repair').hidden = false;
        }
    } catch (error) { $('error').textContent = error.message; }
    finally { updating = false; }
}

$('repair').addEventListener('click', async () => {
    $('launch').href = await call('link', {repair: true});
    $('connection').textContent = 'Tap Open Zotero and approve pairing, then return here.';
});
$('collection').addEventListener('change', () => call('collection', {collectionKey: $('collection').value}).catch(error => { $('error').textContent = error.message; }));
$('save').addEventListener('click', async () => {
    $('error').textContent = '';
    $('save').disabled = true;
    try { await call('connect'); }
    catch (_) {
        await call('collection', {collectionKey: $('collection').value});
        await call('resume');
        $('error').textContent = 'Tap Open Zotero to continue this save.';
        await refresh();
        return;
    }
    try { await call('save', {tabId: sourceId, collectionKey: $('collection').value}); }
    catch (error) { $('error').textContent = error.message; }
    await refresh();
});
$('new').addEventListener('click', async () => {
    try { await call('new'); $('error').textContent = ''; await refresh(); }
    catch (error) { $('error').textContent = error.message; }
});
(async () => {
    const [tab] = await browser.tabs.query({active: true, currentWindow: true});
    if (tab && /^https?:/.test(tab.url)) {
        sourceId = tab.id;
        await call('prepare', {tabId: tab.id});
        const url = new URL(tab.url);
        if (url.hostname !== 'kyoto-u.idm.oclc.org' && !url.hostname.endsWith('.kyoto-u.idm.oclc.org')) {
            $('proxy').href = `https://kyoto-u.idm.oclc.org/login?url=${encodeURIComponent(tab.url)}`;
            $('proxy').hidden = false;
        }
    }
    await refresh();
    setInterval(refresh, 2000);
})().catch(error => { $('error').textContent = error.message; });
