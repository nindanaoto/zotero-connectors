import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../../src/common/android/collection-order.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const order = entries => JSON.parse(JSON.stringify(context.orderAndroidCollections(entries)));
const entry = (key, name, parentKey = null) => ({key, name, parentKey});

test('new saves default to the app selection, including My Library', () => {
    assert.equal(context.defaultAndroidCollection({collectionKey: 'OLD'}, {selectedCollectionKey: 'CURRENT'}), 'CURRENT');
    assert.equal(context.defaultAndroidCollection({collectionKey: 'OLD'}, {selectedCollectionKey: ''}), '');
    assert.equal(context.defaultAndroidCollection({collectionKey: 'OLD'}, {}), 'OLD');
});

test('PDF retries retain the original destination when the app selection changes', () => {
    const state = {job: {receipt: {}, payload: {collectionKey: 'ORIGINAL'}}};
    assert.equal(context.defaultAndroidCollection(state, {selectedCollectionKey: 'CURRENT'}), 'ORIGINAL');
    state.job.payload.collectionKey = null;
    assert.equal(context.defaultAndroidCollection(state, {selectedCollectionKey: 'CURRENT'}), '');
});

test('collections follow Zotero parent-first order with alphabetically sorted siblings', () => {
    const entries = [entry('child-a', 'alpha', 'z'), entry('z', 'Zoology'),
        entry('a', 'Astronomy'), entry('child-z', 'Zeta', 'a'),
        entry('child-b', 'Beta', 'a'), entry('nested', 'First', 'child-z')];
    const result = order(entries);
    assert.deepEqual(result.map(row => row.label), ['Astronomy', 'Astronomy / Beta',
        'Astronomy / Zeta', 'Astronomy / Zeta / First', 'Zoology', 'Zoology / alpha']);
    assert.equal(entries[0].key, 'child-a');
});

test('missing parents and cycles do not hide or duplicate collections', () => {
    const entries = [entry('a', 'A', 'b'), entry('b', 'B', 'a'), entry('c', 'C', 'missing')];
    assert.deepEqual(order(entries).map(row => row.entry.key).sort(), ['a', 'b', 'c']);
});
