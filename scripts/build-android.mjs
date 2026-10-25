#!/usr/bin/env node
// Produce a separate mobile package while preserving upstream desktop outputs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'build/firefox-android');
await fs.rm(target, {recursive: true, force: true});
await fs.cp(path.join(root, 'build/firefox'), target, {recursive: true});
const manifestPath = path.join(target, 'manifest.json');
const manifest = JSON.parse((await fs.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
manifest.name = 'Zotero Android Connector';
manifest.browser_action.default_popup = 'android/panel.html';
manifest.background.scripts.splice(manifest.background.scripts.indexOf('background.js'), 0, 'android/bridge.js');
manifest.content_scripts = [manifest.content_scripts[0]];
manifest.content_scripts[0].js.push('android/content.js');
manifest.browser_specific_settings = {
    gecko: {id: 'zotero-android-connector@nindanaoto.github.io', strict_min_version: '140.0',
        data_collection_permissions: {required: ['websiteContent', 'browsingActivity']}},
    gecko_android: {strict_min_version: '142.0'},
};
delete manifest.applications;
delete manifest.commands;
delete manifest.minimum_chrome_version;
delete manifest.options_ui;
// Header replacement in upstream HTTP uses declarativeNetRequest on Firefox too.
manifest.permissions = manifest.permissions.filter(permission => permission !== 'contextMenus');
manifest.optional_permissions = [];
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Built build/firefox-android. Sign this directory as an unlisted Firefox extension for installation.');
