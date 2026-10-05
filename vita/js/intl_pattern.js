/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * ICU's date data and its DateTimePatternGenerator (VitaSurf).
 *
 * Intl.DateTimeFormat (vita/js/intl.js) turns the options a page passes
 * into a skeleton -- "yMMMMd" for a year, a long month and a day -- and
 * the skeleton into a pattern, "MMMM d, y", the way V8 does it with ICU's
 * DateTimePatternGenerator. This is that generator, line by line from
 * ICU's dtptngen.cpp, its pattern map walked in ICU's order so that a
 * tie goes the same way, with what it reads read as ICU reads it: from
 * ICU's own locale bundles in resources/intl.pak
 * (scripts/gen-intl-dates.mjs), looked up as ICU's resource bundles look
 * things up, falling back through a bundle's parents and following its
 * aliases. The same lookup gives intl.js the names DateFormatSymbols
 * reads and the range patterns DateIntervalInfo reads.
 *
 * __vitaIntlPattern(N) takes what reads the pack (N.pak) and has no
 * browser dependencies, so that the generators and tests can run it
 * under Node.
 */
var __vitaIntlPattern = function (N) {
	'use strict';

	/* ---- ICU's resource bundles ---- */

	/* the bundles of one of ICU's trees in the pack: <prefix>:index and
	 * <prefix>:<bundle> (scripts/icu-res.mjs bundleEntries) */
	function makeTree(prefix) {
	
		var INDEX = null, BUNDLES = null, FILES = {};

		function index() {
			if (!INDEX) {
				INDEX = JSON.parse(N.pak(prefix + ':index'));
				BUNDLES = {};
				INDEX.b.split(' ').forEach(function (b) {
					BUNDLES[b] = 1;
				});
			}
			return INDEX;
		}

		/* a bundle's own data; null where there is no such bundle */
		function file(name) {
			if (FILES[name] === undefined) {
				index();
				FILES[name] = BUNDLES[name] ?
					JSON.parse(N.pak(prefix + ':' + name) || '{}') : null;
			}
			return FILES[name];
		}

		function parentOf(name) {
			if (name === 'root')
				return null;
			var p = index().p[name], cut = name.lastIndexOf('_');

			return p || (cut > 0 ? name.slice(0, cut) : 'root');
		}

		/* the bundle that stands for a name, following %%ALIAS */
		function resolveName(name) {
			var a = index().a, k;

			for (k = 0; k < 10 && a[name]; k++)
				name = a[name];
			return name;
		}

		function exists(name) {
			index();
			return !!(BUNDLES[name] || INDEX.a[name]);
		}

		/* the bundle ICU opens for a locale: its own, the one it is an alias
		 * of, or for one with none the one ICU's fallback finds */
		function opened(name) {
			if (!exists(name) && index().f[name])
				name = INDEX.f[name];
			return resolveName(name);
		}

		var CHAINS = {};

		/* the bundles looked in for a locale, the locale first, root last */
		function chain(name) {
			if (CHAINS[name])
				return CHAINS[name];
			var out = [], n = opened(name);

			while (n) {
				if (file(n))
					out.push(n);
				n = parentOf(n);
				if (n)
					n = resolveName(n);
			}
			CHAINS[name] = out;
			return out;
		}

		/*
		 * The calendar ures_getFunctionalEquivalent gives for a locale with
		 * none asked for, as DateTimePatternGenerator reads its patterns
		 * with: the calendar/default of the first bundle that has one of its
		 * own, going up by %%Parent -- a bundle's, or the nearest one above
		 * it that has one -- or else by dropping the last subtag.
		 */
		function defaultCalendar(name) {
			var parent = name, found, k, i;

			for (k = 0; k < 20; k++) {
				var res = opened(parent);

				if (exists(parent)) {
					var own = file(res), c = own && own.calendar &&
						own.calendar['default'];

					if (typeof c === 'string' && c)
						return c;
				}
				found = res;
				if (found !== parent) {
					parent = found;
				} else {
					var ch = chain(found), next = null;

					for (i = 0; i < ch.length && next === null; i++) {
						if (index().p[ch[i]] !== undefined)
							next = INDEX.p[ch[i]];
					}
					if (next === null) {
						var cut = found.lastIndexOf('_');

						next = cut > 0 ? found.slice(0, cut) : '';
					}
					parent = next;
				}
				if (!found || found === 'root' || !parent)
					break;
			}
			return 'gregorian';
		}

		function target(alias, requested) {
			var p = alias.split('/').filter(Boolean);

			if (alias.charAt(0) !== '/')
				return { bundle: p[0], path: p.slice(1) };
			if (p[0] === 'LOCALE')
				return { bundle: requested, path: p.slice(1) };
			if (p[0] === 'ICUDATA')
				p.shift();
			return { bundle: p[0], path: p.slice(1) };
		}

		/* where ures_getByKeyWithFallback finds a path: the first bundle
		 * down the chain that has it, an alias on the way followed into its
		 * target, /LOCALE/ being the locale first asked for */
		function locate(locale, keys, requested, depth) {
			var c = chain(locale), i, k;

			if (depth > 30)
				throw new Error('alias loop');
			for (i = 0; i < c.length; i++) {
				var v = file(c[i]);

				for (k = 0; k < keys.length; k++) {
					if (isAlias(v)) {
						var t = target(v.alias, requested);

						return locate(t.bundle, t.path.concat(keys.slice(k)),
							      requested, depth + 1);
					}
					if (v === null || typeof v !== 'object' ||
					    !Object.prototype.hasOwnProperty.call(v, keys[k]))
						break;
					v = v[keys[k]];
				}
				if (k < keys.length || v === null)
					continue;
				if (isAlias(v)) {
					var a = target(v.alias, requested);

					return locate(a.bundle, a.path, requested, depth + 1);
				}
				return { bundle: c[i], path: keys, value: v };
			}
			return null;
		}

		/* the tables getAllItemsWithFallback hands its sink, nearest first */
		function items(locale, keys, requested) {
			var out = [], at = locate(locale, keys, requested, 0);

			while (at) {
				out.push(at);
				var p = parentOf(at.bundle);

				if (!p)
					break;
				at = locate(resolveName(p), at.path, requested, 0);
			}
			return out;
		}

		/* the value at a path: a table as a sink sees it, each key the
		 * nearest table's that has it (all the way down when deep); else
		 * where it is first found */
		function get(locale, keys, deep, requested, depth) {
			var its = items(locale, keys, requested || locale);

			if (!its.length)
				return undefined;
			if (!isTable(its[0].value))
				return its[0].value;
			return merge(its.map(function (it) {
				return it.value;
			}), requested || locale, deep, depth || 0);
		}

		function merge(tables, requested, deep, depth) {
			var out = {}, seen = {}, i, k;

			if (depth > 20)
				throw new Error('alias loop');
			for (i = 0; i < tables.length; i++) {
				var t = tables[i];

				if (!isTable(t))
					continue;
				for (k in t) {
					var e = t[k];

					if (isAlias(e)) {
						var a = target(e.alias, requested);

						e = get(a.bundle, a.path, deep, requested, depth + 1);
					}
					if (!Object.prototype.hasOwnProperty.call(out, k)) {
						out[k] = e;
						seen[k] = [e];
					} else if (deep && isTable(out[k])) {
						seen[k].push(e);
					}
				}
			}
			if (deep) {
				for (k in out) {
					if (isTable(out[k]) && seen[k].length > 1)
						out[k] = merge(seen[k], requested, deep, depth + 1);
				}
			}
			return out;
		}

		return { get: get, items: items, locate: locate, chain: chain,
			opened: opened, exists: exists, file: file, index: index,
			parentOf: parentOf, defaultCalendar: defaultCalendar };
	}

	function isAlias(v) {
		return v !== null && typeof v === 'object' && !Array.isArray(v) &&
			typeof v.alias === 'string';
	}

	function isTable(v) {
		return v !== null && typeof v === 'object' && !Array.isArray(v) &&
			!isAlias(v);
	}

	var DT = makeTree('dt'), TREES = { dt: DT };
	var get = DT.get, items = DT.items, locate = DT.locate, chain = DT.chain;

	function tree(prefix) {
		return TREES[prefix] || (TREES[prefix] = makeTree(prefix));
	}

	/* ---- DateFormatSymbols ---- */

	/* the day periods' keys, DayPeriodRules' order */
	var PERIODS = ['midnight', 'noon', 'morning1', 'afternoon1', 'evening1',
		'night1', 'morning2', 'afternoon2', 'evening2', 'night2'];
	var ERAS = null, SYMBOLS = {};

	/* binary resource tables keep their keys in byte order */
	function sortedKeys(t) {
		return Object.keys(t).sort(function (a, b) {
			return a < b ? -1 : a > b ? 1 : 0;
		});
	}

	/*
	 * DateFormatSymbols' CalendarDataSink: a calendar's tables, nearest
	 * bundle first, then those of the calendar its aliases point to,
	 * then Gregorian's, each list and table kept whole from the first
	 * that has it, an alias to the same calendar filled in after each
	 * bundle. Returns { arrays, maps } by path within the calendar.
	 */
	function calendarSink(name, type) {
		var arrays = {}, maps = {}, toVisit = null, pairs, current, next,
			cal = type, guard = 0, i;
		var PREFIX = '/LOCALE/calendar/';

		function aliasOf(pathNow, v, out) {
			if (!isAlias(v))
				return 'none';
			var a = v.alias;

			if (a.indexOf(PREFIX) !== 0 || a.length <= PREFIX.length)
				return 'error';
			var lim = a.indexOf('/', PREFIX.length);

			if (lim <= PREFIX.length)
				return 'error';
			var aliasCal = a.slice(PREFIX.length, lim);

			out.rel = a.slice(lim + 1);
			if (current === aliasCal && pathNow !== out.rel)
				return 'same';
			if (current !== aliasCal && pathNow === out.rel) {
				if (aliasCal === 'gregorian')
					return 'gregorian';
				if (next === null || next === aliasCal) {
					next = aliasCal;
					return 'different';
				}
			}
			return 'error';
		}

		function processResource(path, table) {
			var keys = sortedKeys(table), j, made = false, out = {};

			for (j = 0; j < keys.length; j++) {
				var k = keys[j], v = table[k];

				if (/%variant$/.test(k))
					continue;
				if (typeof v === 'string') {
					if (j === 0 && !made) {
						maps[path] = {};
						made = true;
					}
					if (maps[path])
						maps[path][k] = v;
					continue;
				}
				var p = path + '/' + k;

				if (path.indexOf('cyclicNameSets') === 0 &&
				    !/^cyclicNameSets(\/(years|zodiacs|dayParts)(\/(format(\/(abbreviated)?)?)?)?)?$/
					.test(p))
					continue;
				if (arrays[p] || maps[p])
					continue;
				var at = aliasOf(p, v, out);

				if (at === 'same') {
					pairs.push([out.rel, p]);
					continue;
				}
				if (at === 'error')
					throw new Error('calendar alias');
				if (Array.isArray(v))
					arrays[p] = v;
				else if (v && typeof v === 'object')
					processResource(p, v);
			}
		}

		function put(table) {
			var keys = sortedKeys(table), visitNext = null, j, out = {};

			for (j = 0; j < keys.length; j++) {
				var k = keys[j], v = table[k], at = aliasOf(k, v, out);

				if (at === 'gregorian')
					continue;
				if (at === 'different') {
					(visitNext = visitNext || []).push(out.rel);
					continue;
				}
				if (at === 'same') {
					if (!arrays[out.rel] && !maps[out.rel])
						pairs.push([out.rel, k]);
					continue;
				}
				if (at === 'error')
					throw new Error('calendar alias');
				if (toVisit && toVisit.length && toVisit.indexOf(k) < 0 &&
				    k !== 'AmPmMarkersAbbr')
					continue;
				if (k === 'AmPmMarkers' || k === 'AmPmMarkersAbbr' ||
				    k === 'AmPmMarkersNarrow') {
					if (!arrays[k] && Array.isArray(v))
						arrays[k] = v;
				} else if (/^(eras|dayNames|monthNames|quarters|dayPeriod|monthPatterns|cyclicNameSets)$/
					   .test(k) && v && typeof v === 'object') {
					processResource(k, v);
				}
			}
			/* same-calendar aliases, as far as they can be filled */
			var modified;

			do {
				modified = false;
				for (var m = 0; m < pairs.length;) {
					var al = pairs[m][0], to = pairs[m][1], done = false;

					if (arrays[al]) {
						if (!arrays[to])
							arrays[to] = arrays[al];
						done = true;
					} else if (maps[al]) {
						if (!maps[to])
							maps[to] = maps[al];
						done = true;
					}
					if (done) {
						pairs.splice(m, 1);
						modified = true;
					} else {
						m++;
					}
				}
			} while (modified && pairs.length);
			if (visitNext)
				toVisit = visitNext;
		}

		while (cal && guard++ < 10) {
			var its = items(name, ['calendar', cal], name);

			if (!its.length) {
				if (cal !== 'gregorian') {
					cal = 'gregorian';
					toVisit = null;
					continue;
				}
				break;
			}
			current = cal;
			next = null;
			pairs = [];
			for (i = 0; i < its.length; i++) {
				if (isTable(its[i].value))
					put(its[i].value);
			}
			if (cal === 'gregorian')
				break;
			cal = next;
			if (!cal) {
				cal = 'gregorian';
				toVisit = null;
			}
		}
		return { arrays: arrays, maps: maps };
	}

	/*
	 * The names a locale's DateFormatSymbols has for a calendar (ICU's
	 * type name), from what its CalendarDataSink loaded, with ICU's
	 * fallbacks from one form or width to another.
	 */
	function symbols(name, type) {
		var key = name + '/' + type;

		if (SYMBOLS[key])
			return SYMBOLS[key];
		var sink = calendarSink(name, type), s = { type: type }, f, w;
		var list = function (path) {
			return sink.arrays[path];
		};

		/* months */
		var Mfw = list('monthNames/format/wide'),
			Mfa = list('monthNames/format/abbreviated'),
			Msw = list('monthNames/stand-alone/wide') || Mfw,
			Msa = list('monthNames/stand-alone/abbreviated') || Mfa,
			Mfn = list('monthNames/format/narrow'),
			Msn = list('monthNames/stand-alone/narrow');

		if (!Mfn && Msn)
			Mfn = Msn;
		else if (Mfn && !Msn)
			Msn = Mfn;
		else if (!Mfn && !Msn)
			Mfn = Msn = Mfa;
		/* a calendar with no era rules (iso8601) fails to load them,
		 * and the error, left standing, skips the eras and the format
		 * months, and the stand-alone wide ones that fall back to them:
		 * ICU writes those empty */
		if (!ERAS)
			ERAS = JSON.parse(N.pak('dt:eras'));
		var noEras = !ERAS[type];

		if (noEras)
			Mfw = Mfa = Msw = [];
		s.M = { f: { w: Mfw, a: Mfa, n: Mfn }, s: { w: Msw, a: Msa, n: Msn } };

		/* weekdays, Sunday first */
		var Efw = list('dayNames/format/wide'),
			Efa = list('dayNames/format/abbreviated'),
			Efs = list('dayNames/format/short') || Efa,
			Esw = list('dayNames/stand-alone/wide') || Efw,
			Esa = list('dayNames/stand-alone/abbreviated') || Efa,
			Ess = list('dayNames/stand-alone/short') || Efs,
			Efn = list('dayNames/format/narrow'),
			Esn = list('dayNames/stand-alone/narrow');

		if (!Efn && Esn)
			Efn = Esn;
		else if (Efn && !Esn)
			Esn = Efn;
		else if (!Efn && !Esn)
			Efn = Esn = Efa;
		s.E = { f: { w: Efw, a: Efa, s: Efs, n: Efn },
			s: { w: Esw, a: Esa, s: Ess, n: Esn } };

		/* eras: each code the table's, or the bundles' below it */
		var maxEra = noEras ? -1 : ERAS[type].length - 1;
		var eras = function (width) {
			var t = sink.maps['eras/' + width], out = [], i;

			if (!t)
				return undefined;
			for (i = 0; i <= maxEra; i++) {
				var v = t[i];

				if (typeof v !== 'string')
					v = get(name, ['calendar', type, 'eras', width,
						       String(i)]);
				out[i] = typeof v === 'string' ? v : '';
			}
			return out;
		};
		var Ga = noEras ? [] : eras('abbreviated') || [];

		s.G = noEras ? { a: Ga, w: Ga, n: Ga } :
			{ a: Ga, w: eras('wide') || Ga, n: eras('narrow') || Ga };

		/* AM and PM */
		var ap = list('AmPmMarkersAbbr') || ['AM', 'PM'];

		s.ap = { a: ap, n: list('AmPmMarkersNarrow') || ap,
			 w: list('AmPmMarkers') || ap };

		/* day periods: a missing one from the abbreviated form */
		var dp = { f: {}, s: {} }, i;

		for (f in dp) {
			for (w in { a: 1, w: 1, n: 1 }) {
				var t = sink.maps['dayPeriod/' + (f === 'f' ? 'format' :
					'stand-alone') + '/' + (w === 'a' ? 'abbreviated' :
					w === 'w' ? 'wide' : 'narrow')];

				dp[f][w] = PERIODS.map(function (k) {
					return t && typeof t[k] === 'string' ? t[k] : null;
				});
			}
		}
		for (i = 0; i < PERIODS.length; i++) {
			if (dp.f.w[i] === null)
				dp.f.w[i] = dp.f.a[i];
			if (dp.f.n[i] === null)
				dp.f.n[i] = dp.f.a[i];
			if (dp.s.a[i] === null)
				dp.s.a[i] = dp.f.a[i];
			if (dp.s.w[i] === null)
				dp.s.w[i] = dp.s.a[i];
			if (dp.s.n[i] === null)
				dp.s.n[i] = dp.s.a[i];
		}
		s.dp = dp;

		/* a leap month's patterns, and cyclic years' names */
		var leap = function (path) {
			var t = sink.maps['monthPatterns/' + path];

			if (!t)
				return undefined;
			return typeof t.leap === 'string' ? t.leap : null;
		};
		var lp = [leap('format/wide'), leap('format/abbreviated'),
			leap('format/narrow'), leap('stand-alone/wide'),
			leap('stand-alone/abbreviated'), leap('stand-alone/narrow'),
			leap('numeric/all')];

		if (lp.every(function (x) { return x !== undefined; })) {
			lp = lp.map(function (x) { return x || ''; });
			if (!lp[1])
				lp[1] = lp[0];
			if (!lp[2])
				lp[2] = lp[5];
			if (!lp[3])
				lp[3] = lp[0];
			if (!lp[4])
				lp[4] = lp[1];
			s.lp = lp;
		}
		var yn = list('cyclicNameSets/years/format/abbreviated');

		if (yn)
			s.yn = yn;
		SYMBOLS[key] = s;
		return s;
	}

	/* ---- SimpleFormatter ---- */

	/* {0}, {1}... replaced; an apostrophe quotes only before a brace,
	 * and two of them are one */
	function simpleFormat(pattern, args) {
		var out = '', i = 0, n = pattern.length, inQuote = false;

		while (i < n) {
			var c = pattern.charAt(i++);

			if (c === "'") {
				if (i < n && pattern.charAt(i) === "'") {
					i++;
				} else if (inQuote) {
					inQuote = false;
					continue;
				} else if (pattern.charAt(i) === '{' ||
					   pattern.charAt(i) === '}') {
					c = pattern.charAt(i++);
					inQuote = true;
				}
			} else if (!inQuote && c === '{') {
				var m = /^(\d+)\}/.exec(pattern.slice(i));

				if (m) {
					out += args[+m[1]];
					i += m[0].length;
					continue;
				}
			}
			out += c;
		}
		return out;
	}

	/* ---- DateTimePatternGenerator ---- */

	var FIELD_COUNT = 16, ERA = 0, YEAR = 1, MONTH = 3, WEEKDAY = 6,
		DAYPERIOD = 10, HOUR = 11, MINUTE = 12, SECOND = 13,
		FRACTION = 14;
	var NUMERIC = 0x100, NARROW = -0x101, SHORTER = -0x102, SHORT = -0x103,
		LONG = -0x104, DELTA = 0x10;
	var EXTRA_FIELD = 0x10000, MISSING_FIELD = 0x1000;
	var FRACTIONAL_MASK = 1 << FRACTION,
		SECOND_AND_FRACTIONAL_MASK = (1 << SECOND) | (1 << FRACTION);
	var FIX_FRACTIONAL_SECONDS = 1, SKELETON_USES_CAP_J = 2;
	var MATCH_HOUR_FIELD_LENGTH = 1 << 11;

	/* dtTypes: pattern letter, field, type, shortest length */
	var TYPES = [
		['G', 0, SHORT, 1], ['G', 0, LONG, 4], ['G', 0, NARROW, 5],
		['y', 1, NUMERIC, 1], ['Y', 1, NUMERIC + DELTA, 1],
		['u', 1, NUMERIC + 2 * DELTA, 1], ['r', 1, NUMERIC + 3 * DELTA, 1],
		['U', 1, SHORT, 1], ['U', 1, LONG, 4], ['U', 1, NARROW, 5],
		['Q', 2, NUMERIC, 1], ['Q', 2, SHORT, 3], ['Q', 2, LONG, 4],
		['Q', 2, NARROW, 5], ['q', 2, NUMERIC + DELTA, 1],
		['q', 2, SHORT - DELTA, 3], ['q', 2, LONG - DELTA, 4],
		['q', 2, NARROW - DELTA, 5],
		['M', 3, NUMERIC, 1], ['M', 3, SHORT, 3], ['M', 3, LONG, 4],
		['M', 3, NARROW, 5], ['L', 3, NUMERIC + DELTA, 1],
		['L', 3, SHORT - DELTA, 3], ['L', 3, LONG - DELTA, 4],
		['L', 3, NARROW - DELTA, 5], ['l', 3, NUMERIC + DELTA, 1],
		['w', 4, NUMERIC, 1],
		['W', 5, NUMERIC, 1],
		['E', 6, SHORT, 1], ['E', 6, LONG, 4], ['E', 6, NARROW, 5],
		['E', 6, SHORTER, 6], ['c', 6, NUMERIC + 2 * DELTA, 1],
		['c', 6, SHORT - 2 * DELTA, 3], ['c', 6, LONG - 2 * DELTA, 4],
		['c', 6, NARROW - 2 * DELTA, 5], ['c', 6, SHORTER - 2 * DELTA, 6],
		['e', 6, NUMERIC + DELTA, 1], ['e', 6, SHORT - DELTA, 3],
		['e', 6, LONG - DELTA, 4], ['e', 6, NARROW - DELTA, 5],
		['e', 6, SHORTER - DELTA, 6],
		['d', 9, NUMERIC, 1], ['g', 9, NUMERIC + DELTA, 1],
		['D', 7, NUMERIC, 1],
		['F', 8, NUMERIC, 1],
		['a', 10, SHORT, 1], ['a', 10, LONG, 4], ['a', 10, NARROW, 5],
		['b', 10, SHORT - DELTA, 1], ['b', 10, LONG - DELTA, 4],
		['b', 10, NARROW - DELTA, 5],
		['B', 10, SHORT - 3 * DELTA, 1], ['B', 10, LONG - 3 * DELTA, 4],
		['B', 10, NARROW - 3 * DELTA, 5],
		['H', 11, NUMERIC + 10 * DELTA, 1], ['k', 11, NUMERIC + 11 * DELTA, 1],
		['h', 11, NUMERIC, 1], ['K', 11, NUMERIC + DELTA, 1],
		['J', 11, NUMERIC + 5 * DELTA, 1], ['j', 11, NUMERIC + 6 * DELTA, 1],
		['C', 11, NUMERIC + 7 * DELTA, 1],
		['m', 12, NUMERIC, 1],
		['s', 13, NUMERIC, 1], ['A', 13, NUMERIC + DELTA, 1],
		['S', 14, NUMERIC, 1],
		['v', 15, SHORT - 2 * DELTA, 1], ['v', 15, LONG - 2 * DELTA, 4],
		['z', 15, SHORT, 1], ['z', 15, LONG, 4],
		['Z', 15, NARROW - DELTA, 1], ['Z', 15, LONG - DELTA, 4],
		['Z', 15, SHORT - DELTA, 5], ['O', 15, SHORT - DELTA, 1],
		['O', 15, LONG - DELTA, 4], ['V', 15, SHORT - DELTA, 1],
		['V', 15, LONG - DELTA, 2], ['V', 15, LONG - 1 - DELTA, 3],
		['V', 15, LONG - 2 - DELTA, 4], ['X', 15, NARROW - DELTA, 1],
		['X', 15, SHORT - DELTA, 2], ['X', 15, LONG - DELTA, 4],
		['x', 15, NARROW - DELTA, 1], ['x', 15, SHORT - DELTA, 2],
		['x', 15, LONG - DELTA, 4]
	];
	var CANONICAL = 'GyQMwWEDFdaHmsSv';
	var APPEND_DEFAULT = '{0} ├{2}: {1}┤';

	function isLetter(c) {
		return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
	}

	/* FormatParser: runs of one letter, and every other character
	 * alone; no more than ICU's 50 (MAX_DT_TOKEN), the rest of a longer
	 * pattern lost as in ICU */
	function tokens(pattern) {
		var out = [], i = 0, n = pattern.length;

		while (i < n && out.length < 50) {
			var c = pattern.charAt(i), j = i + 1;

			if (isLetter(c)) {
				while (j < n && pattern.charAt(j) === c)
					j++;
			}
			out.push(pattern.slice(i, j));
			i = j;
		}
		return out;
	}

	/* the row of TYPES a run of letters is */
	function canonicalIndex(s, strict) {
		var ch = s.charAt(0), len = s.length, i, best = -1;

		if (!len)
			return -1;
		for (i = 1; i < len; i++) {
			if (s.charAt(i) !== ch)
				return -1;
		}
		for (i = 0; i < TYPES.length; i++) {
			if (TYPES[i][0] !== ch)
				continue;
			best = i;
			if (!TYPES[i + 1] || TYPES[i + 1][0] !== ch)
				return i;
			if (TYPES[i + 1][3] <= len)
				continue;
			return i;
		}
		return strict ? -1 : best;
	}

	/* a quoted literal from items[i] on: the text, and where it ends */
	function quoteLiteral(items, i) {
		var q = '';

		if (items[i].charAt(0) === "'") {
			q += items[i];
			i++;
		}
		while (i < items.length) {
			if (items[i].charAt(0) === "'") {
				if (i + 1 < items.length &&
				    items[i + 1].charAt(0) === "'") {
					q += items[i++];
					q += items[i++];
					continue;
				}
				q += items[i];
				break;
			}
			q += items[i];
			i++;
		}
		return { text: q, end: i };
	}

	/* ICU tests items[i], with i the character's index in the field,
	 * not the field's; kept as it is */
	function isSeparator(field, items) {
		var i;

		for (i = 0; i < field.length; i++) {
			var c = field.charAt(i);

			if ("'\\ :\",-".indexOf(c) >= 0 ||
			    (items[i] && items[i].charAt(0) === '.'))
				continue;
			return false;
		}
		return true;
	}

	/* PtnSkeleton: the fields as asked (original), as their base
	 * letters (baseOriginal), and their types */
	function Skeleton() {
		this.ch = [];
		this.len = [];
		this.bch = [];
		this.blen = [];
		this.type = [];
		this.added = false;
		for (var i = 0; i < FIELD_COUNT; i++) {
			this.ch[i] = this.bch[i] = '';
			this.len[i] = this.blen[i] = this.type[i] = 0;
		}
	}
	Skeleton.prototype.original = function () {
		var s = '', i;

		for (i = 0; i < FIELD_COUNT; i++)
			s += rep(this.ch[i], this.len[i]);
		return s;
	};
	Skeleton.prototype.base = function () {
		var s = '', i;

		for (i = 0; i < FIELD_COUNT; i++)
			s += rep(this.bch[i], this.blen[i]);
		return s;
	};
	Skeleton.prototype.firstChar = function () {
		for (var i = 0; i < FIELD_COUNT; i++) {
			if (this.blen[i])
				return this.bch[i];
		}
		return '';
	};
	Skeleton.prototype.copy = function () {
		var s = new Skeleton();

		s.ch = this.ch.slice();
		s.len = this.len.slice();
		s.bch = this.bch.slice();
		s.blen = this.blen.slice();
		s.type = this.type.slice();
		s.added = this.added;
		return s;
	};
	/* the skeleton staticGetSkeleton gives, without an 'a' it added */
	Skeleton.prototype.skeleton = function () {
		var s = this.original(), pos;

		if (this.added && (pos = s.indexOf('a')) >= 0)
			s = s.slice(0, pos) + s.slice(pos + 1);
		return s;
	};

	function rep(c, n) {
		var s = '';

		while (n-- > 0)
			s += c;
		return s;
	}

	function firstRow(field) {
		for (var i = 0; i < TYPES.length; i++) {
			if (TYPES[i][1] === field)
				return TYPES[i];
		}
		return null;
	}

	/* DateTimeMatcher::set */
	function skeletonOf(pattern) {
		var s = new Skeleton(), items = tokens(pattern), i, row;

		for (i = 0; i < items.length; i++) {
			var value = items[i];

			if (value.charAt(0) === "'") {
				i = quoteLiteral(items, i).end;
				continue;
			}
			var ci = canonicalIndex(value, false);

			if (ci < 0)
				continue;
			row = TYPES[ci];
			var f = row[1];

			s.ch[f] = value.charAt(0);
			s.len[f] = value.length;
			s.bch[f] = row[0];
			s.blen[f] = row[3];
			s.type[f] = row[2] > 0 ? row[2] + value.length : row[2];
		}
		/* minutes and a fraction but no seconds: seconds too */
		if (s.len[MINUTE] && s.len[FRACTION] && !s.len[SECOND]) {
			row = firstRow(SECOND);
			s.ch[SECOND] = s.bch[SECOND] = row[0];
			s.len[SECOND] = s.blen[SECOND] = row[3];
			s.type[SECOND] = row[2] > 0 ? row[2] + 1 : row[2];
		}
		/* a twelve hour clock brings its AM/PM; a 24 hour one drops
		 * any day period */
		if (s.len[HOUR]) {
			if (s.ch[HOUR] === 'h' || s.ch[HOUR] === 'K') {
				if (!s.len[DAYPERIOD]) {
					row = firstRow(DAYPERIOD);
					s.ch[DAYPERIOD] = s.bch[DAYPERIOD] = row[0];
					s.len[DAYPERIOD] = s.blen[DAYPERIOD] = row[3];
					s.type[DAYPERIOD] = row[2];
					s.added = true;
				}
			} else {
				s.ch[DAYPERIOD] = s.bch[DAYPERIOD] = '';
				s.len[DAYPERIOD] = s.blen[DAYPERIOD] = 0;
				s.type[DAYPERIOD] = 0;
			}
		}
		return s;
	}

	function sameOriginal(a, b) {
		for (var i = 0; i < FIELD_COUNT; i++) {
			if (a.ch[i] !== b.ch[i] || a.len[i] !== b.len[i])
				return false;
		}
		return true;
	}

	function sameTypes(a, b) {
		for (var i = 0; i < FIELD_COUNT; i++) {
			if (a.type[i] !== b.type[i])
				return false;
		}
		return true;
	}

	/* DateTimeMatcher::getDistance */
	function distance(req, other, includeMask, info) {
		var result = 0, i;

		info.missing = 0;
		info.extra = 0;
		for (i = 0; i < FIELD_COUNT; i++) {
			var my = (includeMask & (1 << i)) ? req.type[i] : 0,
				ot = other.type[i];

			if (my === ot)
				continue;
			if (my === 0) {
				result += EXTRA_FIELD;
				info.extra |= 1 << i;
			} else if (ot === 0) {
				result += MISSING_FIELD;
				info.missing |= 1 << i;
			} else {
				result += Math.abs(my - ot);
			}
		}
		return result;
	}

	function bootIndex(c) {
		if (c >= 'A' && c <= 'Z')
			return c.charCodeAt(0) - 65;
		if (c >= 'a' && c <= 'z')
			return 26 + c.charCodeAt(0) - 97;
		return -1;
	}

	/* PatternMap: a list per base letter, in the order added */
	function PatternMap() {
		this.boot = [];
		for (var i = 0; i < 52; i++)
			this.boot[i] = [];
	}
	PatternMap.prototype.fromBase = function (base) {
		var b = bootIndex(base.charAt(0)), l = b < 0 ? [] : this.boot[b], i;

		for (i = 0; i < l.length; i++) {
			if (l[i].base === base)
				return l[i];
		}
		return null;
	};
	PatternMap.prototype.fromSkeleton = function (skel) {
		var b = bootIndex(skel.firstChar()), l = b < 0 ? [] : this.boot[b], i;

		for (i = 0; i < l.length; i++) {
			if (sameOriginal(l[i].skel, skel))
				return l[i];
		}
		return null;
	};
	PatternMap.prototype.add = function (base, skel, pattern, specified) {
		var b = bootIndex(base.charAt(0)), l, i;

		if (b < 0)
			return;
		l = this.boot[b];
		for (i = 0; i < l.length; i++) {
			if (l[i].base === base && sameTypes(l[i].skel, skel)) {
				l[i].pattern = pattern;
				l[i].specified = specified;
				return;
			}
		}
		l.push({ base: base, skel: skel.copy(), pattern: pattern,
			 specified: specified });
	};

	/*
	 * A generator for a locale. loc: { name: the bundle, cal: the
	 * calendar ICU's data says (calendar/default) or the locale asks
	 * for, calType: the calendar the locale's Calendar is, hour: the
	 * hour symbol it prefers, decimal: its decimal separator }.
	 * noStd leaves out the date and time styles' patterns, as
	 * createInstanceNoStdPat does.
	 */
	function Generator(loc, noStd) {
		var self = this, i;

		this.map = new PatternMap();
		this.decimal = loc.decimal || '.';
		this.hourChar = loc.hour || 'H';
		this.appendItems = [];
		this.fieldNames = [];
		this.keys = {};

		for (i = 0; i < CANONICAL.length; i++)
			this.addPattern(CANONICAL.charAt(i), null, false);
		var cal = ['calendar', loc.cal];

		if (!noStd) {
			var dtp = get(loc.name, cal.concat(['DateTimePatterns']));

			for (i = 0; i < 8; i++) {
				var p = dtp[i];

				this.addPattern(Array.isArray(p) ? p[0] : p, null, false);
			}
		}
		/* append items and field names, the nearest bundle's first */
		var ai = get(loc.name, cal.concat(['appendItems'])) || {};
		var APPEND = ['Era', 'Year', 'Quarter', 'Month', 'Week', '*',
			'Day-Of-Week', '*', '*', 'Day', '*', 'Hour', 'Minute',
			'Second', '*', 'Timezone'];
		var NAMES = ['era', 'year', 'quarter', 'month', 'week',
			'weekOfMonth', 'weekday', 'dayOfYear', 'weekdayOfMonth', 'day',
			'dayperiod', 'hour', 'minute', 'second', '*', 'zone'];

		for (i = 0; i < FIELD_COUNT; i++) {
			var a = ai[APPEND[i]];

			this.appendItems[i] = typeof a === 'string' && a ? a :
				APPEND_DEFAULT;
			var dn = NAMES[i] === '*' ? undefined :
				get(loc.name, ['fields', NAMES[i], 'dn']);

			this.fieldNames[i] = typeof dn === 'string' && dn ? dn :
				'F' + (i < 10 ? i : '1' + (i - 10));
		}
		/* availableFormats, nearest bundle first, each key once */
		items(loc.name, cal.concat(['availableFormats']), loc.name)
			.forEach(function (it) {
				Object.keys(it.value).sort().forEach(function (k) {
					var v = it.value[k];

					if (self.keys[k] || typeof v !== 'string')
						return;
					self.keys[k] = 1;
					self.addPattern(v, k, true);
				});
			});
		/* the patterns that put a date and a time together */
		var calType = loc.calType || 'gregorian', dt = null;

		if (calType !== 'gregorian')
			dt = get(loc.name, ['calendar', calType,
					    'DateTimePatterns%atTime']);
		if (!dt)
			dt = get(loc.name, ['calendar', 'gregorian',
					    'DateTimePatterns%atTime']);
		if (dt && dt.length >= 4) {
			this.dateTime = dt.slice(0, 4);
		} else {
			var std = calType !== 'gregorian' ?
				get(loc.name, ['calendar', calType,
					       'DateTimePatterns']) : null;

			if (!std)
				std = get(loc.name, ['calendar', 'gregorian',
						     'DateTimePatterns']);
			this.dateTime = std.slice(9, 13);
		}
		this.dateTime = this.dateTime.map(function (p) {
			return Array.isArray(p) ? p[0] : p;
		});
	}

	/* addPatternWithOptionalSkeleton: an availableFormats pattern
	 * (skelStr given) overrides what the styles' patterns gave, but not
	 * another availableFormats one */
	Generator.prototype.addPattern = function (pattern, skelStr, override) {
		var skel = skeletonOf(skelStr !== null ? skelStr : pattern);
		var base = skel.base(), dup = this.map.fromBase(base);

		if (dup && (!dup.specified || (skelStr !== null && !override)) &&
		    !override)
			return;
		dup = this.map.fromSkeleton(skel);
		if (dup && (!override || (skelStr !== null && dup.specified)))
			return;
		this.map.add(base, skel, pattern, skelStr !== null);
	};

	/* getBestRaw: the nearest pattern, walking the map in ICU's order */
	Generator.prototype.bestRaw = function (req, includeMask, info) {
		var best = null, bestDistance = 0x7fffffff, bestMissing = -1,
			tmp = { missing: 0, extra: 0 }, b, i, done = false;

		for (b = 0; b < 52 && !done; b++) {
			var l = this.map.boot[b];

			for (i = 0; i < l.length; i++) {
				var d = distance(req, l[i].skel, includeMask, tmp);

				if (d < bestDistance || (d === bestDistance &&
				    bestMissing < tmp.missing)) {
					bestDistance = d;
					bestMissing = tmp.missing;
					best = this.map.fromSkeleton(l[i].skel);
					info.missing = tmp.missing;
					info.extra = tmp.extra;
					if (d === 0) {
						done = true;
						break;
					}
				}
			}
		}
		return best;
	};

	/* adjustFieldTypes: the pattern's fields made what was asked */
	Generator.prototype.adjust = function (pattern, req, specified, flags,
					      options) {
		var out = '', items = tokens(pattern), i;

		for (i = 0; i < items.length; i++) {
			var field = items[i];

			if (field.charAt(0) === "'") {
				var q = quoteLiteral(items, i);

				out += q.text;
				i = q.end;
				continue;
			}
			if (isSeparator(field, items)) {
				out += field;
				continue;
			}
			var ci = canonicalIndex(field, false);

			if (ci < 0) {
				out += field;
				continue;
			}
			var row = TYPES[ci], tv = row[1];

			if ((flags & FIX_FRACTIONAL_SECONDS) && tv === SECOND) {
				field += this.decimal + rep(req.ch[FRACTION],
							    req.len[FRACTION]);
			} else if (req.type[tv] !== 0) {
				var rc = req.ch[tv], rl = req.len[tv];

				if (rc === 'E' && rl < 3)
					rl = 3;
				var adj = rl;

				if ((tv === HOUR && !(options & MATCH_HOUR_FIELD_LENGTH)) ||
				    tv === MINUTE || tv === SECOND) {
					adj = field.length;
				} else if (specified && rc !== 'c' && rc !== 'e') {
					var sl = specified.len[tv], pn = row[2] > 0,
						rn = req.type[tv] > 0;

					if (sl === rl || (pn && !rn) || (rn && !pn))
						adj = field.length;
				}
				var c = (tv !== HOUR && tv !== MONTH && tv !== WEEKDAY &&
					 (tv !== YEAR || rc === 'Y')) ? rc :
					field.charAt(0);

				if (c === 'E' && adj < 3)
					c = 'e';
				if (tv === HOUR && this.hourChar) {
					var hc = this.hourChar;

					if ((flags & SKELETON_USES_CAP_J) || rc === hc)
						c = hc;
					else if (rc === 'h' && hc === 'K')
						c = 'K';
					else if (rc === 'H' && hc === 'k')
						c = 'k';
					else if (rc === 'k' && hc === 'H')
						c = 'H';
					else if (rc === 'K' && hc === 'h')
						c = 'h';
				}
				field = rep(c, adj);
			}
			out += field;
		}
		return out;
	};

	Generator.prototype.bestAppending = function (req, missingFields, flags,
						      options) {
		var info = { missing: 0, extra: 0 }, result, last = 0, best,
			tinfo;

		if (!missingFields)
			return '';
		best = this.bestRaw(req, missingFields, info);
		result = this.adjust(best.pattern, req, best.specified ?
				     best.skel : null, flags, options);
		while (info.missing) {
			if (last === info.missing)
				break;
			if ((info.missing & SECOND_AND_FRACTIONAL_MASK) ===
			    FRACTIONAL_MASK && (missingFields &
			    SECOND_AND_FRACTIONAL_MASK) ===
			    SECOND_AND_FRACTIONAL_MASK) {
				result = this.adjust(result, req, best.specified ?
					best.skel : null, flags | FIX_FRACTIONAL_SECONDS,
					options);
				info.missing &= ~FRACTIONAL_MASK;
				continue;
			}
			var start = info.missing;

			tinfo = { missing: 0, extra: 0 };
			best = this.bestRaw(req, info.missing, tinfo);
			info.missing = tinfo.missing;
			info.extra = tinfo.extra;
			var temp = this.adjust(best.pattern, req, best.specified ?
					       best.skel : null, flags, options);
			var top = topBit(start & ~info.missing);

			if (this.appendItems[top])
				result = simpleFormat(this.appendItems[top],
					[result, temp, "'" + this.fieldNames[top] + "'"]);
			last = info.missing;
		}
		return result;
	};

	function topBit(mask) {
		var i = 0;

		if (!mask)
			return 0;
		while (mask) {
			mask >>>= 1;
			i++;
		}
		return i - 1 > 15 ? 15 : i - 1;
	}

	/* mapSkeletonMetacharacters, for j and J (V8 passes no C) */
	Generator.prototype.mapMeta = function (form, state) {
		var out = '', i, n = form.length, inQuote = false;

		for (i = 0; i < n; i++) {
			var c = form.charAt(i);

			if (c === "'") {
				inQuote = !inQuote;
			} else if (!inQuote) {
				if (c === 'j' || c === 'C') {
					var extra = 0;

					while (i + 1 < n && form.charAt(i + 1) === c) {
						extra++;
						i++;
					}
					var hourLen = 1 + (extra & 1);
					var dpLen = extra < 2 ? 1 : 3 + (extra >> 1);
					var hc = c === 'j' ? this.hourChar : 'h';

					if (hc === 'H' || hc === 'k')
						dpLen = 0;
					out += rep('a', dpLen) + rep(hc, hourLen);
				} else if (c === 'J') {
					out += 'H';
					state.flags |= SKELETON_USES_CAP_J;
				} else {
					out += c;
				}
			}
		}
		return out;
	};

	Generator.prototype.bestPattern = function (form, options) {
		var state = { flags: 0 }, info = { missing: 0, extra: 0 };
		var req = skeletonOf(this.mapMeta(form, state)), best, dp, tp;
		var DATE_MASK = (1 << DAYPERIOD) - 1,
			TIME_MASK = (1 << FIELD_COUNT) - 1 - DATE_MASK;

		options = options || 0;
		best = this.bestRaw(req, -1, info);
		if (!info.missing && !info.extra)
			return this.adjust(best.pattern, req, best.specified ?
					   best.skel : null, state.flags, options);
		var needed = 0, i;

		for (i = 0; i < FIELD_COUNT; i++) {
			if (req.type[i])
				needed |= 1 << i;
		}
		dp = this.bestAppending(req, needed & DATE_MASK, state.flags,
					options);
		tp = this.bestAppending(req, needed & TIME_MASK, state.flags,
					options);
		if (!dp)
			return tp;
		if (!tp)
			return dp;
		/* the style whose glue joins them, by the base skeleton's
		 * month and weekday */
		var style = 3;

		if (req.blen[MONTH] === 4)
			style = req.blen[WEEKDAY] > 0 ? 0 : 1;
		else if (req.blen[MONTH] === 3)
			style = 2;
		return simpleFormat(this.dateTime[style], [tp, dp]);
	};

	/* getDefaultHourCycle */
	Generator.prototype.hourCycle = function () {
		return { K: 'h11', h: 'h12', H: 'h23', k: 'h24' }[this.hourChar];
	};

	return {
		get: get,
		items: items,
		chain: chain,
		opened: DT.opened,
		defaultCalendar: DT.defaultCalendar,
		tree: tree,
		symbols: symbols,
		simpleFormat: simpleFormat,
		Generator: Generator,
		skeletonOf: skeletonOf,
		staticSkeleton: function (pattern) {
			return skeletonOf(pattern).skeleton();
		},
		MATCH_HOUR_FIELD_LENGTH: MATCH_HOUR_FIELD_LENGTH
	};
};

if (typeof module !== 'undefined')
	module.exports = __vitaIntlPattern;
