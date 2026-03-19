/**
 * SunoForge i18n key coverage checker.
 * Run: node check-i18n.js
 * Checks that every data-i18n / data-i18n-ph key used in index.html
 * and every _t() / _fmt() key used in JS are present in lang/en.json.
 * Also checks that all non-English locale files have all keys from lang/en.json.
 */
const fs = require('fs');
const en = require('./lang/en.json');
const html = fs.readFileSync('./index.html', 'utf8');

const LOCALES = ['de', 'fr', 'nl', 'es', 'pt', 'ru', 'ja', 'ko', 'zh-hans', 'zh-hant'];
const localeData = {};
LOCALES.forEach(function(l) { localeData[l] = require('./lang/' + l + '.json'); });

let ok = true;

// 1. HTML data-i18n keys
const htmlKeys = new Set();
const re1 = /data-i18n(?:-ph)?="([^"]+)"/g;
let m = re1.exec(html);
while (m !== null) { htmlKeys.add(m[1]); m = re1.exec(html); }

const htmlMissing = [];
htmlKeys.forEach(function(k) { if (!en[k]) htmlMissing.push(k); });
console.log('HTML i18n keys: ' + htmlKeys.size + '  Missing from en.json: ' + htmlMissing.length);
htmlMissing.forEach(function(k) { console.log('  MISSING: ' + k); ok = false; });

// 2. JS _t() / _fmt() keys
const jsKeys = new Set();
const re2 = /_(?:t|fmt)\('([^']+)'/g;
m = re2.exec(html);
while (m !== null) { jsKeys.add(m[1]); m = re2.exec(html); }

const jsMissing = [];
jsKeys.forEach(function(k) { if (!en[k]) jsMissing.push(k); });
console.log('JS _t()/_fmt() keys: ' + jsKeys.size + '  Missing from en.json: ' + jsMissing.length);
jsMissing.forEach(function(k) { console.log('  MISSING: ' + k); ok = false; });

// 3. All locale files completeness vs en.json
const enKeys = Object.keys(en).filter(function(k) { return k !== '_comment'; });
LOCALES.forEach(function(locale) {
    const data = localeData[locale];
    const localeKeys = new Set(Object.keys(data).filter(function(k) { return k !== '_comment'; }));
    const missing = enKeys.filter(function(k) { return !localeKeys.has(k); });
    console.log(locale + '.json keys: ' + localeKeys.size + '  Missing vs en.json: ' + missing.length);
    missing.forEach(function(k) { console.log('  MISSING in ' + locale + ': ' + k); ok = false; });
});

if (ok) console.log('\nAll checks passed OK');
else process.exit(1);

