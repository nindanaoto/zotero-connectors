/* SPDX-License-Identifier: AGPL-3.0-or-later */
Zotero.AndroidBridge = new function() {
    const BASE = 'http://127.0.0.1:23119/android-connector/v1';
    const MAX_PDF = 100 * 1024 * 1024;
    let busy = false;
    let current;
    const random = () => [...crypto.getRandomValues(new Uint8Array(32))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const load = async key => (await browser.storage.local.get(key))[key];
    const store = async (key, value) => browser.storage.local.set({[key]: value});
    const properURL = value => Zotero.Proxies.proxyToProper ? Zotero.Proxies.proxyToProper(value) : value;

    async function client() {
        let value = await load('androidClient');
        if (!value) {
            value = {clientId: random(), verifier: random()};
            await store('androidClient', value);
        }
        return value;
    }

    async function request(path, {method = 'GET', data, binary = false, pairing = false} = {}) {
        const identity = await client();
        const headers = {};
        if (!pairing) headers.Authorization = `Bearer ${identity.token || ''}`;
        if (data !== undefined) headers['Content-Type'] = binary ? 'application/pdf' : 'application/json';
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), binary ? 120000 : 15000);
        try {
            const response = await fetch(`${BASE}${path}`, {
                method, headers, body: data === undefined ? undefined : binary ? data : JSON.stringify(data),
                signal: abort.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
            });
            const value = await response.json();
            if (!response.ok) {
                const error = new Error(value.error || `Zotero returned ${response.status}`);
                error.status = response.status;
                throw error;
            }
            return value;
        } finally { clearTimeout(timer); }
    }

    async function connect() {
        const identity = await client();
        if (!identity.token) {
            const result = await request('/pair', {method: 'POST', pairing: true,
                data: {clientId: identity.clientId, verifier: identity.verifier}});
            identity.token = result.token;
            await store('androidClient', identity);
        }
        const status = await request('/status');
        if (status.protocolVersion !== 1) throw new Error('Update both the Connector and Android app to matching versions.');
        if (status.storageMode !== 'webdav') throw new Error('Enable and verify WebDAV in Zotero first.');
        return status;
    }

    async function launchLink(repair = false) {
        let identity = await client();
        if (repair) {
            identity = {clientId: random(), verifier: random()};
            await store('androidClient', identity);
        }
        const parameters = new URLSearchParams({v: '1', clientId: identity.clientId});
        if (!identity.token) parameters.set('challenge', await hash(identity.verifier));
        return `zotero-connector://connect?${parameters}`;
    }

    async function sourceTab(job) {
        const tabs = await browser.tabs.query({});
        const tab = tabs.find(tab => tab.id === job.tabId && tab.url === job.sourceURL)
            || tabs.find(tab => tab.url === job.sourceURL)
            || tabs.find(tab => /^https?:/.test(tab.url) && properURL(tab.url) === properURL(job.sourceURL));
        if (!tab) throw new Error('Open the original article in Firefox, then retry this save.');
        return tab;
    }

    async function saveJob(job) {
        current = job;
        await store('androidJob', job);
    }

    async function save(tabId, collectionKey) {
        if (busy) throw new Error('A save is already in progress.');
        busy = true;
        current = undefined;
        try {
            await connect();
            let job = await load('androidJob');
            const active = await browser.tabs.get(tabId).catch(error => {
                if (job) return sourceTab(job);
                throw error;
            });
            if (!job || properURL(job.sourceURL) !== properURL(active.url)) {
                if (!/^https?:/.test(active.url)) throw new Error('Open an individual article page first.');
                job = {saveId: random(), tabId, sourceURL: active.url, collectionKey, stage: 'extracting', completed: []};
                await saveJob(job);
            }
            // Prefer the tab the user selected, including a newly authenticated proxy tab.
            const tab = active;
            current = job;
            delete job.error;
            if (!job.payload) {
                job.stage = 'extracting'; await saveJob(job);
                const capture = await browser.tabs.sendMessage(tab.id, {kind: 'android-capture'}, {frameId: 0});
                if (capture?.error) throw new Error(capture.error);
                if (!capture?.item) throw new Error('Reload the article page so the Connector can read it, then retry.');
                job.pdfs = capture.attachments;
                job.payload = {
                    item: capture.item, collectionKey: collectionKey || null,
                    attachments: job.pdfs.map(({fetchURL, referrer, ...descriptor}) => descriptor),
                };
                await saveJob(job);
            }
            else if (job.receipt && job.completed.length < job.pdfs.length) {
                // Refresh publisher tokens without changing already-created Zotero keys.
                const capture = await browser.tabs.sendMessage(tab.id, {kind: 'android-capture'}, {frameId: 0});
                for (const pdf of job.pdfs) {
                    const fresh = capture?.attachments?.find(entry => entry.id === pdf.id);
                    if (fresh) { pdf.fetchURL = fresh.fetchURL; pdf.referrer = fresh.referrer; }
                }
                await saveJob(job);
            }
            if (!job.receipt && job.payload.collectionKey !== (collectionKey || null)) {
                job.payload.collectionKey = collectionKey || null;
                await saveJob(job);
            }
            job.stage = 'saving metadata'; await saveJob(job);
            job.receipt = await request(`/saves/${job.saveId}`, {method: 'PUT', data: job.payload});
            job.completed = job.receipt.attachments.filter(entry => entry.received).map(entry => entry.id);
            const errors = {};
            for (const pdf of job.pdfs) {
                if (job.completed.includes(pdf.id)) continue;
                job.stage = `downloading ${pdf.title}`; await saveJob(job);
                try {
                    const attachment = {url: pdf.fetchURL, mimeType: 'application/pdf', referrer: pdf.referrer};
                    let bytes;
                    try {
                        bytes = await Zotero.ItemSaver._fetchAttachment(attachment, tab, false, MAX_PDF);
                    } catch (_) {
                        // Same-origin page fetch preserves sessions isolated to the active top-level site.
                        const fetched = await browser.tabs.sendMessage(tab.id,
                            {kind: 'android-fetch-pdf', url: pdf.fetchURL}, {frameId: 0});
                        if (fetched?.error) throw new Error(fetched.error);
                        if (!(fetched instanceof ArrayBuffer)) throw new Error('PDF access failed. Sign in through the Kyoto proxy and retry.');
                        bytes = fetched;
                    }
                    if (!bytes.byteLength || bytes.byteLength > MAX_PDF) throw new Error('PDF exceeds the 100 MiB limit or is empty.');
                    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') {
                        throw new Error('The server returned a login or access page. Sign in through the proxy and retry.');
                    }
                    job.stage = `transferring ${pdf.title}`; await saveJob(job);
                    job.receipt = await request(`/saves/${job.saveId}/attachments/${pdf.id}`, {method: 'PUT', binary: true, data: bytes});
                    job.completed.push(pdf.id);
                } catch (_) {
                    // Keep browser URLs/cookies out of persistent error messages.
                    errors[pdf.id] = 'PDF download or transfer failed. Check proxy login and Zotero connection, then retry.';
                }
                await saveJob(job);
            }
            job.receipt = await request(`/saves/${job.saveId}/finish`, {method: 'POST', data: {errors}});
            job.stage = Object.keys(errors).length ? 'metadata saved; PDF retry needed' : 'saved locally; syncing through Zotero';
            await saveJob(job);
            return job;
        } catch (error) {
            if (current) { current.stage = 'paused'; current.error = error.message; await saveJob(current); }
            throw error;
        } finally { busy = false; }
    }

    this.openPanel = async function(tab) {
        if (tab && /^https?:/.test(tab.url)) {
            await store('androidPendingTab', {tabId: tab.id, sourceURL: tab.url});
        }
        const pending = await load('androidPendingTab');
        const parameters = pending ? `?tabId=${pending.tabId}` : '';
        await browser.tabs.create({url: browser.runtime.getURL('android/panel.html') + parameters});
    };

    this.init = async function() {
        const scheme = 'https://%h.kyoto-u.idm.oclc.org/%p';
        if (!Zotero.Proxies.proxies.some(proxy => proxy.toProperScheme === scheme)) {
            Zotero.Proxies.save(new Zotero.Proxy({toProperScheme: scheme,
                toProxyScheme: 'https://kyoto-u.idm.oclc.org/login?url=%u', autoAssociate: false, hosts: []}));
        }
        Zotero.Proxies.transparent = true;
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            // Content scripts and web pages cannot call the save API or obtain pairing material.
            if (message?.kind !== 'android-panel' || sender.id !== browser.runtime.id ||
                !sender.url?.startsWith(browser.runtime.getURL('android/panel.html'))) return;
            (async () => {
                try {
                    let data;
                    switch (message.action) {
                        case 'link': data = await launchLink(message.repair); break;
                        case 'connect': data = await connect(); break;
                        case 'collections': await connect(); data = await request('/collections'); break;
                        case 'save': data = await save(message.tabId, message.collectionKey); break;
                        case 'prepare': {
                            const tab = await browser.tabs.get(message.tabId);
                            if (/^https?:/.test(tab.url)) await store('androidPendingTab', {tabId: tab.id, sourceURL: tab.url});
                            break;
                        }
                        case 'resume': await store('androidResume', Date.now()); break;
                        case 'state': {
                            let job = await load('androidJob');
                            const pending = await load('androidPendingTab');
                            const source = message.tabId == null ? pending : await browser.tabs.get(message.tabId).catch(() => null);
                            const sourceURL = source?.url || source?.sourceURL;
                            // A saved receipt locks only its own article's collection. Keep it
                            // available for retry, but don't show it in another article's panel.
                            if (job && sourceURL && properURL(job.sourceURL) !== properURL(sourceURL)) job = null;
                            if (job && !busy && job.receipt) {
                                try { job.receipt = await request(`/saves/${job.saveId}`); await saveJob(job); } catch (_) {}
                            }
                            data = {busy, job, pending, collectionKey: await load('androidCollection')}; break;
                        }
                        case 'collection': await store('androidCollection', message.collectionKey); break;
                        case 'new': if (busy) throw new Error('Wait for the current save to finish.'); await browser.storage.local.remove('androidJob'); current = null; break;
                        default: throw new Error('Unknown action');
                    }
                    return {ok: true, data};
                } catch (error) { return {ok: false, error: error.message, status: error.status}; }
            })().then(sendResponse);
            return true;
        });
        // Firefox can suspend this timer during the app switch. Storage also lets a reopened
        // panel recover the pending save after the extension process has been restarted.
        setInterval(async () => {
            if (busy) return;
            const requested = await load('androidResume');
            if (!requested || Date.now() - requested > 120000) return;
            try {
                await connect();
                const pending = await load('androidPendingTab');
                if (!pending || busy) return;
                await browser.storage.local.remove('androidResume');
                await save(pending.tabId, await load('androidCollection'));
            } catch (_) { /* The panel offers explicit reconnect and retry actions. */ }
        }, 2000);
    };
};
