/* SPDX-License-Identifier: AGPL-3.0-or-later */
const $ = id => document.getElementById(id);
const sourceParameter = new URL(location.href).searchParams.get('tabId');
let sourceId = sourceParameter && /^\d+$/.test(sourceParameter) ? Number(sourceParameter) : undefined;
let populated = false;
let updating = false;
let resetNotice = false;
async function call(action, args = {}) {
    const result = await browser.runtime.sendMessage({kind: 'android-panel', action, ...args});
    if (!result?.ok) throw new Error(result?.error || 'The Connector is starting. Reopen this panel.');
    return result.data;
}

async function refresh() {
    if (updating) return;
    updating = true;
    try {
        const state = await call('state', {tabId: sourceId});
        if (!populated && state.collectionKey && !$('collection').querySelector('option[data-remembered]')) {
            const remembered = document.createElement('option');
            remembered.value = state.collectionKey; remembered.textContent = 'Last collection (connect to view)';
            remembered.dataset.remembered = 'true'; $('collection').append(remembered);
            $('collection').value = state.collectionKey;
        }
        sourceId ??= state.pending?.tabId;
        const job = state.job;
        if (!state.busy && (job?.error || job?.receipt?.syncError)) $('error').textContent = job.error || job.receipt.syncError;
        $('progress').textContent = job?.stage || (resetNotice
            ? 'Previous save cleared. Tap Save paper to start a new save.'
            : 'Choose a collection, then tap Save paper to save the article and its PDFs.');
        $('attachments').replaceChildren();
        for (const entry of job?.receipt?.attachments || []) {
            const row = document.createElement('li');
            row.textContent = entry.webdavUploaded ? 'PDF synced to WebDAV' : entry.received ? 'PDF saved locally; sync pending' : 'PDF missing; retry after signing into the proxy';
            if (!entry.received) {
                const pdf = job.pdfs?.find(pdf => pdf.id === entry.id);
                if (pdf?.fetchURL && /^https?:\/\//i.test(pdf.fetchURL)) {
                    row.textContent = 'PDF not downloaded. Open it in Firefox, complete any verification or sign-in, then return here and retry.';
                    const link = document.createElement('a');
                    link.href = pdf.fetchURL;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.textContent = 'Open PDF in Firefox';
                    row.append(link);
                }
            }
            $('attachments').append(row);
        }
        if (job?.receipt?.metadataSynced && !state.busy) $('progress').textContent = 'Metadata synced. ' + (job.receipt.attachments.length ? '' : 'No PDF was found on this page.');
        $('save').disabled = state.busy || !sourceId;
        $('save').textContent = job?.receipt ? 'Retry PDF / check sync' : 'Save paper';
        $('collection').disabled = state.busy || !!job?.receipt;
        $('new').disabled = state.busy;
        $('new').hidden = !job;
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
    resetNotice = false;
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
    try { await call('new'); resetNotice = true; $('error').textContent = ''; await refresh(); }
    catch (error) { $('error').textContent = error.message; }
});
(async () => {
    const [tab] = await browser.tabs.query({active: true, currentWindow: true});
    if (tab && /^https?:/.test(tab.url)) {
        sourceId = tab.id;
        await call('prepare', {tabId: tab.id});
    }
    await refresh();
    setInterval(refresh, 2000);
})().catch(error => { $('error').textContent = error.message; });
