#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Write tests/dom/intl-collator.html: Intl.Collator cases with the order
// ICU in Node puts each list of words in, for the browser to be checked
// against.
//
//   node scripts/gen-intl-collator-tests.mjs > tests/dom/intl-collator.html
//
// Run it under a Node whose ICU is the version resources/intl.pak's
// collation data was made from.
//
// Where V8 departs from ECMA-402 the case is written as the spec has it:
// given a collation by option only, V8 adds it to the resolved locale as
// -u-co-, where the spec leaves the locale without it.

export const LOCALES = ['und', 'en', 'en-US-u-va-posix', 'de', 'de-AT',
	'fr', 'fr-CA', 'es', 'it', 'pt', 'nl', 'sv', 'nb', 'nn', 'da', 'fi',
	'is', 'fo', 'et', 'lv', 'lt', 'pl', 'cs', 'sk', 'sl', 'hr', 'bs',
	'sr', 'sr-Latn', 'hu', 'ro', 'tr', 'az', 'sq', 'mt', 'cy', 'ga',
	'br', 'eo', 'vi', 'haw', 'ha', 'yo', 'ig', 'wo', 'lkt', 'se', 'kl',
	'el', 'ru', 'uk', 'be', 'bg', 'mk', 'kk', 'ky', 'mn', 'hy', 'ka',
	'he', 'yi', 'ar', 'fa', 'fa-AF', 'ps', 'ur', 'ug', 'hi', 'mr', 'ne',
	'bn', 'as', 'pa', 'gu', 'or', 'ta', 'te', 'kn', 'ml', 'si', 'th',
	'lo', 'km', 'my', 'bo', 'dz', 'am', 'chr', 'ff-Adlm', 'ja', 'ko',
	'zh', 'zh-TW', 'zh-HK', 'yue', 'xx-YY'];

// characters most of the cases are made of; the rest come from the
// locale's own script
const COMMON = [...'aAbBcCzZ0129 -_.,\'!&()\u00e9\u00c9\u00e8e\u00c8\u0301\u0308\u00df'];
const LATIN = [...'aA\u00e1\u00c1\u00e0\u00e2\u00e3\u00e4\u00c4\u00e5\u00c5\u00e6\u00c6bBcC\u0107\u0106\u010d\u010c\u00e7\u00c7dD\u010f\u0111\u0110\u00f0eE\u00e9\u00c9\u00e8\u00ea\u00eb\u011b\u0119fFgG\u011f\u01e7hHiI' +
	'\u00ed\u00ec\u00ee\u00ef\u0131\u0130jJkKlL\u013e\u0142\u0141mMnN\u00f1\u00d1\u0148\u014boO\u00f3\u00d3\u00f2\u00f4\u00f5\u00f6\u00d6\u00f8\u00d8\u0153\u0152pPqQrR\u0159\u0158sS\u015b\u0160\u0161\u015f\u0219\u00dftT\u0165\u0163\u021b\u00fe\u00deuU' +
	'\u00fa\u00f9\u00fb\u00fc\u00dc\u016f\u0171vVwWxXyY\u00fd\u00ffzZ\u017a\u017c\u017e\u017d'];
const LATIN_PAIRS = ['ch', 'Ch', 'CH', 'll', 'Ll', 'dz', 'dzs', 'cs',
	'gy', 'ny', 'sz', 'zs', 'aa', 'Aa', 'ij', 'IJ', 'ng', 'rr', 'lj',
	'nj', 'd\u017e', 'th', 'kh'];
const KEEP = { Jpan: ['Hira', 'Kana', 'Hani'], Kore: ['Hang', 'Hani'],
	Hans: ['Hani'], Hant: ['Hani', 'Bopo'] };

let seed = 11;
function rnd(n) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
}

const scriptCache = {};
function scriptChars(sc) {
	if (!scriptCache[sc]) {
		const re = new RegExp('^(?=\\p{Script=' + sc +
			'})[\\p{L}\\p{M}\\p{Nd}]$', 'u'), out = [];

		for (let c = 0x80; c < 0x30000; c++) {
			const s = String.fromCodePoint(c);

			// Tibetan's vowel signs that NFD splits into two marks
			// sort differently in ICU depending on the text around
			// them, which VitaSurf does not follow
			if (c >= 0xf71 && c <= 0xf81)
				continue;
			if (re.test(s))
				out.push(s);
		}
		scriptCache[sc] = out;
	}
	return scriptCache[sc];
}

function pool(loc) {
	const sc = new Intl.Locale(loc).maximize().script || 'Latn';
	let p = COMMON.slice();

	for (const s of KEEP[sc] || [sc]) {
		const all = scriptChars(s);

		if (s === 'Latn')
			p = p.concat(LATIN, LATIN_PAIRS);
		for (let i = 0; i < 80 && all.length; i++)
			p.push(all[rnd(all.length)]);
	}
	if (sc === 'Hans' || sc === 'Hant')
		p = p.concat([...'\u4e2d\u56fd\u4eba\u4f60\u597d\u5927\u5c0f\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u957f\u9580\u95e8']);
	return p;
}

function words(p, n) {
	const out = ['', 'a', 'A', 'b', 'a b', 'a-b', 'ab', '1', '2', '10',
		'\u00e9', 'e\u0301'];

	while (out.length < n) {
		let s = '';
		const len = 1 + rnd(4);

		for (let i = 0; i < len; i++)
			s += p[rnd(p.length)];
		out.push(s);
	}
	return out;
}

// what the spec has for the resolved locale where V8 departs from it:
// V8 adds a keyword given only by option, keeps one an option overrides,
// and keeps -u-va-posix, which is not one of Collator's keywords
const KEYS = { co: 'collation', kn: 'numeric', kf: 'caseFirst' };

function specLocale(r, loc, o) {
	for (const k in KEYS) {
		const opt = o && o[KEYS[k]], re = new RegExp('-' + k +
			'(?:-([a-z0-9]{3,8}))?(?=-[a-z0-9]{2}(-|$)|$)');

		if (opt === undefined || !re.test(r.locale))
			continue;
		const asked = k === 'kn' ? String(!!opt) : String(opt);

		const had = loc.match(new RegExp('-u-(?:.+-)?' + k +
			'(?:-([a-z0-9]{3,8}))?(?=-[a-z0-9]{2}(-|$)|$)'));

		if (!had || (had[1] || 'true') !== asked)
			r.locale = r.locale.replace(re, '');
	}
	r.locale = r.locale.replace(/-va-posix/, '').replace(/-u$/, '');
	return r;
}

function sorted(c, w) {
	const s = w.map((x, i) => i).sort((a, b) => c.compare(w[a], w[b]));
	let e = '';

	for (let i = 0; i + 1 < s.length; i++)
		e += c.compare(w[s[i]], w[s[i + 1]]) === 0 ? '=' : '<';
	return { s, e };
}

function one(out, loc, o, n) {
	let c;

	try {
		c = new Intl.Collator(loc, o);
	} catch (e) {
		out.push({ loc, o, err: e.constructor.name });
		return;
	}
	const w = words(pool(loc), n);

	out.push(Object.assign({ loc, o, r: specLocale(c.resolvedOptions(),
		loc, o), w }, sorted(c, w)));
}

// the collations ICU has for a locale; Node before 24 has them as a getter
function collations(loc) {
	const l = new Intl.Locale(loc);

	return l.getCollations ? l.getCollations() : l.collations;
}

const OPTIONS = [{ sensitivity: 'base' }, { sensitivity: 'accent' },
	{ sensitivity: 'case' }, { sensitivity: 'variant' },
	{ caseFirst: 'upper' }, { caseFirst: 'lower' }, { caseFirst: 'false' },
	{ ignorePunctuation: true }, { numeric: true }, { usage: 'search' },
	{ usage: 'search', sensitivity: 'base' },
	{ sensitivity: 'case', caseFirst: 'upper' },
	{ numeric: true, sensitivity: 'base', ignorePunctuation: true }];

const TAGS = ['en-u-kn', 'en-u-kn-false', 'en-u-kf-upper', 'en-u-kf-lower',
	'de-u-co-phonebk', 'de-u-co-phonebk-kn', 'es-u-co-trad',
	'zh-u-co-stroke', 'zh-u-co-zhuyin', 'zh-TW-u-co-pinyin',
	'ko-u-co-searchjl', 'en-u-co-search', 'en-u-co-standard',
	'en-u-co-bogus', 'de-u-co-emoji', 'sv-u-co-trad', 'si-u-co-dict',
	'ar-u-co-compat', 'ja-u-co-unihan', 'en-u-ks-level1',
	'en-US-u-va-posix', 'en-US-POSIX'];

// options with a locale's keywords: the same, or another the locale has
const TAG_OPTIONS = [['de-u-co-phonebk', { collation: 'phonebk' }],
	['de-u-co-phonebk', { collation: 'eor' }],
	['de-u-co-eor', { collation: 'phonebk' }],
	['de-u-co-phonebk', { numeric: true }],
	['en-u-kn', { numeric: true }], ['en-u-kn', { numeric: false }],
	['en-u-kn-false', { numeric: true }],
	['en-u-kf-upper', { caseFirst: 'upper' }],
	['en-u-kf-upper', { caseFirst: 'lower' }],
	['en-u-kf-upper-kn', { caseFirst: 'false', numeric: 1 }],
	['zh-u-co-stroke', { collation: 'zhuyin' }],
	['sv', { collation: 'trad', caseFirst: 'upper' }]];

const BAD = [{ sensitivity: 'x' }, { usage: 'x' }, { caseFirst: 'x' },
	{ localeMatcher: 'x' }, { collation: 'a' }, { collation: 'standard' },
	{ collation: 'search' }, { collation: 'phonebk' }, { numeric: 'x' },
	{ ignorePunctuation: 0 }, null, 'x'];

export function cases(full) {
	const out = [];
	const locales = full ? LOCALES : LOCALES.filter((l, i) => i % 3 === 0 ||
		['de', 'sv', 'es', 'zh', 'ja', 'ko', 'ar', 'th', 'pl'].indexOf(l) >= 0);

	for (const loc of locales) {
		const n = full ? 200 : 30;

		one(out, loc, {}, n);
		for (const t of collations(loc === 'xx-YY' ? 'en' : loc))
			one(out, loc, { collation: t }, n);
		for (const o of OPTIONS)
			if (full || loc === 'en' || rnd(4) === 0)
				one(out, loc, o, loc === 'en' ? 4 * n : n);
	}
	for (const t of TAGS)
		one(out, t, {}, 40);
	for (const [t, o] of TAG_OPTIONS)
		one(out, t, o, 20);
	for (const o of BAD)
		one(out, 'de', o, 20);
	for (const l of [['en', 'de', 'xx', 'en-GB'], ['zh-Hant-TW', 'yue'],
			 'sr-Latn-RS', ['pt-BR', 'en-US-u-va-posix', 'de-AT']])
		out.push({ k: 'sup', l, s: Intl.Collator.supportedLocalesOf(l) });
	for (const a of [['a', 'B'], ['B', 'a'], ['a', '\u00e1'], ['\u00e4', 'z', 'sv'],
			 ['\u00e4', 'z', 'de'], ['a', 'A', 'en', { sensitivity: 'base' }],
			 ['2', '10', 'en', { numeric: true }],
			 ['2', '10', 'en-u-kn'], ['', ''], ['e\u0301', '\u00e9']])
		out.push({ k: 'lc', a, v: a[0].localeCompare(...a.slice(1)) });
	return out;
}

// the check, shared by the page and by a run under Node
export function CHECK(CASES, I) {
	var fails = [], n = 0;

	function same(a, b) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	CASES.forEach(function (c) {
		var what = c.loc + ' ' + JSON.stringify(c.o), f, got, i, s, e;

		n++;
		if (c.k === 'sup') {
			got = I.Collator.supportedLocalesOf(c.l);
			if (!same(got, c.s))
				fails.push('sup ' + JSON.stringify(c.l) + ': ' +
					   JSON.stringify(got) + ', ICU ' +
					   JSON.stringify(c.s));
			return;
		}
		if (c.k === 'lc') {
			got = c.a[0].localeCompare.apply(c.a[0], c.a.slice(1));
			if (got !== c.v)
				fails.push('localeCompare ' + JSON.stringify(c.a) + ': ' +
					   got + ', ICU ' + c.v);
			return;
		}
		try {
			f = new I.Collator(c.loc, c.o);
		} catch (x) {
			if (x.constructor.name !== c.err)
				fails.push(what + ': ' + x + ', ICU ' +
					   (c.err || 'constructs'));
			return;
		}
		if (c.err)
			return fails.push(what + ': constructs, ICU throws ' + c.err);
		got = f.resolvedOptions();
		if (!same(got, c.r))
			fails.push(what + ' options: ' + JSON.stringify(got) + ', ICU ' +
				   JSON.stringify(c.r));
		n++;
		s = c.w.map(function (x, k) { return k; }).sort(function (a, b) {
			return f.compare(c.w[a], c.w[b]);
		});
		e = '';
		for (i = 0; i + 1 < s.length; i++) {
			got = f.compare(c.w[s[i]], c.w[s[i + 1]]);
			e += got === 0 && f.compare(c.w[s[i + 1]], c.w[s[i]]) === 0 ?
				'=' : got === -1 &&
				f.compare(c.w[s[i + 1]], c.w[s[i]]) === 1 ? '<' : '?';
		}
		if (!same(s, c.s) || e !== c.e) {
			for (i = 0; i < s.length && s[i] === c.s[i]; i++)
				;
			fails.push(what + ' order from ' + JSON.stringify(c.w[s[i]]) +
				   ': ' + JSON.stringify(s.slice(i, i + 4).map(
					   function (k) { return c.w[k]; })) + ' ' +
				   e.slice(i, i + 3) + ', ICU ' +
				   JSON.stringify(c.s.slice(i, i + 4).map(
					   function (k) { return c.w[k]; })) + ' ' +
				   c.e.slice(i, i + 3));
		}
	});
	return { n: n, fails: fails };
}

function html() {
	const list = cases(false);

	return `<!DOCTYPE html>
<!-- Intl.Collator against ICU (${process.versions.icu}, CLDR
     ${process.versions.cldr}), written by scripts/gen-intl-collator-tests.mjs:
     the order Node puts each list of words in. -->
<html><head><meta charset="utf-8"><title>t</title></head><body><div id="out"></div>
<script>
var CASES = ${JSON.stringify(list)};
${CHECK.toString()}
var r = CHECK(CASES, Intl), m = (r.fails.length ? 'FAIL ' : 'PASS ') +
	(r.n - r.fails.length) + ' of ' + r.n + ' cases as ICU gives them';
r.fails.slice(0, 40).forEach(function (f) { console.log('FAIL ' + f); });
console.log(m);
document.getElementById('out').textContent = m;
</script></body></html>
`;
}

if (import.meta.url === 'file://' + process.argv[1])
	process.stdout.write(html());
