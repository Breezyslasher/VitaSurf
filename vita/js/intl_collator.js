/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Intl.Collator and String.prototype.localeCompare (VitaSurf).
 *
 * The prelude's Collator compared UTF-16 code units, so "a" < "B" was
 * false and accents sorted after z. This is ICU's collation: the root
 * order is ICU's own (FractionalUCA, CLDR's root collation), each
 * locale's tailoring is built from ICU's rules offline by
 * scripts/gen-intl-collation.mjs, and both are read from
 * resources/intl.pak a block of code points at a time.
 *
 * Text is put in NFD and turned into collation elements: the longest
 * contraction, discontiguous ones over combining marks as UCA has them,
 * prefix contexts, Han in ICU's radical-stroke order, unassigned code
 * points by code point, digit runs by value when numeric is on. A string's elements become a
 * sort key, one string of 16-bit units per level as ICU writes its
 * keys, so two strings compare as their keys do. A weight is ICU's (a
 * 32-bit primary, 16-bit secondary and tertiary) and a second unit that
 * orders what a tailoring put between two of ICU's weights.
 *
 * __vitaCollationCore(data) is the engine on its own, which the
 * generator uses to build tailorings; __vitaIntlCollator(W, N, C, X)
 * installs the API.
 */
var __vitaCollationCore = function (data) {
	'use strict';

	var META = data('k:meta');
	var ROOT = { blocks: {}, sup: null };
	var MID = 0x8000, TWO16 = 65536;

	/* ---- collation elements ---- */

	/* "2B,05,9C" -> [p, s, t], each weight times 2^16 plus the unit a
	 * tailoring orders by ("+n" after it, n from the middle) */
	function weight(part, width) {
		var plus = part.indexOf('+'), sub = MID, hex = part, v;

		if (plus >= 0) {
			sub = MID + parseInt(part.slice(plus + 1), 10);
			hex = part.slice(0, plus);
		}
		if (!hex)
			return sub === MID ? 0 : sub;
		while (hex.length < width)
			hex += '0';
		v = parseInt(hex, 16);
		return v * TWO16 + sub;
	}

	function parseCEs(text) {
		var out = [], ces = text.split(' '), i, w;

		for (i = 0; i < ces.length; i++) {
			if (!ces[i])
				continue;
			w = ces[i].split(',');
			out.push(weight(w[0], 8), weight(w[1], 4), weight(w[2], 4));
		}
		return out;
	}

	function blockOf(table, b) {
		var e = table.blocks[b];

		if (e === undefined) {
			e = table.blocks[b] = table.load(b) || null;
			if (e) {
				e.s = e.s || {};
				e.c = e.c || {};
				e.x = e.x || {};
			}
		}
		return e;
	}

	ROOT.load = function (b) {
		return data('k:r:' + b);
	};

	function hex(cp) {
		return cp.toString(16).toUpperCase();
	}

	/* a table's elements for one code point, parsed once */
	function single(table, cp) {
		var b = blockOf(table, hex(cp >> 8)), k, v;

		if (!b)
			return null;
		k = hex(cp & 0xff);
		v = b.s[k];
		if (v === undefined)
			return null;
		if (typeof v === 'string')
			v = b.s[k] = parseCEs(v);
		return v;
	}

	function listed(table, kind, cp) {
		var b = blockOf(table, hex(cp >> 8)), k, v, i;

		if (!b)
			return null;
		k = hex(cp & 0xff);
		v = b[kind][k];
		if (!v)
			return null;
		if (!v.parsed) {
			for (i = 0; i < v.length; i++) {
				v[i] = [v[i][0], parseCEs(v[i][1])];
				v[i][1].shared = true;
			}
			/* the longest first */
			v.sort(function (a, b) { return b[0].length - a[0].length; });
			v.parsed = true;
		}
		return v;
	}

	/* Han in ICU's root order, radical by radical and by strokes
	 * within (k:han, its runs of code points in that order), in its own
	 * group after the marker at 81 02 02 (a tailoring before Han goes
	 * between); then everything unassigned from E4 */
	var HAN_RUNS = null;

	function hanRank(cp) {
		var lo, hi, i;

		if (!HAN_RUNS) {
			var flat = data('k:han') || [], n = flat.length / 2, k;
			var idx = [], at = 0;

			for (k = 0; k < n; k++) {
				idx.push([flat[2 * k], flat[2 * k + 1], at]);
				at += flat[2 * k + 1];
			}
			idx.sort(function (a, b) { return a[0] - b[0]; });
			HAN_RUNS = { start: new Int32Array(n), len: new Int32Array(n),
				rank: new Int32Array(n) };
			for (k = 0; k < n; k++) {
				HAN_RUNS.start[k] = idx[k][0];
				HAN_RUNS.len[k] = idx[k][1];
				HAN_RUNS.rank[k] = idx[k][2];
			}
		}
		lo = 0;
		hi = HAN_RUNS.start.length - 1;
		while (lo <= hi) {
			i = (lo + hi) >> 1;
			if (cp < HAN_RUNS.start[i])
				hi = i - 1;
			else if (cp >= HAN_RUNS.start[i] + HAN_RUNS.len[i])
				lo = i + 1;
			else
				return HAN_RUNS.rank[i] + cp - HAN_RUNS.start[i];
		}
		return -1;
	}

	function implicit(cp) {
		var i, r, at = 0, h = META.han;

		for (i = 0; i < h.length; i++) {
			r = h[i];
			if (cp >= r[0] && cp <= r[1]) {
				var k = hanRank(cp);

				return (0x81100000 + (k >= 0 ? k :
					0x30000 + at + cp - r[0])) * TWO16 + MID;
			}
			at += r[1] - r[0] + 1;
		}
		return (0xE4000001 + cp) * TWO16 + MID;
	}

	/* canonical combining classes, for discontiguous contractions */
	var CCC = null;

	function ccc(cp) {
		var i, lo, hi, r;

		if (!CCC) {
			CCC = META.ccc.map(function (s) {
				var p = s.split(':');

				return [parseInt(p[0], 16), parseInt(p[1], 16),
					+p[2]];
			});
		}
		lo = 0;
		hi = CCC.length - 1;
		while (lo <= hi) {
			i = (lo + hi) >> 1;
			r = CCC[i];
			if (cp < r[0])
				hi = i - 1;
			else if (cp > r[1])
				lo = i + 1;
			else
				return r[2];
		}
		return 0;
	}

	/* the digit a code point stands for, or -1: its root primary's,
	 * as a tailoring that moves a digit keeps it a digit (ICU's
	 * CollationDataBuilder::setDigitTags) */
	var DIGITS = null;

	function digitOf(cp) {
		var i, ces;

		if (!DIGITS) {
			DIGITS = {};
			for (i = 0; i < 10; i++)
				DIGITS[single(ROOT, 0x30 + i)[0]] = i;
		}
		if (!/\p{Nd}/u.test(String.fromCodePoint(cp)))
			return -1;
		ces = single(ROOT, cp);
		i = ces.length === 3 ? DIGITS[ces[0]] : undefined;
		return i === undefined ? -1 : i;
	}

	/* ICU's CollationIterator::appendNumericSegmentCEs */
	function numericCEs(digits, out) {
		var len = digits.length, value, i, p, base = 0x10000000;
		var common = 0x0500 * TWO16 + MID;

		function push(p32) {
			out.push(p32 * TWO16 + MID, common, common);
		}
		while (len > 1 && digits[0] === 0) {
			digits = digits.slice(1);
			len--;
		}
		if (len <= 7) {
			value = 0;
			for (i = 0; i < len; i++)
				value = value * 10 + digits[i];
			if (value < 74)
				return push(base + (2 + value) * 65536);
			value -= 74;
			if (value < 40 * 254)
				return push(base + (76 + Math.floor(value / 254)) * 65536 +
					    (2 + value % 254) * 256);
			value -= 40 * 254;
			if (value < 16 * 254 * 254) {
				p = base + (2 + value % 254);
				value = Math.floor(value / 254);
				p += (2 + value % 254) * 256;
				value = Math.floor(value / 254);
				p += (116 + value % 254) * 65536;
				return push(p);
			}
		}
		var pairs = Math.floor((len + 1) / 2), pos, pair, shift = 8;

		p = base + (132 - 4 + pairs) * 65536;
		while (digits[len - 1] === 0 && digits[len - 2] === 0)
			len -= 2;
		if (len & 1) {
			pair = digits[0];
			pos = 1;
		} else {
			pair = digits[0] * 10 + digits[1];
			pos = 2;
		}
		pair = 11 + 2 * pair;
		while (pos < len) {
			if (shift === 0) {
				push(p + pair);
				p = base;
				shift = 16;
			} else {
				p += pair * Math.pow(2, shift);
				shift -= 8;
			}
			pair = 11 + 2 * (digits[pos] * 10 + digits[pos + 1]);
			pos += 2;
		}
		push(p + (pair - 1) * Math.pow(2, shift));
	}

	/* the contractions starting with cp, the tailoring's then the
	 * root's unless the tailoring suppresses them */
	function contractions(tail, cp) {
		var t = tail ? listed(tail, 'c', cp) : null, r;

		if (tail && tail.sup && tail.sup[cp])
			return t;
		r = listed(ROOT, 'c', cp);
		if (!t)
			return r;
		if (!r)
			return t;
		if (!t.merged) {
			t.merged = t.concat(r.filter(function (e) {
				return !t.some(function (x) { return x[0] === e[0]; });
			})).sort(function (a, b) { return b[0].length - a[0].length; });
		}
		return t.merged;
	}

	/* UCA's longest match, then the non-starters after it that extend
	 * it, unblocked; returns [elements, end, skipped indices] */
	function contract(list, str, i, len) {
		var j, k, key, best = null, end = i + len, skipped = null;
		var maxCcc = 0, c, clen, cc;

		for (j = 0; j < list.length; j++) {
			key = list[j][0];
			if (str.startsWith(key, i + len)) {
				best = list[j];
				end = i + len + key.length;
				break;
			}
		}
		var matched = best ? best[0] : '';

		for (k = end; k < str.length; k += clen) {
			c = str.codePointAt(k);
			clen = c > 0xffff ? 2 : 1;
			cc = ccc(c);
			if (cc === 0)
				break;
			if (cc > maxCcc) {
				for (j = 0; j < list.length; j++) {
					if (list[j][0] === matched + String.fromCodePoint(c)) {
						best = list[j];
						matched = best[0];
						(skipped = skipped || {})[k] = true;
						break;
					}
				}
				if (j < list.length)
					continue;
			}
			maxCcc = Math.max(maxCcc, cc);
		}
		return best ? [best[1], end, skipped] : null;
	}

	function singleCEs(tail, cp) {
		var v = tail ? single(tail, cp) : null;

		if (v)
			return v;
		v = single(ROOT, cp);
		if (v)
			return v;
		return [implicit(cp), 0x0500 * TWO16 + MID, 0x0500 * TWO16 + MID];
	}

	/* what a code point has in a tailoring and the root, looked up
	 * once: its prefix contexts, its contractions and its elements */
	function lookup(tail, cp) {
		var t = tail || ROOT, e;

		if (!t.cps)
			t.cps = new Map();
		e = t.cps.get(cp);
		if (e === undefined) {
			e = {
				x: (tail && listed(tail, 'x', cp)) ||
					listed(ROOT, 'x', cp),
				c: contractions(tail, cp),
				s: singleCEs(tail, cp),
				d: digitOf(cp)
			};
			e.s.shared = true;
			if (t.cps.size >= 4096)
				t.cps.clear();
			t.cps.set(cp, e);
		}
		return e;
	}

	/* the collation elements of NFD text, [p, s, t, ...] in an array
	 * for each code point or contraction */
	function ces(str, tail, numeric) {
		var out = [], i = 0, cp, len, v, m, pre, j, skip = null, digits;
		var e;

		while (i < str.length) {
			cp = str.codePointAt(i);
			len = cp > 0xffff ? 2 : 1;
			if (skip && skip[i]) {
				i += len;
				continue;
			}
			e = lookup(tail, cp);
			pre = e.x;
			if (pre) {
				for (j = 0; j < pre.length; j++) {
					if (i >= pre[j][0].length &&
					    str.slice(i - pre[j][0].length, i) === pre[j][0])
						break;
				}
				if (j < pre.length) {
					out.push(pre[j][1]);
					i += len;
					continue;
				}
			}
			v = e.c;
			if (v && (m = contract(v, str, i, len))) {
				out.push(m[0]);
				if (m[2]) {
					skip = skip || {};
					for (j in m[2])
						skip[j] = true;
				}
				i = m[1];
				continue;
			}
			if (numeric && e.d >= 0) {
				digits = [];
				while (i < str.length) {
					cp = str.codePointAt(i);
					len = cp > 0xffff ? 2 : 1;
					j = lookup(tail, cp).d;
					if (j < 0 || digits.length >= 254)
						break;
					digits.push(j);
					i += len;
				}
				numericCEs(digits, v = []);
				out.push(v);
				continue;
			}
			out.push(e.s);
			i += len;
		}
		return out;
	}

	function push(out, v) {
		for (var i = 0; i < v.length; i++)
			out.push(v[i]);
	}

	/* ---- sort keys ---- */

	var U = String.fromCharCode;

	/* the rank of a primary's script group, for [reorder] */
	function rankOf(order, p32) {
		var lo = 0, hi = order.starts.length - 1, i;

		while (lo < hi) {
			i = (lo + hi + 1) >> 1;
			if (order.starts[i] <= p32)
				lo = i;
			else
				hi = i - 1;
		}
		return order.rank[lo];
	}

	/*
	 * A key with the levels o asks for: o.strength 1-3, o.caseLevel,
	 * o.caseFirst ('upper', 'lower' or ''), o.shifted, o.backwards,
	 * o.order (a reordering, or null), o.sig (all of these as a string).
	 * segs is what ces() gives: arrays of elements, most of them the
	 * tables' own, which keep their part of each level of a key for
	 * each o.sig; shifted and backwards keys look across elements, so
	 * those are built from all the elements at once.
	 */
	function key(segs, o) {
		var k1 = '', k2 = '', kc = '', k3 = '', i, seg, f;

		if (o.shifted || o.backwards) {
			for (i = 0, f = []; i < segs.length; i++)
				push(f, segs[i]);
			f = levels(f, o);
		} else {
			for (i = 0; i < segs.length; i++) {
				seg = segs[i];
				f = seg.lv && seg.lv[o.sig];
				if (!f) {
					f = levels(seg, o);
					if (seg.shared)
						(seg.lv = seg.lv || {})[o.sig] = f;
				}
				k1 += f[0];
				k2 += f[1];
				kc += f[2];
				k3 += f[3];
			}
			f = [k1, k2, kc, k3];
		}
		return f[0] + (o.strength >= 2 ? '\u0001' + f[1] : '') +
			(o.caseLevel ? '\u0001' + f[2] : '') +
			(o.strength >= 3 ? '\u0001' + f[3] : '');
	}

	/* each level's part of a key for a list of elements */
	function levels(list, o) {
		var p1 = '', p2 = [], p3 = '', pc = '', i, p, s, t, p32, sub;
		var vt = o.shifted ? META.vt : -1, afterVariable = false, c;

		for (i = 0; i < list.length; i += 3) {
			p = list[i];
			s = list[i + 1];
			t = list[i + 2];
			p32 = Math.floor(p / TWO16);
			if (vt >= 0) {
				if (p32 !== 0 && p32 <= vt) {
					afterVariable = true;
					continue;
				}
				if (p32 === 0 && afterVariable)
					continue;
				if (p32 !== 0)
					afterVariable = false;
			}
			if (p) {
				sub = p % TWO16;
				p1 += (o.order ? U(rankOf(o.order, p32)) : '') +
					U(p32 >>> 16, p32 & 0xffff, sub);
			}
			if (o.strength >= 2 && s)
				p2.push(U(Math.floor(s / TWO16), s % TWO16));
			if (o.caseLevel && (o.strength === 1 ? p32 !== 0 :
			    Math.floor(s / TWO16) !== 0 || p32 !== 0)) {
				c = (Math.floor(t / TWO16) >> 14) & 3;
				pc += U(o.caseFirst === 'upper' ? 4 - c : 2 + c);
			}
			if (o.strength >= 3 && t)
				p3 += U(tertiary(Math.floor(t / TWO16), p32 !== 0 ||
					s >= TWO16, o), t % TWO16);
		}
		if (o.backwards)
			p2.reverse();
		return [p1, p2.join(''), pc, p3];
	}

	/* ICU's tertiary weight with its case bits as caseFirst has them
	 * (CollationKeys::writeSortKeyUpToQuaternary) */
	function tertiary(t, notTertiaryCE, o) {
		if (!o.caseFirst || o.caseLevel)
			return t & 0x3f3f;
		if (o.caseFirst === 'lower')
			return t;
		if (notTertiaryCE) {
			t ^= 0xc000;
			if (t < 0xc000)
				t -= 0x4000;
			return t;
		}
		return (t & 0x3f3f) | 0xc000;
	}

	return {
		meta: META, root: ROOT, ces: ces, key: key, parseCEs: parseCEs,
		single: single, listed: listed, implicit: implicit, ccc: ccc,
		blockOf: blockOf
	};
};

var __vitaIntlCollator = function (W, N, C, X) {
	'use strict';

	var Intl = W.Intl, getOption = X.getOption, method = X.method;
	var DATA = {};

	function data(name) {
		if (DATA[name] === undefined)
			DATA[name] = N.has(name) ? JSON.parse(N.pak(name)) : null;
		return DATA[name];
	}

	var core = __vitaCollationCore(data), META = core.meta;

	/* ---- a locale's collations ---- */

	/* the tailoring of a collation, null for root's order */
	var TAILS = {};

	function tailoring(name) {
		var t = TAILS[name], d;

		if (t !== undefined)
			return t;
		d = data('k:t:' + name);
		if (!d)
			return (TAILS[name] = null);
		t = { blocks: {}, settings: d.set || {}, sup: null };
		t.load = function (b) {
			return d.b[b];
		};
		if (d.sup) {
			t.sup = {};
			d.sup.forEach(function (cp) { t.sup[cp] = true; });
		}
		return (TAILS[name] = t);
	}

	/* the collation locale data for a tag: { types: { type: the
	 * tailoring's name, or null for root's order }, dflt } */
	function localeData(tag) {
		var L = META.locales, found = C.lookup(tag, function (t) {
			return Object.prototype.hasOwnProperty.call(L, t) ? t : null;
		});

		return found ? L[found] : L.root;
	}

	/* a locale Collator offers: ICU's, but those its Collator has no
	 * data of its own for, and with those only its Collator has */
	var NOCOLL = null;

	function hasCollation(t) {
		var i;

		if (!NOCOLL) {
			NOCOLL = {};
			for (i = 0; i < (META.nocoll || []).length; i++)
				NOCOLL[META.nocoll[i]] = 1;
			for (i = 0; i < (META.coll || []).length; i++)
				NOCOLL[META.coll[i]] = 2;
		}
		return NOCOLL[t] === 2 || (X.hasLocale(t) && !NOCOLL[t]) ?
			t : null;
	}

	/* ---- Intl.Collator ---- */

	var SLOTS = new WeakMap();

	function slots(o, m) {
		var s = o !== null && typeof o === 'object' && SLOTS.get(o);

		if (!s)
			throw new TypeError('Method Intl.Collator.prototype.' + m +
					    ' called on incompatible receiver');
		return s;
	}

	var TYPE = /^[a-z\d]{3,8}(-[a-z\d]{3,8})*$/i;

	function Collator() {
		var s = {}, o, req, usage, co, kn, kf, sens, ip, loc, kw = {};
		var i, ld, type, found = null, base, ext = '', asked = null;

		if (!new.target)
			return new Collator(arguments[0], arguments[1]);
		req = C.localeList(arguments[0]);
		o = arguments[1] === undefined ? Object.create(null) :
			X.toObject(arguments[1]);
		usage = getOption(o, 'usage', ['sort', 'search'], 'sort');
		getOption(o, 'localeMatcher', ['lookup', 'best fit'], 'best fit');
		co = getOption(o, 'collation', null, undefined);
		if (co !== undefined && !TYPE.test(co))
			throw new RangeError('Invalid collation : ' + co);
		kn = o.numeric;
		kn = kn === undefined ? undefined : String(!!kn);
		kf = getOption(o, 'caseFirst', ['upper', 'lower', 'false'],
			       undefined);
		for (i = 0; i < req.length && !found; i++) {
			var sp = C.splitTag(req[i]);

			found = C.lookup(sp.base, hasCollation);
			if (found) {
				kw = sp.kw;
				asked = sp.base;
			}
		}
		base = found || C.lookup((W.navigator && W.navigator.language) ||
			'en-US', hasCollation) || 'en-US';
		/* en-US-u-va-posix is ICU's en_US_POSIX */
		ld = kw.va === 'posix' && META.locales[asked + '-POSIX'] ?
			META.locales[asked + '-POSIX'] : localeData(base);
		/* the collation: the option's, else the -u-co- keyword's, if
		 * the locale has it and it is not standard or search */
		type = null;
		[[co, false], [kw.co, true]].forEach(function (c) {
			var v = c[0] && c[0].toLowerCase();

			/* the locale's own default is no collation of its own */
			if (type || !v || v === 'standard' || v === 'search' ||
			    !Object.prototype.hasOwnProperty.call(ld.types, v) ||
			    v === ld.dflt)
				return;
			type = v;
			if (c[1] && co === undefined)
				ext += '-co-' + v;
		});
		if (type && co !== undefined && kw.co === type)
			ext += '-co-' + type;
		s.collation = type || 'default';
		if (usage === 'search')
			type = 'search';
		type = type || ld.dflt;
		s.tail = ld.types[type] ? tailoring(ld.types[type]) : null;
		var set = (s.tail && s.tail.settings) || {};
		/* kn and kf from the options, else the keywords, else the
		 * locale's */
		if (kn !== undefined) {
			s.numeric = kn === 'true';
			if (kw.kn !== undefined && (kw.kn === '' ? 'true' : kw.kn) ===
			    kn)
				ext += kw.kn === '' || kw.kn === 'true' ? '-kn' :
					'-kn-' + kw.kn;
		} else if (kw.kn !== undefined && (kw.kn === '' ||
			   kw.kn === 'true' || kw.kn === 'false')) {
			s.numeric = kw.kn !== 'false';
			ext += kw.kn === '' || kw.kn === 'true' ? '-kn' : '-kn-false';
		} else {
			s.numeric = !!set.numeric;
		}
		if (kf !== undefined) {
			s.caseFirst = kf;
			if (kw.kf === kf)
				ext += '-kf-' + kf;
		} else if (kw.kf === 'upper' || kw.kf === 'lower' ||
			   kw.kf === 'false') {
			s.caseFirst = kw.kf;
			ext += '-kf-' + kw.kf;
		} else {
			s.caseFirst = set.caseFirst || 'false';
		}
		sens = getOption(o, 'sensitivity', ['base', 'accent', 'case',
			'variant'], undefined);
		s.sensitivity = sens || 'variant';
		ip = o.ignorePunctuation;
		s.ignorePunctuation = ip === undefined ? !!set.shifted : !!ip;
		s.usage = usage;
		loc = base + (ext ? '-u' + ext : '');
		s.locale = loc;
		s.opts = {
			strength: s.sensitivity === 'base' || s.sensitivity === 'case' ?
				1 : s.sensitivity === 'accent' ? 2 : 3,
			caseLevel: s.sensitivity === 'case',
			caseFirst: s.caseFirst === 'false' ? '' : s.caseFirst,
			shifted: s.ignorePunctuation,
			backwards: !!set.backwards,
			order: set.reorder ? reordering(set.reorder) : null
		};
		s.opts.sig = [s.opts.strength, s.opts.caseLevel,
			s.opts.caseFirst, set.reorder ? set.reorder.join(' ') : ''
			].join('/');
		s.keys = new Map();
		SLOTS.set(this, s);
		return this;
	}

	/* a reordering's ranks, from the scripts' first primaries */
	var ORDERS = {};

	function reordering(codes) {
		var k = codes.join(' '), r = ORDERS[k];

		if (!r)
			r = ORDERS[k] = buildOrder(codes);
		return r;
	}

	/* ICU's CollationData::makeReorderRanges, as ranks of the groups:
	 * the special groups not listed, then the listed ones, then the
	 * rest in their order, any after Zzzz at the end */
	function buildOrder(codes) {
		var G = META.groups, n = G.length, rank = [], next = 1, i, j;
		var SPECIAL = ['space', 'punct', 'symbol', 'currency', 'digit'];
		var listed = {}, end = [], at;

		codes = codes.map(function (c) { return c.toLowerCase(); });
		codes.forEach(function (c) { listed[c] = true; });
		function give(code) {
			for (j = 0; j < n; j++) {
				if (rank[j] === undefined && G[j][1].indexOf(code) >= 0)
					rank[j] = next++;
			}
		}
		for (i = 0; i < n; i++) {
			if (G[i][0] === 0)
				rank[i] = next++;
		}
		SPECIAL.forEach(function (c) {
			if (!listed[c])
				give(c);
		});
		at = codes.indexOf('zzzz');
		if (at >= 0) {
			end = codes.slice(at + 1);
			codes = codes.slice(0, at);
		}
		codes.forEach(give);
		for (i = 0; i < n; i++) {
			if (rank[i] === undefined && G[i][2] !== 'end' &&
			    end.every(function (c) {
				    return G[i][1].indexOf(c) < 0;
			    }))
				rank[i] = next++;
		}
		end.forEach(give);
		for (i = 0; i < n; i++) {
			if (rank[i] === undefined)
				rank[i] = next++;
		}
		return { starts: G.map(function (g) { return g[0]; }),
			rank: rank.map(function (r) { return r + 2; }) };
	}

	function sortKey(s, str) {
		var k = s.keys.get(str);

		if (k === undefined) {
			k = core.key(core.ces(String(str).normalize('NFD'), s.tail,
					      s.numeric), s.opts);
			if (s.keys.size >= 1024)
				s.keys.clear();
			s.keys.set(str, k);
		}
		return k;
	}

	function compareWith(s, a, b) {
		var x, y;

		a = String(a);
		b = String(b);
		if (a === b)
			return 0;
		x = sortKey(s, a);
		y = sortKey(s, b);
		return x < y ? -1 : x > y ? 1 : 0;
	}

	var proto = Collator.prototype;

	Object.defineProperty(proto, 'compare', {
		configurable: true,
		get: function () {
			var s = slots(this, 'compare');

			if (!s.bound) {
				s.bound = function (a, b) {
					return compareWith(s, a, b);
				};
			}
			return s.bound;
		}
	});
	method(proto, 'resolvedOptions', function resolvedOptions() {
		var s = slots(this, 'resolvedOptions');

		return {
			locale: s.locale, usage: s.usage, sensitivity: s.sensitivity,
			ignorePunctuation: s.ignorePunctuation,
			collation: s.collation, numeric: s.numeric,
			caseFirst: s.caseFirst
		};
	});
	Object.defineProperty(proto, Symbol.toStringTag, {
		configurable: true, value: 'Intl.Collator'
	});
	method(Collator, 'supportedLocalesOf',
	       function supportedLocalesOf(locales) {
		return X.supported(locales, arguments[1], hasCollation);
	});
	Object.defineProperty(Collator, 'prototype', { writable: false });

	/* localeCompare with no arguments is the common case: one
	 * collator for it */
	var plain = null;

	method(String.prototype, 'localeCompare',
	       function localeCompare(that) {
		var c;

		if (this === null || this === undefined)
			throw new TypeError('String.prototype.localeCompare called ' +
					    'on null or undefined');
		if (arguments[1] === undefined && arguments[2] === undefined)
			c = plain || (plain = new Collator());
		else
			c = new Collator(arguments[1], arguments[2]);
		return c.compare(String(this), String(that));
	});

	Intl.Collator = Collator;
};

if (typeof window !== 'undefined' && window.__vitaIntl &&
    window.__vitaIntl.number && window.__vitaIntl.has &&
    window.__vitaIntl.has('k:meta') && window.__vitaIntlCore)
	__vitaIntlCollator(window, window.__vitaIntl, window.__vitaIntlCore,
			   window.__vitaIntl.number);

if (typeof module !== 'undefined')
	module.exports = { install: __vitaIntlCollator,
		core: __vitaCollationCore };
