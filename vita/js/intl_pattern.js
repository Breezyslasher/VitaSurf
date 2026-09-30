/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Intl.DateTimeFormat's choice of pattern (VitaSurf).
 *
 * The options a page passes become a skeleton -- "yMMMMd" for a year, a
 * long month and a day -- and the skeleton becomes a pattern, "MMMM d, y",
 * the way ICU's DateTimePatternGenerator does it, since that is what every
 * browser runs: the nearest skeleton the locale has a pattern for, its
 * fields widened or narrowed to what was asked, a date and a time put
 * together with the locale's glue when no one pattern has both, and a
 * field no pattern has appended on the end. The locale data comes from
 * vita/js/intl.c, generated from ICU by scripts/gen-intl-data.mjs, which
 * also runs this file under Node against ICU itself and records the
 * answer for any skeleton where the two differ.
 *
 * Plain script with no browser dependencies, so that the generator can
 * load it.
 */
var __vitaIntlPattern = (function () {
	'use strict';

	/* ICU's field types (DateTimePatternGenerator's dtTypes) */
	var NUMERIC = 0x100, NARROW = -0x101, SHORTER = -0x102, SHORT = -0x103,
		LONG = -0x104, DELTA = 0x10;

	/* letter -> field; the order is ICU's field order, which decides
	 * which missing field is appended with which glue */
	var FIELD = {
		G: 0, y: 1, Y: 1, u: 1, M: 3, L: 3, d: 9, E: 6, c: 6, e: 6,
		a: 10, b: 10, B: 10, h: 11, H: 11, K: 11, k: 11, m: 12, s: 13,
		S: 14, z: 15, v: 15, O: 15, V: 15
	};
	var DATE_MASK = (1 << 10) - 1;
	var NAMES = ['era', 'year', '', 'month', '', '', 'day of the week', '',
		'', 'day', 'AM/PM', 'hour', 'minute', 'second', '', 'time zone'];

	function type(ch, len) {
		switch (ch) {
		case 'G': return len <= 3 ? SHORT : len === 4 ? LONG : NARROW;
		case 'y': return NUMERIC + len;
		case 'Y': return NUMERIC + DELTA + len;
		case 'u': return NUMERIC + 2 * DELTA + len;
		case 'M': return len <= 2 ? NUMERIC + len :
			len === 3 ? SHORT : len === 4 ? LONG : NARROW;
		case 'L': return len <= 2 ? NUMERIC + DELTA + len :
			len === 3 ? SHORT - DELTA : len === 4 ? LONG - DELTA :
			NARROW - DELTA;
		case 'd': return NUMERIC + len;
		case 'E': return len <= 3 ? SHORT : len === 4 ? LONG :
			len === 5 ? NARROW : SHORTER;
		case 'c': return len <= 2 ? NUMERIC + 2 * DELTA + len :
			len === 3 ? SHORT - 2 * DELTA : len === 4 ?
			LONG - 2 * DELTA : len === 5 ? NARROW - 2 * DELTA :
			SHORTER - 2 * DELTA;
		case 'e': return len <= 2 ? NUMERIC + DELTA + len :
			len === 3 ? SHORT - DELTA : len === 4 ? LONG - DELTA :
			len === 5 ? NARROW - DELTA : SHORTER - DELTA;
		case 'a': return len <= 3 ? SHORT : len === 4 ? LONG : NARROW;
		case 'b': return len <= 3 ? SHORT - DELTA : len === 4 ?
			LONG - DELTA : NARROW - DELTA;
		case 'B': return len <= 3 ? SHORT - 3 * DELTA : len === 4 ?
			LONG - 3 * DELTA : NARROW - 3 * DELTA;
		case 'h': return NUMERIC + len;
		case 'K': return NUMERIC + DELTA + len;
		case 'H': return NUMERIC + 10 * DELTA + len;
		case 'k': return NUMERIC + 11 * DELTA + len;
		case 'm': return NUMERIC + len;
		case 's': return NUMERIC + len;
		case 'S': return NUMERIC + DELTA + len;
		case 'z': return len <= 3 ? SHORT : LONG;
		case 'O': return len === 1 ? SHORT - DELTA : LONG - DELTA;
		case 'v': return len === 1 ? SHORT - 2 * DELTA : LONG - 2 * DELTA;
		case 'V': return SHORT - DELTA;
		}
		return 0;
	}

	/* A skeleton: per field, the letter and its count. A twelve hour
	 * clock brings its AM/PM with it, as it does in ICU. */
	function Skeleton() {
		this.ch = [];
		this.len = [];
		this.type = [];
		this.mask = 0;
	}
	Skeleton.prototype.set = function (ch, len) {
		var f = FIELD[ch];

		if (f === undefined)
			return false;
		this.ch[f] = ch;
		this.len[f] = len;
		this.type[f] = type(ch, len);
		this.mask |= 1 << f;
		return true;
	};
	Skeleton.prototype.finish = function () {
		var h = this.ch[11];

		if ((h === 'h' || h === 'K') && !(this.mask & (1 << 10)))
			this.set('a', 1);
		return this;
	};
	Skeleton.prototype.only = function (mask) {
		var s = new Skeleton(), f;

		for (f = 0; f < 16; f++) {
			if (this.mask & mask & (1 << f))
				s.set(this.ch[f], this.len[f]);
		}
		return s;
	};

	/* the letters of a skeleton string, or a pattern's fields */
	function parse(str, isPattern) {
		var s = new Skeleton(), i = 0, n = str.length;

		while (i < n) {
			var c = str.charAt(i), j = i + 1;

			if (isPattern && c === "'") {
				j = i + 1;
				while (j < n && str.charAt(j) !== "'")
					j++;
				i = j + 1;
				continue;
			}
			while (j < n && str.charAt(j) === c)
				j++;
			if (FIELD[c] !== undefined && !(isPattern && c === 'a' &&
					false))
				s.set(c, j - i);
			else if (!isPattern && /[A-Za-z]/.test(c))
				return null;	/* a field this does not know */
			i = j;
		}
		return s.finish();
	}

	function distance(req, cand, info) {
		var d = 0, f, missing = 0, extra = 0;

		for (f = 0; f < 16; f++) {
			var a = req.type[f] || 0, b = cand.type[f] || 0;

			if (a === b)
				continue;
			if (a === 0) {
				d += 0x10000;
				extra |= 1 << f;
			} else if (b === 0) {
				d += 0x1000;
				missing |= 1 << f;
			} else {
				d += Math.abs(a - b);
			}
		}
		info.missing = missing;
		info.extra = extra;
		return d;
	}

	/* The locale's candidates, built once per locale in the order ICU
	 * adds them: each field alone, the date and time styles under the
	 * skeletons their patterns have, then the patterns the locale lists
	 * by skeleton. One under a skeleton already there takes its place,
	 * and on a tie the one added first wins. */
	function candidates(loc) {
		var list = [], at = {}, k;

		function add(skel, pattern, specified, key) {
			var id = skel.ch.map(function (c, f) {
				return c ? c + skel.len[f] : '';
			}).join('');

			if (at[id] !== undefined) {
				list[at[id]] = { skel: skel, pattern: pattern,
					specified: specified, key: key };
				return;
			}
			at[id] = list.length;
			list.push({ skel: skel, pattern: pattern,
				specified: specified, key: key });
		}

		if (loc._cand)
			return loc._cand;
		'GyMEdaHmsSv'.split('').forEach(function (c) {
			add(parse(c, false), c, false, c);
		});
		['full', 'long', 'medium', 'short'].forEach(function (st) {
			add(parse(loc.date[st], true), loc.date[st], false,
			    loc.date[st]);
		});
		['full', 'long', 'medium', 'short'].forEach(function (st) {
			add(parse(loc.time[st], true), loc.time[st], false,
			    loc.time[st]);
		});
		for (k in loc.skel) {
			var s = parse(k, false);

			if (s)
				add(s, loc.skel[k], true, k);
		}
		loc._cand = list;
		return list;
	}

	function bestRaw(loc, req, info) {
		var list = candidates(loc), best = null, bd = Infinity, i,
			tmp = {};

		for (i = 0; i < list.length; i++) {
			var d = distance(req, list[i].skel, tmp);

			/* a tie goes to the one that starts with the earlier
			 * field, as ICU's walk of its pattern map has it */
			if (d < bd || (d === bd && best &&
			    lowBit(list[i].skel.mask) < lowBit(best.skel.mask))) {
				bd = d;
				best = list[i];
				info.missing = tmp.missing;
				info.extra = tmp.extra;
				if (d === 0)
					break;
			}
		}
		return best;
	}

	/* ICU's adjustFieldTypes: the pattern's fields widened or narrowed
	 * to the skeleton's, the hour's too (V8 asks for that), minutes
	 * and seconds as the pattern has them */
	function adjust(pattern, spec, req, fixFraction, dec, keepHour) {
		var out = '', i = 0, n = pattern.length;

		while (i < n) {
			var c = pattern.charAt(i), j = i + 1;

			if (c === "'") {
				while (j < n && pattern.charAt(j) !== "'")
					j++;
				out += pattern.substring(i, j + 1);
				i = j + 1;
				continue;
			}
			while (j < n && pattern.charAt(j) === c)
				j++;
			var len = j - i, f = FIELD[c];

			if (f === undefined) {
				out += pattern.substring(i, j);
			} else if (fixFraction && f === 13 &&
				   (req.mask & (1 << 14))) {
				out += pattern.substring(i, j) + dec +
					rep('S', req.len[14]);
			} else if (req.mask & (1 << f)) {
				var rc = req.ch[f], rl = req.len[f], adj = rl;

				if (rc === 'E' && rl < 3)
					rl = adj = 3;
				if (f === 12 || f === 13 || (f === 11 && keepHour)) {
					adj = len;
				} else if (spec && rc !== 'c' && rc !== 'e') {
					var sl = spec.len[f] || 0,
						pn = type(c, len) > 0,
						sn = (spec.type[f] || 0) > 0;

					if (sl === rl || (pn && !sn) || (sn && !pn))
						adj = len;
				}
				var oc = (f !== 11 && f !== 3 && f !== 6 &&
					  (f !== 1 || rc === 'Y')) ? rc : c;

				if (f === 11)
					oc = rc;
				out += rep(oc, adj);
			} else {
				out += pattern.substring(i, j);
			}
			i = j;
		}
		return out;
	}

	function rep(c, n) {
		var s = '';

		while (n-- > 0)
			s += c;
		return s;
	}

	function quote(s) {
		return /[A-Za-z']/.test(s) ? "'" + s.replace(/'/g, "''") + "'" : s;
	}

	function lowBit(mask) {
		var f = 0;

		if (!mask)
			return 99;
		while (!(mask & 1)) {
			f++;
			mask >>>= 1;
		}
		return f;
	}

	function topBit(mask) {
		var f = -1;

		while (mask) {
			f++;
			mask >>>= 1;
		}
		return f;
	}

	function appending(loc, req, mask, keepHour) {
		var info = {}, part = req.only(mask), best, pat;

		if (!part.mask)
			return '';
		best = bestRaw(loc, part, info);
		pat = adjust(best.pattern, best.specified ? best.skel : null,
			     part, true, loc.dec || '.', keepHour);
		/* the fraction goes with the seconds */
		if ((info.missing & (1 << 14)) && (part.mask & (1 << 13)))
			info.missing &= ~(1 << 14);
		while (info.missing) {
			var start = info.missing, sub = part.only(start),
				tinfo = {}, b2 = bestRaw(loc, sub, tinfo), p2;

			if (!b2 || distance(sub, b2.skel, {}) >= 0x1000 *
			    popcount(sub.mask)) {
				/* nothing has it: the field alone */
				p2 = fieldAlone(sub);
				tinfo.missing = 0;
			} else {
				p2 = adjust(b2.pattern, b2.specified ?
					    b2.skel : null, sub, true,
					    loc.dec || '.', keepHour);
			}
			var found = start & ~tinfo.missing, top = topBit(found),
				fmt = (loc.append && loc.append[top]) ||
				((top === 0 || top === 1 || top === 6 ||
				  top === 15) ? '{0} {1}' : top === 10 ?
				 '{0} \u251c{2}: {1}\u2524' : '{0} ({2}: {1})');

			pat = fmt.replace('{0}', pat).replace('{1}', p2)
				.replace('{2}', quote((loc.fields &&
					loc.fields[top]) || NAMES[top] || ''));
			info.missing = tinfo.missing & start;
			if (info.missing === start)
				break;
		}
		return pat;
	}

	function popcount(m) {
		var n = 0;

		while (m) {
			n += m & 1;
			m >>>= 1;
		}
		return n;
	}

	function fieldAlone(s) {
		var f, out = '';

		for (f = 0; f < 16; f++) {
			if ((s.mask & (1 << f)) && f !== 10)
				out += (out ? ' ' : '') + rep(s.ch[f], s.len[f]);
		}
		return out;
	}

	/* ICU's getBestPattern. V8 asks for the hour as wide as the
	 * options say; ICU's own callers, a range among them, keep the
	 * pattern's (keepHour). */
	function bestPattern(loc, skeletonStr, keepHour) {
		var req, info = {}, best, dp, tp, style, glue;

		if ((!keepHour || !/[hHKk]/.test(skeletonStr)) && loc.over &&
		    loc.over[skeletonStr] !== undefined)
			return loc.over[skeletonStr];
		req = parse(skeletonStr, false);
		best = bestRaw(loc, req, info);
		if (best && !info.missing && !info.extra)
			return adjust(best.pattern, best.specified ? best.skel :
				      null, req, true, loc.dec || '.', keepHour);
		dp = appending(loc, req, DATE_MASK, keepHour);
		tp = appending(loc, req, ~DATE_MASK, keepHour);
		if (!dp)
			return tp;
		if (!tp)
			return dp;
		style = 3;
		if (req.len[3] === 4)
			style = req.mask & (1 << 6) ? 0 : 1;
		else if (req.len[3] === 3)
			style = 2;
		glue = loc.glue[style];
		return glue.replace('{1}', dp).replace('{0}', tp);
	}

	/* the fields of a pattern, as resolvedOptions reports them */
	function fieldsOf(pattern) {
		var o = {}, i = 0, n = pattern.length;

		while (i < n) {
			var c = pattern.charAt(i), j = i + 1;

			if (c === "'") {
				while (j < n && pattern.charAt(j) !== "'")
					j++;
				i = j + 1;
				continue;
			}
			while (j < n && pattern.charAt(j) === c)
				j++;
			o[c] = j - i;
			i = j;
		}
		return o;
	}

	/* ICU's DateIntervalFormat reads a skeleton with the widths of
	 * numbers dropped, month and weekday names kept */
	function normalize(skel) {
		var n = {}, out = '', i;

		for (i = 0; i < skel.length; i++)
			n[skel.charAt(i)] = (n[skel.charAt(i)] || 0) + 1;
		if (n.G)
			out += rep('G', n.G);
		if (n.y)
			out += rep('y', n.y);
		if (n.M)
			out += n.M < 3 ? 'M' : rep('M', n.M);
		if (n.E)
			out += n.E <= 3 ? 'E' : rep('E', n.E);
		if (n.d)
			out += 'd';
		if (n.B)
			out += rep('B', n.B);
		if (n.H || n.k)
			out += 'H';
		else if (n.h || n.K)
			out += 'h';
		if (n.m)
			out += 'm';
		if (n.z)
			out += n.z >= 4 ? 'zzzz' : 'z';
		if (n.v)
			out += n.v >= 4 ? 'vvvv' : 'v';
		return out;
	}

	/* The pattern for a range the dates of which first differ in a
	 * field (y, M, d, a for AM and PM, h, m): the locale's, under the
	 * skeleton with the same fields as this one, a field widened where
	 * the skeleton asks for it wider than the pattern's has it. null
	 * where the locale has none, and the range is the two dates
	 * written out in full. */
	function intervalPattern(loc, skeletonStr, letter) {
		var norm = normalize(skeletonStr), req = parse(norm, false),
			best = null, bd = Infinity, i, k, info = {};

		if (!req || !loc.iv)
			return null;
		/* a range down to the second has no pattern of its own */
		if (/[sS]/.test(skeletonStr))
			return null;
		if (!loc._ivc) {
			loc._ivc = [];
			for (k in loc.iv) {
				var s = parse(k, false);

				if (s)
					loc._ivc.push({ key: k, skel: s });
			}
		}
		for (i = 0; i < loc._ivc.length; i++) {
			var d = distance(req, loc._ivc[i].skel, info);

			/* the same fields, numbers for numbers and names
			 * for names */
			if (d < 0x100 && d < bd) {
				bd = d;
				best = loc._ivc[i];
			}
		}
		if (!best)
			return null;
		var pat = loc.iv[best.key][letter];

		if (!pat && letter === 'a')
			pat = loc.iv[best.key].h;
		if (!pat)
			return null;
		return widen(pat, best.skel, req);
	}

	/* ICU's adjustFieldWidth: a field the pattern has as wide as the
	 * matched skeleton does, and the skeleton asked for wider */
	function widen(pattern, keySkel, req) {
		var out = '', i = 0, n = pattern.length;

		while (i < n) {
			var c = pattern.charAt(i), j = i + 1;

			if (c === "'") {
				while (j < n && pattern.charAt(j) !== "'")
					j++;
				out += pattern.substring(i, j + 1);
				i = j + 1;
				continue;
			}
			while (j < n && pattern.charAt(j) === c)
				j++;
			var len = j - i, f = FIELD[c];

			if (f !== undefined && f !== 11 && keySkel.len[f] === len &&
			    req.len[f] > len)
				len = req.len[f];
			out += rep(c === 'v' && req.ch[f] === 'z' ? 'z' : c, len);
			i = j;
		}
		return out;
	}

	return {
		bestPattern: bestPattern,
		intervalPattern: intervalPattern,
		fieldsOf: fieldsOf,
		parse: parse
	};
})();
if (typeof module !== 'undefined')
	module.exports = __vitaIntlPattern;
