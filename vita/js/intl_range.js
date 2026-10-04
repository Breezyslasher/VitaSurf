/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Intl.DateTimeFormat's formatRange and formatRangeToParts (VitaSurf), as
 * V8 has them from ICU's DateIntervalFormat.
 *
 * ICU's DateIntervalInfo reads a locale's intervalFormats as its sink
 * does, through the calendar's aliases, into a hash table whose order
 * decides which skeleton wins a tie, so the table is ICU's uhash, hash
 * function, probing and growth and all. DateIntervalFormat's
 * initializePattern, field width adjustment and fallbacks follow, line
 * by line, and the result is split into parts with the spans ICU marks
 * and V8 reads its sources from. Where ICU finds the two dates the same
 * in every field the pattern shows, V8 formats the first alone, and so
 * does this.
 *
 * __vitaIntlRange(D) takes what vita/js/intl.js shares of itself (the
 * pattern module, generators, formatters, moments and SimpleDateFormat's
 * rendering) and returns { create(slots), format(range, x, y),
 * formatToParts(range, x, y) }.
 */
var __vitaIntlRange = function (D) {
	'use strict';

	var P = D.P;

	/* ---- uhash ---- */

	var PRIMES = [7, 13, 31, 61, 127, 251, 509, 1021, 2039, 4093, 8191,
		16381, 32749];
	var EMPTY = -2147483647;

	/* ustr_hashUCharsN, as UnicodeString::hashCode gives it */
	function hashCode(s) {
		var h = 0, len = s.length, inc = ((len - 32) / 32 | 0) + 1, i;

		for (i = 0; i < len; i += inc)
			h = (Math.imul(h, 37) + s.charCodeAt(i)) | 0;
		return h === 0 ? 1 : h;
	}

	/* a uhash of UnicodeString keys that only grows */
	function Hash() {
		this.allocate(4);
	}

	Hash.prototype.allocate = function (primeIndex) {
		var i;

		this.primeIndex = primeIndex;
		this.length = PRIMES[primeIndex];
		this.codes = [];
		this.keys = [];
		this.values = [];
		for (i = 0; i < this.length; i++)
			this.codes.push(EMPTY);
		this.count = 0;
		this.highWaterMark = this.length * 0.5 | 0;
	};

	/* _uhash_find: the slot a key is in, or the one it would go in */
	Hash.prototype.find = function (key, hashcode) {
		var length = this.length;

		hashcode &= 0x7FFFFFFF;
		var index = (hashcode ^ 0x4000000) % length, start = index, jump = 0;

		do {
			var code = this.codes[index];

			if (code === hashcode) {
				if (this.keys[index] === key)
					return index;
			} else if (code === EMPTY) {
				break;
			}
			if (jump === 0)
				jump = hashcode % (length - 1) + 1;
			index = (index + jump) % length;
		} while (index !== start);
		return index;
	};

	Hash.prototype.get = function (key) {
		var i = this.find(key, hashCode(key));

		return this.codes[i] === EMPTY ? undefined : this.values[i];
	};

	Hash.prototype.put = function (key, value) {
		if (this.count > this.highWaterMark)
			this.rehash();
		var code = hashCode(key), i = this.find(key, code);

		if (this.codes[i] === EMPTY)
			this.count++;
		this.codes[i] = code & 0x7FFFFFFF;
		this.keys[i] = key;
		this.values[i] = value;
	};

	Hash.prototype.rehash = function () {
		var codes = this.codes, keys = this.keys, values = this.values, i;

		this.allocate(this.primeIndex + 1);
		for (i = codes.length - 1; i >= 0; i--) {
			if (codes[i] !== EMPTY) {
				var j = this.find(keys[i], codes[i]);

				this.codes[j] = codes[i];
				this.keys[j] = keys[i];
				this.values[j] = values[i];
				this.count++;
			}
		}
	};

	/* the keys, in uhash_nextElement's order */
	Hash.prototype.each = function (fn) {
		var i;

		for (i = 0; i < this.length; i++) {
			if (this.codes[i] !== EMPTY && fn(this.keys[i], this.values[i]))
				return;
		}
	};

	/* ---- DateIntervalInfo ---- */

	/* calendar fields, as ICU numbers them, and their interval pattern
	 * indexes, levels and letters */
	var ERA = 0, YEAR = 1, MONTH = 2, DATE = 5, AM_PM = 9, HOUR = 10,
		MINUTE = 12, SECOND = 13, MILLISECOND = 14;
	var INDEX = {}, LEVEL = {}, LETTER = {};

	[[ERA, 0, 0, 'G'], [YEAR, 1, 10, 'y'], [MONTH, 2, 20, 'M'],
	 [DATE, 3, 30, 'd'], [AM_PM, 4, 40, 'a'], [HOUR, 5, 50, 'h'],
	 [MINUTE, 6, 60, 'm'], [SECOND, 7, 70, 's'],
	 [MILLISECOND, 8, 80, 'S']].forEach(function (e) {
		INDEX[e[0]] = e[1];
		LEVEL[e[0]] = e[2];
		LETTER[e[0]] = e[3];
	});
	var PATTERN_FIELDS = { G: ERA, y: YEAR, M: MONTH, d: DATE, a: AM_PM,
		B: AM_PM, h: HOUR, H: HOUR, m: MINUTE };
	/* SimpleDateFormat::getLevelFromChar */
	var CHAR_LEVEL = { A: 40, D: 20, E: 30, F: 30, G: 0, H: 50, K: 50,
		L: 20, M: 20, O: 0, Q: 20, S: 80, U: 10, V: 0, W: 30, X: 0, Y: 10,
		Z: 0, a: 40, c: 30, d: 30, e: 30, g: 0, h: 50, k: 50, l: 0, m: 60,
		q: 20, r: 10, s: 70, u: 10, v: 0, w: 20, x: 0, y: 10, z: 0 };
	var DEFAULT_FALLBACK = '{0} \u2013 {1}';
	var LOCALE_PREFIX = '/LOCALE/calendar/', SUFFIX = '/intervalFormats';
	var INFOS = {};

	function isTable(v) {
		return v !== null && typeof v === 'object' && !Array.isArray(v) &&
			typeof v.alias !== 'string';
	}

	/* DateIntervalInfo::initializeData for an ICU locale and calendar */
	function intervalInfo(name, cal) {
		var key = name + '/' + cal;

		if (INFOS[key])
			return INFOS[key];
		if (Object.keys(INFOS).length >= 8)
			INFOS = {};
		var info = { fallback: DEFAULT_FALLBACK, laterFirst: false,
			patterns: new Hash() };
		var fallback = P.get(name, ['calendar', cal, 'intervalFormats',
					    'fallback']);

		if (typeof fallback === 'string' && fallback.indexOf('{0}') >= 0 &&
		    fallback.indexOf('{1}') >= 0) {
			info.fallback = fallback;
			info.laterFirst = fallback.indexOf('{0}') >
				fallback.indexOf('{1}');
		}
		/* the sink: each bundle's intervalFormats for the calendar,
		 * then for the calendar an alias names */
		var loaded = {}, type = cal;

		while (type && !loaded[type]) {
			loaded[type] = 1;
			var next = null;

			P.items(name, ['calendar', type], name).forEach(function (it) {
				var t = it.value;

				if (!isTable(t) || t.intervalFormats === undefined)
					return;
				var v = t.intervalFormats;

				if (v && typeof v.alias === 'string') {
					var a = v.alias;

					next = a.indexOf(LOCALE_PREFIX) === 0 &&
						a.slice(-SUFFIX.length) === SUFFIX ?
						a.slice(LOCALE_PREFIX.length, -SUFFIX.length) : null;
					return;
				}
				if (!isTable(v))
					return;
				Object.keys(v).sort().forEach(function (skel) {
					var pats = v[skel];

					if (!isTable(pats))
						return;
					Object.keys(pats).sort().forEach(function (letter) {
						var field = letter.length === 1 ?
							PATTERN_FIELDS[letter] : undefined;

						if (field === undefined || typeof pats[letter] !==
						    'string')
							return;
						var list = info.patterns.get(skel);

						if (!list) {
							list = [];
							info.patterns.put(skel, list);
						}
						if (!list[INDEX[field]])
							list[INDEX[field]] = pats[letter];
					});
				});
			});
			type = next;
		}
		INFOS[key] = info;
		return info;
	}

	function intervalPattern(info, skel, field) {
		var list = info.patterns.get(skel);

		return list && list[INDEX[field]] || '';
	}

	function widths(skel) {
		var w = {}, i;

		for (i = 0; i < skel.length; i++)
			w[skel.charAt(i)] = (w[skel.charAt(i)] || 0) + 1;
		return w;
	}

	/* DateIntervalInfo::getBestSkeleton: { best, diff } */
	function bestSkeleton(info, skeleton) {
		var input = skeleton, replaced = false;

		if (/[zkKab]/.test(skeleton)) {
			input = skeleton.replace(/z/g, 'v').replace(/k/g, 'H')
				.replace(/K/g, 'h').replace(/[ab]/g, '');
			replaced = true;
		}
		var iw = widths(input), best = null, bestDistance = Infinity,
			diff = 0;

		info.patterns.each(function (skel) {
			var w = widths(skel), distance = 0, fieldDiff = 1, c;
			var letters = {};

			for (c in iw)
				letters[c] = 1;
			for (c in w)
				letters[c] = 1;
			for (c in letters) {
				var a = iw[c] || 0, b = w[c] || 0;

				if (a === b)
					continue;
				if (a === 0 || b === 0) {
					fieldDiff = -1;
					distance += 0x1000;
				} else if (c === 'M' && ((a <= 2 && b > 2) ||
					   (a > 2 && b <= 2))) {
					distance += 0x100;
				} else {
					distance += a > b ? a - b : b - a;
				}
			}
			if (distance < bestDistance) {
				best = skel;
				bestDistance = distance;
				diff = fieldDiff;
			}
			if (distance === 0) {
				diff = 0;
				return true;
			}
			return false;
		});
		if (replaced && diff !== -1)
			diff = 2;
		return { best: best, diff: diff };
	}

	/* SimpleDateFormat::isFieldUnitIgnored */
	function fieldUnitIgnored(pattern, field) {
		var level = LEVEL[field], q = false, prev = '', count = 0, i, l;

		for (i = 0; i < pattern.length; i++) {
			var c = pattern.charAt(i);

			if (c !== prev && count > 0) {
				l = CHAR_LEVEL[prev];
				if (level <= (l === undefined ? -1 : l))
					return false;
				count = 0;
			}
			if (c === "'") {
				if (pattern.charAt(i + 1) === "'")
					i++;
				else
					q = !q;
			} else if (!q && /[A-Za-z]/.test(c)) {
				prev = c;
				count++;
			}
		}
		if (count > 0) {
			l = CHAR_LEVEL[prev];
			if (level <= (l === undefined ? -1 : l))
				return false;
		}
		return true;
	}

	/* ---- DateIntervalFormat ---- */

	/* findReplaceInPattern: outside quotes only */
	function replaceUnquoted(p, from, to) {
		var out = '', parts = p.split("'"), i;

		if (parts.length === 1)
			return p.split(from).join(to);
		for (i = 0; i < parts.length; i++) {
			out += (i % 2 ? parts[i] : parts[i].split(from).join(to)) +
				(i < parts.length - 1 ? "'" : '');
		}
		return out;
	}

	/* adjustFieldWidth */
	function adjustFieldWidth(input, best, pattern, diff, suppressDayPeriod) {
		var iw = widths(input), bw = widths(best), p = pattern;

		if (suppressDayPeriod) {
			p = replaceUnquoted(p, '\u00a0a', '');
			p = replaceUnquoted(p, '\u202fa', '');
			p = replaceUnquoted(p, 'a\u00a0', '');
			p = replaceUnquoted(p, 'a\u202f', '');
			p = replaceUnquoted(p, 'a', '');
			p = replaceUnquoted(p, '  ', ' ').trim();
		}
		if (diff === 2) {
			if (input.indexOf('z') >= 0)
				p = replaceUnquoted(p, 'v', 'z');
			if (input.indexOf('K') >= 0)
				p = replaceUnquoted(p, 'h', 'K');
			if (input.indexOf('k') >= 0)
				p = replaceUnquoted(p, 'H', 'k');
			if (input.indexOf('b') >= 0)
				p = replaceUnquoted(p, 'a', 'b');
		}
		if (p.indexOf('a') >= 0 && !bw.a)
			bw.a = 1;
		if (p.indexOf('b') >= 0 && !bw.b)
			bw.b = 1;
		var q = false, prev = '', count = 0, i;

		function widen(at) {
			var c = prev === 'L' ? 'M' : prev;
			var fieldCount = bw[c] || 0, inputCount = iw[c] || 0;

			if (fieldCount === count && inputCount > fieldCount) {
				var add = new Array(inputCount - fieldCount + 1).join(prev);

				p = p.slice(0, at) + add + p.slice(at);
				return add.length;
			}
			return 0;
		}
		for (i = 0; i < p.length; i++) {
			var ch = p.charAt(i);

			if (ch !== prev && count > 0) {
				i += widen(i);
				count = 0;
				ch = p.charAt(i);
			}
			if (ch === "'") {
				if (p.charAt(i + 1) === "'")
					i++;
				else
					q = !q;
			} else if (!q && /[A-Za-z]/.test(ch)) {
				prev = ch;
				count++;
			}
		}
		if (count > 0)
			widen(p.length);
		return p;
	}

	/* splitPatternInto2Part: where the first repeated field starts */
	function splitPoint(p) {
		var seen = {}, q = false, prev = '', count = 0, i, repeated = false;

		for (i = 0; i < p.length; i++) {
			var ch = p.charAt(i);

			if (ch !== prev && count > 0) {
				if (!seen[prev]) {
					seen[prev] = 1;
				} else {
					repeated = true;
					break;
				}
				count = 0;
			}
			if (ch === "'") {
				if (p.charAt(i + 1) === "'")
					i++;
				else
					q = !q;
			} else if (!q && /[A-Za-z]/.test(ch)) {
				prev = ch;
				count++;
			}
		}
		if (count > 0 && !repeated && !seen[prev])
			count = 0;
		return i - count;
	}

	/* getDateTimeSkeleton: the date and time parts, and their
	 * normalized forms */
	function dateTimeSkeleton(skel) {
		var r = { date: '', ndate: '', time: '', ntime: '' };
		var n = { E: 0, d: 0, M: 0, y: 0, m: 0, v: 0, z: 0 }, hour = '', i;

		for (i = 0; i < skel.length; i++) {
			var c = skel.charAt(i);

			if ('EdMy'.indexOf(c) >= 0) {
				r.date += c;
				n[c]++;
			} else if ('GYuQqLlWwDFgecUr'.indexOf(c) >= 0) {
				r.ndate += c;
				r.date += c;
			} else if ('hHkK'.indexOf(c) >= 0) {
				r.time += c;
				if (!hour)
					hour = c;
			} else if (c === 'm' || c === 'z' || c === 'v') {
				r.time += c;
				n[c]++;
			} else if ('aVZjsSAbB'.indexOf(c) >= 0) {
				r.time += c;
				r.ntime += c;
			}
		}
		r.ndate += new Array(n.y + 1).join('y');
		if (n.M)
			r.ndate += n.M < 3 ? 'M' : new Array(Math.min(n.M, 5) + 1)
				.join('M');
		if (n.E)
			r.ndate += n.E <= 3 ? 'E' : new Array(Math.min(n.E, 5) + 1)
				.join('E');
		if (n.d)
			r.ndate += 'd';
		r.ntime += (hour || '') + (n.m ? 'm' : '') + (n.z ? 'z' : '') +
			(n.v ? 'v' : '');
		return r;
	}

	/* the DateIntervalFormat V8 makes for a DateTimeFormat: the skeleton
	 * of its pattern, in its locale with its hour cycle */
	function create(s) {
		var loc = Object.assign({}, s.loc);

		if (s.hc) {
			loc.hour = D.HC_CHAR[s.hc];
			loc.hcKeyword = true;
		}
		var gen = D.generator(loc);
		var best = function (skel) {
			return gen.bestPattern(skel, 0);
		};
		var r = {
			skeleton: P.staticSkeleton(s.pattern),
			info: intervalInfo(loc.name, loc.cal),
			patterns: [],
			datePattern: null,
			timePattern: null,
			dateTime: null
		};
		var i;

		r.fmt = D.formatter(loc, s.num, { pattern: best(r.skeleton) },
				    s.tag);
		r.pattern = r.fmt.pattern;
		for (i = 0; i < 9; i++)
			r.patterns[i] = { first: '', second: '',
				laterFirst: r.info.laterFirst };
		initialize(r, best);
		return r;
	}

	function setPatternInfo(r, field, first, second, laterFirst) {
		var p = r.patterns[INDEX[field]];

		if (first !== null)
			p.first = first;
		if (second !== null)
			p.second = second;
		p.laterFirst = laterFirst;
	}

	/* setIntervalPattern from a whole interval pattern */
	function setInterval(r, field, pattern, laterFirst) {
		if (laterFirst === undefined)
			laterFirst = r.info.laterFirst;
		if (pattern.indexOf('latestFirst:') === 0) {
			laterFirst = true;
			pattern = pattern.slice(12);
		} else if (pattern.indexOf('earliestFirst:') === 0) {
			laterFirst = false;
			pattern = pattern.slice(14);
		}
		var at = splitPoint(pattern);

		setPatternInfo(r, field, pattern.slice(0, at), pattern.slice(at),
			       laterFirst);
	}

	/*
	 * setIntervalPattern from the info: whether the skeleton had to be
	 * extended to find one. st holds the skeleton and its best match,
	 * and the extended pair, which outlives the call as ICU's does (the
	 * difference and best match the call finds for an extended one do
	 * not). Once the month's pattern was found by extending, ICU points
	 * the skeleton and its best match at the extended pair, so that
	 * extending them again extends both.
	 */
	function setFromInfo(r, field, st) {
		var info = r.info, sk = st.skeleton, best = st.best, diff = st.diff;
		var pattern = intervalPattern(info, best, field);
		var suppress = r.skeleton.indexOf('J') >= 0;

		if (!pattern) {
			if (fieldUnitIgnored(best, field))
				return false;
			if (field === AM_PM) {
				pattern = intervalPattern(info, best, HOUR);
				if (pattern)
					setInterval(r, field, adjustFieldWidth(sk, best,
						pattern, diff, suppress));
				return false;
			}
			if (st.extended !== null) {
				st.extended = LETTER[field] + sk;
				st.extendedBest = LETTER[field] + best;
				if (st.aliased) {
					sk = st.skeleton = st.extended;
					best = st.best = st.extendedBest;
				}
				pattern = intervalPattern(info, st.extendedBest, field);
				if (!pattern && diff === 0) {
					var b = bestSkeleton(info, st.extendedBest);

					diff = b.diff;
					if (b.best !== null && diff !== -1) {
						pattern = intervalPattern(info, b.best, field);
						best = b.best;
					}
				}
			}
		}
		if (pattern) {
			if (diff !== 0 || suppress)
				setInterval(r, field, adjustFieldWidth(sk, best, pattern,
					diff, suppress));
			else
				setInterval(r, field, pattern);
			if (st.extended)
				return true;
		}
		return false;
	}

	/* setSeparateDateTimePtn */
	function separate(r, best, date, time) {
		var skel = time || date, b = bestSkeleton(r.info, skel);

		if (b.best === null)
			return false;
		if (date)
			r.datePattern = best(date);
		if (time)
			r.timePattern = best(time);
		if (b.diff === -1)
			return false;
		var st = { skeleton: skel, best: b.best, diff: b.diff,
			extended: time ? null : '', extendedBest: '', aliased: false };

		if (!time) {
			setFromInfo(r, DATE, st);
			if (setFromInfo(r, MONTH, st)) {
				st.best = st.extendedBest;
				st.skeleton = st.extended;
				st.aliased = true;
			}
			setFromInfo(r, YEAR, st);
			setFromInfo(r, ERA, st);
		} else {
			setFromInfo(r, MINUTE, st);
			setFromInfo(r, HOUR, st);
			setFromInfo(r, AM_PM, st);
		}
		return true;
	}

	/* normalizeHourMetacharacters */
	function normalizeHours(r, best) {
		var s = r.skeleton, hourChar = '', dayPeriod = '', hourStart = 0,
			hourLen = 0, dpStart = 0, dpLen = 0, i;

		for (i = 0; i < s.length; i++) {
			var c = s.charAt(i);

			if ('jJChHkK'.indexOf(c) >= 0) {
				if (!hourChar) {
					hourChar = c;
					hourStart = i;
				}
				hourLen++;
			} else if ('abB'.indexOf(c) >= 0) {
				if (!dayPeriod) {
					dayPeriod = c;
					dpStart = i;
				}
				dpLen++;
			} else if (hourChar && dayPeriod) {
				break;
			}
		}
		if (!hourChar)
			return s;
		var hc = 'H', p = best(hourChar).replace(/'[^']*'/g, '')
			.replace(/'/g, '');

		if (p.indexOf('h') >= 0)
			hc = 'h';
		else if (p.indexOf('K') >= 0)
			hc = 'K';
		else if (p.indexOf('k') >= 0)
			hc = 'k';
		if (p.indexOf('b') >= 0)
			dayPeriod = 'b';
		else if (p.indexOf('B') >= 0)
			dayPeriod = 'B';
		else if (!dayPeriod)
			dayPeriod = 'a';
		var rep = hc;

		if (hc !== 'H' && hc !== 'k')
			rep += new Array((dpLen >= 5 || hourLen >= 5 ? 5 :
				dpLen >= 3 || hourLen >= 3 ? 3 : 1) + 1).join(dayPeriod);
		s = s.slice(0, hourStart) + rep + s.slice(hourStart + hourLen);
		if (dpStart > hourStart)
			dpStart += rep.length - hourLen;
		return s.slice(0, dpStart) + s.slice(dpStart + dpLen);
	}

	/* DateIntervalFormat::initializePattern */
	function initialize(r, best) {
		var sk = dateTimeSkeleton(normalizeHours(r, best));
		var date = sk.date, time = sk.time;

		if (time && date) {
			/* the Gregorian calendar's date-time glue, for any calendar */
			var dtp = P.get(r.fmt.name, ['calendar', 'gregorian',
						     'DateTimePatterns']);
			var glue = dtp && dtp[8];

			if (typeof glue === 'string' && glue.length >= 3)
				r.dateTime = glue;
		}
		var found = separate(r, best, sk.ndate, sk.ntime);
		var p;

		if (!found || (time && !date)) {
			if (time && !date) {
				p = best('yMd' + time);
				setPatternInfo(r, DATE, null, p, r.info.laterFirst);
				setPatternInfo(r, MONTH, null, p, r.info.laterFirst);
				setPatternInfo(r, YEAR, null, p, r.info.laterFirst);
				p = best('GyMd' + time);
				setPatternInfo(r, ERA, null, p, r.info.laterFirst);
			}
			return;
		}
		if (!time)
			return;
		var skeleton = r.skeleton;

		[[DATE, 'd'], [MONTH, 'M'], [YEAR, 'y'], [ERA, 'G']].forEach(
			function (e) {
				if (date.indexOf(e[1]) < 0) {
					skeleton = e[1] + skeleton;
					setPatternInfo(r, e[0], null, best(skeleton),
						       r.info.laterFirst);
				}
			});
		if (!r.dateTime)
			return;
		var datePattern = best(date);

		[AM_PM, HOUR, MINUTE].forEach(function (field) {
			var t = r.patterns[INDEX[field]];

			if (t.first)
				setInterval(r, field, P.simpleFormat(r.dateTime,
					[t.first + t.second, datePattern]), t.laterFirst);
		});
	}

	/* ---- formatting ---- */

	function render(r, pattern, t, acc) {
		D.applyPattern(r.fmt, pattern);
		D.render(r.fmt, t, acc);
	}

	/* fallbackFormatRange */
	function fallbackRange(r, a, b, acc) {
		var p = r.info.fallback, i0 = p.indexOf('{0}'), i1 = p.indexOf('{1}');
		var pattern = r.fmt.pattern;

		if (i0 < i1) {
			acc.first = 0;
			acc.s += p.slice(0, i0);
			render(r, pattern, a, acc);
			acc.s += p.slice(i0 + 3, i1);
			render(r, pattern, b, acc);
			acc.s += p.slice(i1 + 3);
		} else {
			acc.first = 1;
			acc.s += p.slice(0, i1);
			render(r, pattern, b, acc);
			acc.s += p.slice(i1 + 3, i0);
			render(r, pattern, a, acc);
			acc.s += p.slice(i0 + 3);
		}
	}

	/* fallbackFormat */
	function fallback(r, a, b, sameDay, acc) {
		if (sameDay && r.datePattern !== null && r.timePattern !== null &&
		    r.dateTime) {
			var g = r.dateTime, i0 = g.indexOf('{0}'), i1 = g.indexOf('{1}');
			var full = r.fmt.pattern;

			if (i0 < i1) {
				acc.s += g.slice(0, i0);
				D.applyPattern(r.fmt, r.timePattern);
				fallbackRange(r, a, b, acc);
				acc.s += g.slice(i0 + 3, i1);
				render(r, r.datePattern, a, acc);
				acc.s += g.slice(i1 + 3);
			} else {
				acc.s += g.slice(0, i1);
				render(r, r.datePattern, a, acc);
				acc.s += g.slice(i1 + 3, i0);
				D.applyPattern(r.fmt, r.timePattern);
				fallbackRange(r, a, b, acc);
				acc.s += g.slice(i0 + 3);
			}
			D.applyPattern(r.fmt, full);
		} else {
			fallbackRange(r, a, b, acc);
		}
	}

	/* the largest calendar field the two moments differ in */
	function largestDifference(a, b) {
		if (a.era !== b.era)
			return ERA;
		if (a.year !== b.year)
			return YEAR;
		if (a.month !== b.month)
			return MONTH;
		if (a.day !== b.day)
			return DATE;
		if ((a.hour >= 12) !== (b.hour >= 12))
			return AM_PM;
		if (a.hour % 12 !== b.hour % 12)
			return HOUR;
		if (a.minute !== b.minute)
			return MINUTE;
		if (a.second !== b.second)
			return SECOND;
		if (a.ms !== b.ms)
			return MILLISECOND;
		return -1;
	}

	/* DateIntervalFormat::formatImpl: the text and its fields, or null
	 * where ICU writes one date, which V8 then formats itself */
	function formatImpl(r, s, x, y) {
		var a = D.moment(r.fmt, s.zone, x), b = D.moment(r.fmt, s.zone, y);
		var field = largestDifference(a, b), original = r.pattern;
		var acc = { s: '', fields: [], first: -1 };

		if (field < 0)
			return null;
		var sameDay = field >= AM_PM;
		var ip = r.patterns[INDEX[field]];

		if (!ip.first && !ip.second) {
			if (fieldUnitIgnored(original, field))
				return null;
			fallback(r, a, b, sameDay, acc);
		} else if (!ip.first) {
			D.applyPattern(r.fmt, ip.second);
			fallback(r, a, b, sameDay, acc);
		} else {
			acc.first = ip.laterFirst ? 1 : 0;
			render(r, ip.first, ip.laterFirst ? b : a, acc);
			if (ip.second)
				render(r, ip.second, ip.laterFirst ? a : b, acc);
		}
		D.applyPattern(r.fmt, original);
		return spans(acc);
	}

	/* addOverlapSpans, then the sort FormattedValue gives the fields */
	function spans(acc) {
		var f = acc.fields, s1a = Infinity, s1b = 0, s2a = Infinity, s2b = 0;
		var i, j, list = [];

		for (i = 0; i < f.length; i++) {
			for (j = i + 1; j < f.length; j++) {
				if (f[i].ch !== f[j].ch)
					continue;
				s1a = Math.min(s1a, f[i].start);
				s1b = Math.max(s1b, f[i].end);
				s2a = Math.min(s2a, f[j].start);
				s2b = Math.max(s2b, f[j].end);
				break;
			}
		}
		if (s1a === Infinity || acc.first < 0)
			return null;
		f.forEach(function (e, k) {
			list.push({ span: -1, ch: e.ch, start: e.start, end: e.end, n: k });
		});
		list.push({ span: acc.first, start: s1a, end: s1b, n: f.length });
		list.push({ span: 1 - acc.first, start: s2a, end: s2b,
			n: f.length + 1 });
		list.sort(function (p, q) {
			if (p.start !== q.start)
				return p.start - q.start;
			if (p.end !== q.end)
				return q.end - p.end;
			if ((p.span >= 0) !== (q.span >= 0))
				return p.span >= 0 ? -1 : 1;
			return p.n - q.n;
		});
		return { s: acc.s, list: list };
	}

	/* FormattedDateIntervalToJSArray, with V8's source tracker */
	function toParts(res) {
		var parts = [], prev = 0, src = [[0, 0], [0, 0]];

		function source(start, end) {
			var k;

			for (k = 0; k < 2; k++) {
				if (src[k][0] <= start && start <= src[k][1] &&
				    src[k][0] <= end && end <= src[k][1])
					return k ? 'endRange' : 'startRange';
			}
			return 'shared';
		}
		res.list.forEach(function (e) {
			if (e.span >= 0) {
				src[e.span] = [e.start, e.end];
				return;
			}
			if (e.start > prev)
				parts.push({ type: 'literal', value: res.s.slice(prev, e.start),
					source: source(prev, e.start) });
			parts.push({ type: D.TYPES[e.ch] || 'literal',
				value: res.s.slice(e.start, e.end),
				source: source(e.start, e.end) });
			prev = e.end;
		});
		if (res.s.length > prev)
			parts.push({ type: 'literal', value: res.s.slice(prev),
				source: source(prev, res.s.length) });
		return parts;
	}

	function format(r, s, x, y) {
		var res = formatImpl(r, s, x, y);

		return res ? res.s : null;
	}

	function formatToParts(r, s, x, y) {
		var res = formatImpl(r, s, x, y);

		return res ? toParts(res) : null;
	}

	return { create: create, format: format, formatToParts: formatToParts };
};

if (typeof module !== 'undefined')
	module.exports = __vitaIntlRange;
