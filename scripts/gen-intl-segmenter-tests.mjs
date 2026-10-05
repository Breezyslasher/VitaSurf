#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Write tests/dom/intl-segmenter.html: Intl.Segmenter cases with the
// segments ICU in Node finds in each text, for the browser to be checked
// against.
//
//   node scripts/gen-intl-segmenter-tests.mjs > tests/dom/intl-segmenter.html
//
// Run it under a Node whose ICU is the version resources/intl.pak's
// break rules and dictionaries were made from.
//
// Where V8 departs from ECMA-402 the case is written as the spec has it:
// V8 keeps -u-va-posix in the resolved locale, which is not one of
// Segmenter's keywords.

const SAMPLES = {
	th: '\u0e20\u0e32\u0e29\u0e32\u0e44\u0e17\u0e22\u0e40\u0e1b\u0e47\u0e19\u0e20\u0e32\u0e29\u0e32\u0e17\u0e35\u0e48\u0e21\u0e35\u0e23\u0e30\u0e14\u0e31\u0e1a\u0e40\u0e2a\u0e35\u0e22\u0e07\u0e02\u0e2d\u0e07\u0e04\u0e33\u0e41\u0e19\u0e48\u0e19\u0e2d\u0e19\u0e2b\u0e23\u0e37\u0e2d\u0e27\u0e23\u0e23\u0e13\u0e22\u0e38\u0e01\u0e15\u0e4c\u0e40\u0e0a\u0e48\u0e19\u0e40\u0e14\u0e35\u0e22\u0e27\u0e01\u0e31\u0e1a\u0e20\u0e32\u0e29\u0e32\u0e08\u0e35\u0e19 \u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e\u0e21\u0e2b\u0e32\u0e19\u0e04\u0e23\u0e40\u0e1b\u0e47\u0e19\u0e40\u0e21\u0e37\u0e2d\u0e07\u0e2b\u0e25\u0e27\u0e07\u0e02\u0e2d\u0e07\u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28\u0e44\u0e17\u0e22\u0e46 \u0e2f\u0e25\u0e2f',
	lo: '\u0e9e\u0eb2\u0eaa\u0eb2\u0ea5\u0eb2\u0ea7\u0ec0\u0e9b\u0eb1\u0e99\u0e9e\u0eb2\u0eaa\u0eb2\u0e97\u0eb2\u0e87\u0e81\u0eb2\u0e99\u0e82\u0ead\u0e87\u0e9b\u0eb0\u0ec0\u0e97\u0e94\u0ea5\u0eb2\u0ea7',
	km: '\u1797\u17b6\u179f\u17b6\u1781\u17d2\u1798\u17c2\u179a\u1787\u17b6\u1797\u17b6\u179f\u17b6\u1795\u17d2\u179b\u17bc\u179c\u1780\u17b6\u179a\u1793\u17c3\u1794\u17d2\u179a\u1791\u17c1\u179f\u1780\u1798\u17d2\u1796\u17bb\u1787\u17b6',
	my: '\u1019\u103c\u1014\u103a\u1019\u102c\u1018\u102c\u101e\u102c\u1005\u1000\u102c\u1038\u101e\u100a\u103a\u1019\u103c\u1014\u103a\u1019\u102c\u1014\u102d\u102f\u1004\u103a\u1004\u1036\u104f\u101b\u102f\u1036\u1038\u101e\u102f\u1036\u1038\u1018\u102c\u101e\u102c\u1005\u1000\u102c\u1038\u1016\u103c\u1005\u103a\u101e\u100a\u103a',
	zh: '\u4e2d\u534e\u4eba\u6c11\u5171\u548c\u56fd\u662f\u4f4d\u4e8e\u4e1c\u4e9a\u7684\u56fd\u5bb6\u3002\u5317\u4eac\u662f\u9996\u90fd\uff0c\u4e0a\u6d77\u662f\u6700\u5927\u7684\u57ce\u5e02\u3002\u6211\u4eec\u4eca\u5929\u5929\u6c14\u5f88\u597d',
	ja: '\u65e5\u672c\u8a9e\u306f\u4e3b\u306b\u65e5\u672c\u3067\u4f7f\u308f\u308c\u3066\u3044\u308b\u8a00\u8a9e\u3067\u3042\u308b\u3002\u3072\u3089\u304c\u306a\u3068\u30ab\u30bf\u30ab\u30ca\u3068\u6f22\u5b57\u3092\u4f7f\u3046\u3002\uff76\uff80\uff76\uff85\u3082\u3042\u308b\u3002\u3059\u3082\u3082\u3082\u3082\u3082\u3082\u3082\u306e\u3046\u3061\u30b3\u30fc\u30d2\u30fc\uff76\uff9e\uff77\uff9e\u8c48\uf900',
	ko: '\ud55c\uad6d\uc5b4\ub294 \ub300\ud55c\ubbfc\uad6d\uc758 \uacf5\uc6a9\uc5b4\uc774\ub2e4.',
	en: 'Mr. Smith went to Washington, D.C. on Jan. 3rd. He said "Hi." Then he left! Was it 3.14 or 2,718? It\'s e.g. U.S.A.-made (really).\r\nNew line\u2029Para\u00a0x',
	el: '\u03a4\u03b9 \u03ba\u03ac\u03bd\u03b5\u03b9\u03c2; \u039a\u03b1\u03bb\u03ac. \u039d\u03b1\u03b9\u037e \u038c\u03c7\u03b9.',
	misc: 'e\u0301\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u{1F1FA}\u{1F1F8}\u{1F1E6}\u0915\u094d\u0937\u093f\u1100\u1161\u11a8\uac01\u0600\u0661\u0627\u0644\u0639\u0631\u0628\u064a\u0629 \u05e2\u05d1\u05e8\u05d9\u05ea \u05f4\u05d0\u05f3 a_b 1,000.5 \u00ad\u2060x \u{1F44D}\u{1F3FD}'
};

const POOL = [...'aAbZz09 .,;:\'"!?-_()[]\n\r\t\u00a0\u00ad\u200b\u200c\u200d\u2060\u00e9\u00c9\u00df',
	...'\u05d0\u05d1\u05f3\u05f4\u30ab\u30bf\u30fc\u304b\u306a\u6f22\u5b57\uff76\uff9e\uac00\u0e01\u0e46\u0e2f',
	'\u0301', '\u0903', '\u{1F600}', '\u{1F1FA}', '\u{1F3FD}', '\u{20000}', '\u3002', '\u037e', '\uff01'];

let seed = 3;
function rnd(n) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
}

// a text: slices of the samples, joined with characters from the pool
function text(kind) {
	let s = '';
	const n = 1 + rnd(4);

	for (let i = 0; i < n; i++) {
		const src = SAMPLES[kind || Object.keys(SAMPLES)[rnd(10)]];
		const cps = [...src], a = rnd(cps.length), b = a + 1 + rnd(30);

		s += cps.slice(a, b).join('');
		for (let k = rnd(3); k > 0; k--)
			s += POOL[rnd(POOL.length)];
	}
	return s;
}

const segs = (seg, t) => [...seg.segment(t)].map(x => x.isWordLike === undefined ?
	[x.index, x.segment.length] : [x.index, x.segment.length, x.isWordLike ? 1 : 0]);

// what the spec has for the resolved locale where V8 departs from it
const spec = r => Object.assign({}, r,
	{ locale: r.locale.replace(/-va-posix/, '').replace(/-u$/, '') });

const LOCALES = ['en', 'en-US-POSIX', 'en-u-va-posix', 'el', 'el-GR', 'th',
	'lo', 'km', 'my', 'zh', 'zh-Hant-TW', 'ja', 'ko', 'de', 'ar', 'he', 'hi',
	'xx-YY', 'und', 'lkt', 'yue', 'sr-Latn-RS', 'pt-BR', 'en-u-nu-arab',
	'ja-u-lw-phrase'];

export function cases(full) {
	const out = [];
	const per = full ? 40 : 4;

	for (const loc of LOCALES) {
		for (const g of ['grapheme', 'word', 'sentence']) {
			const s = new Intl.Segmenter(loc, { granularity: g });
			const kind = { th: 'th', lo: 'lo', km: 'km', my: 'my', zh: 'zh',
				'zh-Hant-TW': 'zh', ja: 'ja', ko: 'ko', el: 'el', 'el-GR': 'el',
				en: 'en', 'en-US-POSIX': 'en' }[loc];
			const v = [];

			for (let i = 0; i < per; i++) {
				const t = i === 0 && kind ? SAMPLES[kind] : text(i % 2 ? kind : null);
				const seg = s.segment(t), probe = [];

				for (const k of [0, rnd(t.length + 1), rnd(t.length + 1), t.length - 1,
					t.length, -1]) {
					const c = seg.containing(k);

					probe.push([k, c ? [c.index, c.segment.length] : null]);
				}
				v.push([t, segs(s, t), probe]);
			}
			out.push({ loc, o: { granularity: g }, r: spec(s.resolvedOptions()), v });
		}
	}
	for (const o of [undefined, {}, { granularity: 'line' }, { granularity: 'Word' },
		null, 'word', { localeMatcher: 'x' }, { localeMatcher: 'lookup', granularity: 'word' }]) {
		let r;

		try {
			r = { r: spec(new Intl.Segmenter('en', o).resolvedOptions()) };
		} catch (e) {
			r = { err: e.constructor.name };
		}
		out.push(Object.assign({ loc: 'en', o, v: [] }, r));
	}
	for (const l of [['en', 'de', 'xx', 'en-GB'], ['zh-Hant-TW', 'yue', 'lkt'],
		'sr-Latn-RS', ['tlh', 'th-TH', 'my-MM']])
		out.push({ k: 'sup', l, s: Intl.Segmenter.supportedLocalesOf(l) });
	out.push({ k: 'api', v: API(Intl) });
	return out;
}

// the API's shape, the same under Node and in the page
export function API(I) {
	var S = I.Segmenter, seg = new S('en', { granularity: 'word' }).segment('a b');
	var segProto = Object.getPrototypeOf(seg), it = seg[Symbol.iterator]();
	var itProto = Object.getPrototypeOf(it), first = it.next(), r = [];

	r.push(S.length, typeof S.supportedLocalesOf, S.supportedLocalesOf.length);
	r.push(Object.getOwnPropertyNames(S.prototype).sort().join());
	r.push(Object.prototype.toString.call(new S()));
	r.push(Object.getOwnPropertyNames(segProto).join(), typeof segProto[Symbol.iterator],
	       segProto[Symbol.iterator].name, segProto.containing.length);
	r.push(Object.prototype.toString.call(it), Object.getOwnPropertyNames(itProto).join(),
	       itProto.next.length, typeof itProto[Symbol.iterator]);
	r.push(JSON.stringify(first), JSON.stringify(it.next()), JSON.stringify(it.next()),
	       JSON.stringify(it.next()), JSON.stringify(it.next()));
	r.push(Array.from(new S('en').segment('')).length);
	r.push(JSON.stringify(new S('en').segment('ab').containing('1')));
	try {
		S('en');
		r.push('called');
	} catch (e) {
		r.push(e.constructor.name);
	}
	try {
		segProto.containing.call({}, 0);
		r.push('no throw');
	} catch (e) {
		r.push(e.constructor.name);
	}
	r.push(Object.getOwnPropertyDescriptor(S, 'prototype').writable);
	return r;
}

// the check, shared by the page and by a run under Node
export function CHECK(CASES, I, API) {
	var fails = [], n = 0;

	function same(a, b) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	CASES.forEach(function (c) {
		var what = c.loc + ' ' + JSON.stringify(c.o), s, got;

		n++;
		if (c.k === 'sup') {
			got = I.Segmenter.supportedLocalesOf(c.l);
			if (!same(got, c.s))
				fails.push('sup ' + JSON.stringify(c.l) + ': ' +
					   JSON.stringify(got) + ', ICU ' + JSON.stringify(c.s));
			return;
		}
		if (c.k === 'api') {
			got = API(I);
			c.v.forEach(function (v, i) {
				if (!same(got[i], v))
					fails.push('api ' + i + ': ' + JSON.stringify(got[i]) +
						   ', V8 ' + JSON.stringify(v));
			});
			return;
		}
		try {
			s = new I.Segmenter(c.loc, c.o);
		} catch (e) {
			if (e.constructor.name !== c.err)
				fails.push(what + ': ' + e + ', ICU ' + (c.err || 'constructs'));
			return;
		}
		if (c.err)
			return fails.push(what + ': constructs, ICU throws ' + c.err);
		got = s.resolvedOptions();
		if (!same(got, c.r))
			fails.push(what + ' options: ' + JSON.stringify(got) + ', ICU ' +
				   JSON.stringify(c.r));
		c.v.forEach(function (x) {
			var t = x[0], seg = s.segment(t), list = [], i;

			n++;
			Array.from(seg).forEach(function (d) {
				list.push(d.isWordLike === undefined ? [d.index, d.segment.length] :
					  [d.index, d.segment.length, d.isWordLike ? 1 : 0]);
			});
			if (!same(list, x[1])) {
				for (i = 0; i < list.length && same(list[i], x[1][i]); i++)
					;
				fails.push(what + ' ' + JSON.stringify(t.slice(0, 40)) + ' from ' +
					   JSON.stringify(x[1][i] || list[i]) + ': ' +
					   JSON.stringify(list.slice(i, i + 3)) + ', ICU ' +
					   JSON.stringify(x[1].slice(i, i + 3)));
			}
			x[2].forEach(function (p) {
				var d = seg.containing(p[0]);

				n++;
				if (!same(d ? [d.index, d.segment.length] : null, p[1]))
					fails.push(what + ' containing(' + p[0] + ') in ' +
						   JSON.stringify(t.slice(0, 40)) + ': ' +
						   JSON.stringify(d) + ', ICU ' + JSON.stringify(p[1]));
			});
		});
	});
	return { n: n, fails: fails };
}

function html() {
	const list = cases(false);

	return `<!DOCTYPE html>
<!-- Intl.Segmenter against ICU (${process.versions.icu}, CLDR ${process.versions.cldr}),
     written by scripts/gen-intl-segmenter-tests.mjs: the segments Node finds
     in each text. -->
<html><head><meta charset="utf-8"><title>t</title></head><body><div id="out"></div>
<script>
var CASES = ${JSON.stringify(list).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))};
${API.toString()}
${CHECK.toString()}
var r = CHECK(CASES, Intl, API), m = (r.fails.length ? 'FAIL ' : 'PASS ') +
	(r.n - r.fails.length) + ' of ' + r.n + ' cases as ICU gives them';
r.fails.slice(0, 40).forEach(function (f) { console.log('FAIL ' + f); });
console.log(m);
document.getElementById('out').textContent = m;
</script></body></html>
`;
}

if (import.meta.url === 'file://' + process.argv[1])
	process.stdout.write(html());
