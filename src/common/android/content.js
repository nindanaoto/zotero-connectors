/* SPDX-License-Identifier: AGPL-3.0-or-later */
// Runs in the extension's isolated world; no page script receives bridge credentials.
if (Zotero.isAndroid && window === window.top) {
    // Use callback listeners like messaging_inject.js: Firefox can otherwise resolve
    // an unrelated listener's undefined return before the asynchronous response.
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (sender.id !== browser.runtime.id) return;
        if (message?.kind === 'android-fetch-pdf') {
            (async () => {
                const url = new URL(message.url);
                if (url.origin !== location.origin) return {error: 'The PDF requires browser-session access on another origin.'};
                const abort = new AbortController();
                const timer = setTimeout(() => abort.abort(), 60000);
                try {
                    const response = await fetch(url.href, {credentials: 'include', signal: abort.signal});
                    if (!response.ok) return {error: 'PDF access failed. Sign in through the proxy and retry.'};
                    const reader = response.body.getReader();
                    const chunks = [];
                    let length = 0;
                    while (true) {
                        const {value, done} = await reader.read();
                        if (done) break;
                        length += value.byteLength;
                        if (length > 100 * 1024 * 1024) { await reader.cancel(); return {error: 'PDF exceeds 100 MiB.'}; }
                        chunks.push(value);
                    }
                    const bytes = new Uint8Array(length);
                    let offset = 0;
                    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
                    return bytes.buffer;
                } finally { clearTimeout(timer); }
            })().then(sendResponse, error => sendResponse({error: error.message}));
            return true;
        }
        if (message?.kind !== 'android-capture') return;
        (async () => {
            let initializationTimer;
            try {
                await Promise.race([Zotero.initDeferred.promise, new Promise((_, reject) => {
                    initializationTimer = setTimeout(() => reject(new Error('The page could not initialize the Connector. Reload it and retry.')), 15000);
                })]);
            } finally { clearTimeout(initializationTimer); }
            const translate = await Zotero.TranslateWeb._initTranslate({doc: document, location: location.href});
            const translators = await translate.getTranslators(true);
            const single = translators.filter(translator => translator.itemType !== 'multiple');
            if (!single.length || translators[0]?.itemType === 'multiple') {
                throw new Error('Open an individual article page before saving.');
            }
            const result = await Zotero.TranslateWeb.translate({
                translate, translators: single,
                onSelect: (_translate, _items, callback) => callback({}),
            });
            if (result.items.length !== 1) throw new Error('This version saves one paper at a time.');
            const {attachments = [], notes, ...raw} = result.items[0];
            const item = JSON.parse(JSON.stringify(raw));
            const proxy = result.proxy;
            const fetchProxy = proxy && new Zotero.Proxy({...proxy.toJSON(), toProxyScheme: undefined});
            const canonical = value => proxy ? proxy.toProper(value) : value;
            item.url = canonical(item.url || document.querySelector('link[rel="canonical"]')?.href || location.href);
            const pdfs = attachments.filter(attachment => attachment.mimeType === 'application/pdf' && attachment.url)
                .map((attachment, index) => {
                    const url = new URL(attachment.url, location.href).href;
                    return {
                        id: `pdf-${index}`, title: attachment.title || 'Full Text PDF', mimeType: 'application/pdf',
                        url: canonical(url), fetchURL: fetchProxy ? fetchProxy.toProxy(url) : url,
                        referrer: location.href,
                    };
                });
            return {item, attachments: pdfs};
        })().then(sendResponse, error => sendResponse({error: error.message}));
        return true;
    });
}
