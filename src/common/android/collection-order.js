/* SPDX-License-Identifier: AGPL-3.0-or-later */
function defaultAndroidCollection(state, status) {
    // A retry must retain the destination of the already-created item.
    if (state.job?.receipt) {
        return state.job.payload ? state.job.payload.collectionKey || '' : state.job.collectionKey || '';
    }
    if (Object.hasOwn(status, 'selectedCollectionKey')) return status.selectedCollectionKey || '';
    return state.collectionKey || ''; // Compatibility with older companion builds.
}

function orderAndroidCollections(collections) {
    const byKey = new Map(collections.map(entry => [entry.key, entry]));
    const children = new Map();
    // Match Zotero Android's lowercase string comparison within each parent.
    const sorted = [...collections].sort((a, b) => {
        const left = a.name.toLowerCase();
        const right = b.name.toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
    });
    for (const entry of sorted) {
        const parent = byKey.has(entry.parentKey) ? entry.parentKey : null;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(entry);
    }
    const result = [];
    const seen = new Set();
    function visit(entry, ancestors) {
        if (seen.has(entry.key)) return;
        seen.add(entry.key);
        const path = [...ancestors, entry.name];
        result.push({entry, label: path.join(' / ')});
        for (const child of children.get(entry.key) || []) visit(child, path);
    }
    for (const entry of children.get(null) || []) visit(entry, []);
    // Keep malformed/cyclic entries selectable without looping indefinitely.
    for (const entry of sorted) visit(entry, []);
    return result;
}
