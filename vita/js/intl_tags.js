/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Intl.Locale, and the canonical form of every locale tag (VitaSurf).
 *
 * A tag is read as UTS #35's unicode_locale_id, checked as ECMA-402's
 * IsStructurallyValidLanguageTag checks it, and put in canonical form
 * with CLDR's aliases the way ICU's AliasReplacer does: iw is he, sh is
 * sr-Latn, SU is the region the language is most likely spoken in,
 * en-US-posix is en-US-u-va-posix, and keywords are sorted with their
 * values' aliases replaced. Every Intl constructor's locales go through
 * it (vita/js/intl_core.js). Intl.Locale adds its options, maximize and
 * minimize from CLDR's likely subtags, and the locale information
 * (week, hour cycles, calendars, collations, numbering systems, time
 * zones, text direction) from resources/intl.pak.
 *
 * The prelude's Intl.Locale took the first subtags and dropped the rest,
 * and lacked the locale information, so Home Assistant loaded FormatJS's.
 *
 * Runs under Node too, held against ICU with the cases
 * scripts/gen-intl-tags-tests.mjs makes: __vitaIntlTags(W, N, C, X).
 */
var __vitaIntlTags = function (W, N, C, X) {
	'use strict';

	var Intl = W.Intl, DATA = {};

	function data(name) {
		return DATA[name] || (DATA[name] = JSON.parse(N.pak(name)));
	}

	function own(o, k) {
		return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] :
			undefined;
	}

	/* ---- reading a tag ---- */

	var ALPHANUM = /^[a-z\d]+$/;

	function isLanguage(s) {
		return /^([a-z]{2,3}|[a-z]{5,8})$/.test(s);
	}

	function isScript(s) {
		return /^[a-z]{4}$/.test(s);
	}

	function isRegion(s) {
		return /^([a-z]{2}|\d{3})$/.test(s);
	}

	function isVariant(s) {
		return /^([a-z\d]{5,8}|\d[a-z\d]{3})$/.test(s);
	}

	function invalid() {
		throw new RangeError('Incorrect locale information provided');
	}

	/* a language id from subtags p at i: { lang, script, region,
	 * variants }, and where it stopped */
	function readId(p, i, out) {
		if (i >= p.length || !isLanguage(p[i]))
			invalid();
		out.lang = p[i++];
		if (i < p.length && isScript(p[i]))
			out.script = p[i++];
		if (i < p.length && isRegion(p[i]))
			out.region = p[i++];
		out.variants = [];
		while (i < p.length && isVariant(p[i])) {
			if (out.variants.indexOf(p[i]) >= 0)
				invalid();
			out.variants.push(p[i++]);
		}
		return i;
	}

	/*
	 * Parse a unicode_locale_id, lower case throughout: { lang, script,
	 * region, variants, u: { attrs, kw: [[key, value]...] }, t: { lang,
	 * fields }, other: { singleton: text }, x }. Throws a RangeError for
	 * a tag that is not structurally valid.
	 */
	function parse(tag) {
		var p = String(tag).toLowerCase().split('-'), i, t = {}, seen = {};

		for (i = 0; i < p.length; i++) {
			if (!p[i] || !ALPHANUM.test(p[i]) || p[i].length > 8)
				invalid();
		}
		i = readId(p, 0, t);
		t.other = {};
		while (i < p.length) {
			var s = p[i++];

			if (s.length !== 1)
				invalid();
			if (s === 'x') {
				if (i >= p.length)
					invalid();
				t.x = p.slice(i).join('-');
				break;
			}
			if (seen[s])
				invalid();
			seen[s] = true;
			if (s === 'u') {
				var u = { attrs: [], kw: [] }, any = false;

				while (i < p.length && p[i].length >= 3) {
					u.attrs.push(p[i++]);
					any = true;
				}
				while (i < p.length && p[i].length === 2) {
					if (!/^[a-z\d][a-z]$/.test(p[i]))
						invalid();
					var key = p[i++], vals = [];

					while (i < p.length && p[i].length >= 3)
						vals.push(p[i++]);
					u.kw.push([key, vals.join('-')]);
					any = true;
				}
				if (!any)
					invalid();
				t.u = u;
			} else if (s === 't') {
				var tx = { lang: null, fields: [] };

				if (i < p.length && isLanguage(p[i])) {
					tx.lang = {};
					i = readId(p, i, tx.lang);
				}
				while (i < p.length && /^[a-z]\d$/.test(p[i])) {
					var tk = p[i++], tv = [];

					while (i < p.length && p[i].length >= 3)
						tv.push(p[i++]);
					if (!tv.length)
						invalid();
					tx.fields.push([tk, tv.join('-')]);
				}
				if (!tx.lang && !tx.fields.length)
					invalid();
				t.t = tx;
			} else {
				var start = i;

				while (i < p.length && p[i].length >= 2)
					i++;
				if (i === start)
					invalid();
				t.other[s] = p.slice(start, i).join('-');
			}
		}
		return t;
	}

	/* ---- canonical form ---- */

	var RULES = null;

	/* the language aliases, as rules: by language (und for any), with
	 * the region and variants they also match */
	function rules() {
		var l, k, p, r, list;

		if (RULES)
			return RULES;
		RULES = {};
		l = data('aliases').l;
		for (k in l) {
			p = k.toLowerCase().split('-');
			r = { lang: p[0], region: null, variants: [], to: l[k] };
			list = p.slice(1);
			if (list.length && isScript(list[0]))
				list.shift();
			if (list.length && isRegion(list[0]))
				r.region = list.shift();
			r.variants = list;
			(RULES[r.lang] || (RULES[r.lang] = [])).push(r);
		}
		/* the more a rule asks of a tag, the sooner it is tried */
		for (k in RULES) {
			RULES[k].sort(function (a, b) {
				return (b.variants.length * 2 + (b.region ? 1 : 0)) -
					(a.variants.length * 2 + (a.region ? 1 : 0));
			});
		}
		return RULES;
	}

	function matchRule(t, list) {
		var i, j, r;

		for (i = 0; list && i < list.length; i++) {
			r = list[i];
			if (r.region && r.region !== t.region)
				continue;
			for (j = 0; j < r.variants.length; j++) {
				if (t.variants.indexOf(r.variants[j]) < 0)
					break;
			}
			if (j === r.variants.length)
				return r;
		}
		return null;
	}

	function applyLanguageRule(t, r) {
		var to = {}, i, before = idString(t);

		readId(r.to.toLowerCase().split('-'), 0, to);
		if (to.lang !== 'und')
			t.lang = to.lang;
		if (to.script)
			t.script = to.script;
		if (to.region)
			t.region = to.region;
		else if (r.region)
			t.region = undefined;
		for (i = 0; i < r.variants.length; i++)
			t.variants.splice(t.variants.indexOf(r.variants[i]), 1);
		for (i = 0; i < to.variants.length; i++) {
			if (t.variants.indexOf(to.variants[i]) < 0)
				t.variants.push(to.variants[i]);
		}
		return idString(t) !== before;
	}

	function idString(t) {
		return [t.lang, t.script, t.region].concat(t.variants)
			.filter(Boolean).join('-');
	}

	/* ICU's AliasReplacer on a language id, till nothing changes */
	function replaceAliases(t) {
		var a = data('aliases'), all = rules(), n, r, changed, i, rep;

		for (n = 0; n < 10; n++) {
			changed = false;
			r = matchRule(t, all[t.lang]) || matchRule(t, all.und);
			if (r && applyLanguageRule(t, r))
				continue;
			rep = t.region && own(a.r, t.region.toUpperCase());
			if (rep) {
				var list = rep.toLowerCase().split(' '), pick = list[0];

				if (list.length > 1) {
					var m = likely({ lang: t.lang, script: t.script,
						variants: [] });

					if (m && m.region && list.indexOf(m.region) >= 0)
						pick = m.region;
				}
				if (pick !== t.region) {
					t.region = pick;
					continue;
				}
			}
			rep = t.script && own(a.s, titleCase(t.script));
			if (rep && rep.toLowerCase() !== t.script) {
				t.script = rep.toLowerCase();
				continue;
			}
			for (i = 0; i < t.variants.length; i++) {
				rep = own(a.v, t.variants[i]);
				if (rep && rep.toLowerCase() !== t.variants[i]) {
					rep = rep.toLowerCase();
					if (t.variants.indexOf(rep) >= 0)
						t.variants.splice(i, 1);
					else
						t.variants[i] = rep;
					changed = true;
					break;
				}
			}
			if (!changed)
				break;
		}
	}

	function titleCase(s) {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}

	function keywordValue(key, value, map) {
		var a = own(map, key), v;

		if (key === 'rg' || key === 'sd') {
			v = own(data('aliases').d, value);
			if (!v)
				return value;
			v = v.split(' ')[0].toLowerCase();
			/* a subdivision that became a region: the whole of it */
			return isRegion(v) ? v + 'zzzz' : v;
		}
		v = a && own(a, value);
		return v !== undefined ? v : value;
	}

	/* a -u- keyword's value: yes is true for every key, as ICU has it */
	function uValue(key, value) {
		var v = keywordValue(key, value, data('aliases').u);

		return v === 'yes' ? 'true' : v;
	}

	/* the tag's text in canonical form */
	function format(t) {
		var out = [t.lang], keys, i, kw, seen = {};

		if (t.script)
			out.push(titleCase(t.script));
		if (t.region)
			out.push(t.region.toUpperCase());
		out = out.concat(t.variants.slice().sort());
		keys = Object.keys(t.other);
		if (t.t)
			keys.push('t');
		if (t.u)
			keys.push('u');
		keys.sort();
		for (i = 0; i < keys.length; i++) {
			if (keys[i] === 'u') {
				var attrs = [];

				t.u.attrs.forEach(function (a) {
					if (attrs.indexOf(a) < 0)
						attrs.push(a);
				});
				kw = [];
				t.u.kw.forEach(function (k) {
					if (seen[k[0]])
						return;
					seen[k[0]] = true;
					kw.push(k);
				});
				kw.sort(function (a, b) {
					return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
				});
				out.push('u');
				out = out.concat(attrs.sort());
				kw.forEach(function (k) {
					out.push(k[0]);
					if (k[1] && k[1] !== 'true')
						out.push(k[1]);
				});
			} else if (keys[i] === 't') {
				out.push('t');
				if (t.t.lang)
					out.push(idString(t.t.lang).toLowerCase());
				t.t.fields.slice().sort(function (a, b) {
					return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
				}).forEach(function (f) {
					out.push(f[0], f[1]);
				});
			} else {
				out.push(keys[i], t.other[keys[i]]);
			}
		}
		if (t.x)
			out.push('x', t.x);
		return out.join('-');
	}

	/* ECMA-402 CanonicalizeUnicodeLocaleId, on a parsed tag */
	function canonical(t) {
		var a = data('aliases'), i, va;

		replaceAliases(t);
		/* en-US-posix is en-US-u-va-posix */
		i = t.variants.indexOf('posix');
		if (i >= 0) {
			t.variants.splice(i, 1);
			if (!t.u)
				t.u = { attrs: [], kw: [] };
			va = t.u.kw.some(function (k) { return k[0] === 'va'; });
			if (!va)
				t.u.kw.push(['va', 'posix']);
		}
		if (t.u) {
			t.u.kw = t.u.kw.map(function (k) {
				var v = uValue(k[0], k[1]);

				return [k[0], v === 'true' ? '' : v];
			});
		}
		if (t.t) {
			if (t.t.lang)
				replaceAliases(t.t.lang);
			t.t.fields = t.t.fields.map(function (f) {
				return [f[0], keywordValue(f[0], f[1], a.t)];
			});
		}
		return t;
	}

	/* a page canonicalizes the same few tags again and again */
	var CANONICAL = new Map();

	function canonicalize(tag) {
		var r = CANONICAL.get(tag);

		if (r === undefined) {
			r = format(canonical(parse(tag)));
			if (CANONICAL.size >= 64)
				CANONICAL.clear();
			CANONICAL.set(tag, r);
		}
		return r;
	}

	/* ---- likely subtags ---- */

	/* UTS #35 Add Likely Subtags on a language id; null if CLDR does
	 * not know it */
	function likely(t) {
		var L = data('likely'), lang = t.lang, s = t.script ?
			titleCase(t.script) : null, r = t.region ?
			t.region.toUpperCase() : null, keys = [], i, m;

		/* a tag with all three is as full as it gets, unknowns and all */
		if (lang !== 'und' && s && r)
			return { lang: lang, script: t.script, region: t.region,
				variants: t.variants };
		if (s === 'Zzzz')
			s = null;
		if (r === 'ZZ')
			r = null;

		if (s && r)
			keys.push(lang + '-' + s + '-' + r);
		if (r)
			keys.push(lang + '-' + r);
		if (s)
			keys.push(lang + '-' + s);
		keys.push(lang);
		if (s)
			keys.push('und-' + s);
		for (i = 0; i < keys.length; i++) {
			m = own(L, keys[i]);
			if (m)
				break;
		}
		if (!m)
			return null;
		m = m.split('-');
		return {
			lang: lang === 'und' ? m[0] : lang,
			script: (s || m[1]).toLowerCase(),
			region: (r || m[2]).toLowerCase(),
			variants: t.variants
		};
	}

	/* ---- Intl.Locale ---- */

	var SLOTS = new WeakMap();
	var KEYS = ['ca', 'co', 'fw', 'hc', 'kf', 'kn', 'nu'];
	var WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
	var TYPE = /^[a-z\d]{3,8}(-[a-z\d]{3,8})*$/i;

	function slots(o, m) {
		var s = o !== null && typeof o === 'object' && SLOTS.get(o);

		if (!s)
			throw new TypeError('Method Intl.Locale.prototype.' + m +
					    ' called on incompatible receiver');
		return s;
	}

	function getOpt(o, name, allowed) {
		var v = o[name];

		if (v === undefined)
			return undefined;
		v = String(v);
		if (allowed && allowed.indexOf(v) < 0)
			throw new RangeError('Value ' + v + ' out of range for ' +
					     'Intl.Locale options property ' + name);
		return v;
	}

	function keyword(t, key) {
		var i;

		if (!t.u)
			return undefined;
		for (i = 0; i < t.u.kw.length; i++) {
			if (t.u.kw[i][0] === key)
				return t.u.kw[i][1];
		}
		return undefined;
	}

	function makeLocale(obj, t) {
		var s = { t: t, tag: format(t) };

		SLOTS.set(obj, s);
		return obj;
	}

	function Locale(tag, options) {
		var t, o, base, v, i;

		if (!new.target)
			throw new TypeError('Constructor Intl.Locale requires \'new\'');
		if (typeof tag !== 'string' && (tag === null ||
		    (typeof tag !== 'object' && typeof tag !== 'function')))
			throw new TypeError('First argument to Intl.Locale ' +
					    'constructor can\'t be empty or missing');
		if (typeof tag === 'object' && tag !== null && SLOTS.get(tag))
			tag = SLOTS.get(tag).tag;
		else
			tag = String(tag);
		o = options === undefined ? Object.create(null) : X.toObject(options);
		t = canonical(parse(tag));
		/* UpdateLanguageId */
		v = getOpt(o, 'language');
		if (v !== undefined) {
			if (!isLanguage(v.toLowerCase()))
				invalid();
			t.lang = v.toLowerCase();
		}
		v = getOpt(o, 'script');
		if (v !== undefined) {
			if (!isScript(v.toLowerCase()))
				invalid();
			t.script = v.toLowerCase();
		}
		v = getOpt(o, 'region');
		if (v !== undefined) {
			if (!isRegion(v.toLowerCase()))
				invalid();
			t.region = v.toLowerCase();
		}
		v = getOpt(o, 'variants');
		if (v !== undefined) {
			var vs = v.toLowerCase().split('-');

			for (i = 0; i < vs.length; i++) {
				if (!isVariant(vs[i]) || vs.indexOf(vs[i]) !== i)
					invalid();
			}
			t.variants = vs;
		}
		/* the keywords the options give */
		var opt = {};

		v = getOpt(o, 'calendar');
		if (v !== undefined && !TYPE.test(v))
			invalid();
		opt.ca = v;
		v = getOpt(o, 'collation');
		if (v !== undefined && !TYPE.test(v))
			invalid();
		opt.co = v;
		v = getOpt(o, 'firstDayOfWeek');
		if (v !== undefined) {
			if (/^[0-7]$/.test(v))
				v = WEEKDAYS[+v];
			if (!TYPE.test(v))
				invalid();
		}
		opt.fw = v;
		opt.hc = getOpt(o, 'hourCycle', ['h11', 'h12', 'h23', 'h24']);
		opt.kf = getOpt(o, 'caseFirst', ['upper', 'lower', 'false']);
		v = o.numeric;
		opt.kn = v === undefined ? undefined : String(!!v);
		v = getOpt(o, 'numberingSystem');
		if (v !== undefined && !TYPE.test(v))
			invalid();
		opt.nu = v;
		for (i = 0; i < KEYS.length; i++) {
			v = opt[KEYS[i]];
			if (v === undefined)
				continue;
			if (!t.u)
				t.u = { attrs: [], kw: [] };
			t.u.kw = t.u.kw.filter(function (k) {
				return k[0] !== KEYS[i];
			});
			t.u.kw.push([KEYS[i], v.toLowerCase()]);
		}
		/* the values the options gave in canonical form too */
		base = canonical(parse(format(t)));
		return makeLocale(this, base);
	}

	var proto = Locale.prototype;

	function method(name, fn) {
		X.method(proto, name, fn);
	}

	function getter(name, fn) {
		Object.defineProperty(proto, name, {
			configurable: true, get: fn
		});
	}

	method('toString', function toString() {
		return slots(this, 'toString').tag;
	});
	/* a copy of a parsed tag, extensions and all */
	function others(t) {
		return JSON.parse(JSON.stringify(t));
	}
	method('maximize', function maximize() {
		var s = slots(this, 'maximize'), m = likely(s.t), t = others(s.t);

		if (m) {
			t.lang = m.lang;
			t.script = m.script;
			t.region = m.region;
		}
		return makeLocale(Object.create(proto), t);
	});
	method('minimize', function minimize() {
		var s = slots(this, 'minimize'), max = likely(s.t), t = others(s.t);
		var trials, i, m, key;

		if (max) {
			key = idString(max);
			trials = [{ lang: max.lang }, { lang: max.lang,
				region: max.region }, { lang: max.lang, script: max.script }];
			t.lang = max.lang;
			t.script = max.script;
			t.region = max.region;
			for (i = 0; i < trials.length; i++) {
				trials[i].variants = max.variants;
				m = likely(trials[i]);
				if (m && idString(m) === key) {
					t.lang = trials[i].lang;
					t.script = trials[i].script;
					t.region = trials[i].region;
					break;
				}
			}
		}
		return makeLocale(Object.create(proto), t);
	});

	getter('baseName', function () {
		var t = slots(this, 'baseName').t;

		return format({ lang: t.lang, script: t.script, region: t.region,
			variants: t.variants, other: {} });
	});
	getter('language', function () {
		return slots(this, 'language').t.lang;
	});
	getter('script', function () {
		var t = slots(this, 'script').t;

		return t.script ? titleCase(t.script) : undefined;
	});
	getter('region', function () {
		var t = slots(this, 'region').t;

		return t.region ? t.region.toUpperCase() : undefined;
	});
	getter('variants', function () {
		var t = slots(this, 'variants').t;

		return t.variants.length ? t.variants.slice().sort().join('-') :
			undefined;
	});
	/* a keyword with no value is true, as V8 has it, but for caseFirst */
	[['calendar', 'ca'], ['caseFirst', 'kf'], ['collation', 'co'],
	 ['hourCycle', 'hc'], ['numberingSystem', 'nu'],
	 ['firstDayOfWeek', 'fw']].forEach(function (g) {
		getter(g[0], function () {
			var v = keyword(slots(this, g[0]).t, g[1]);

			return v === '' && g[1] !== 'kf' ? 'true' : v;
		});
	});
	getter('numeric', function () {
		var v = keyword(slots(this, 'numeric').t, 'kn');

		return v === '' || v === 'true';
	});

	/* ---- what a locale prefers ---- */

	/* the region a keyword gives, as ICU reads rg and sd: its first two
	 * letters, if they are a region */
	function keywordRegion(t, key) {
		var v = keyword(t, key), r;

		if (!v || !/^[a-z]{2}[a-z\d]{1,4}$/.test(v))
			return null;
		r = v.slice(0, 2).toUpperCase();
		return own(data('locinfo').tz, r) ? r : null;
	}

	/* the region whose preferences the locale takes: rg's, the tag's,
	 * then (for the calendar and week) sd's, then the likely one */
	function region(t, sd) {
		var r = keywordRegion(t, 'rg'), m;

		if (r)
			return r;
		if (t.region)
			return t.region.toUpperCase();
		r = sd && keywordRegion(t, 'sd');
		if (r)
			return r;
		m = likely(t);
		return m ? m.region.toUpperCase() : null;
	}

	function calendars(t) {
		var v = keyword(t, 'ca'), cal = data('locinfo').cal;

		if (v)
			return [v];
		return (own(cal, region(t, true)) || cal['001']).slice();
	}

	/* what find gives for the tag or the first of its fallbacks, where
	 * (CLDR's rule) a script the language is not likely written in falls
	 * back to root, for which it gives null */
	function fallback(base, find) {
		var stop = false, r = C.lookup(base, function (x) {
			var p = x.split('-'), m;

			if (stop)
				return true;
			if (find(x))
				return find(x);
			if (p.length === 2 && p[1].length === 4) {
				m = likely({ lang: p[0], variants: [] });
				stop = !m || titleCase(m.script) !== p[1];
			}
			return null;
		});

		return r === true ? null : r;
	}

	function collations(t) {
		var v = keyword(t, 'co'), info = data('locinfo'), base, c;

		if (v)
			return [v];
		base = idString({ lang: t.lang, script: t.script ?
			titleCase(t.script) : null, region: t.region ?
			t.region.toUpperCase() : null, variants: [] });
		c = fallback(base, function (x) {
			return own(info.coll, x);
		});
		return (c || info.collRoot).split(' ');
	}

	function hourCycles(t) {
		var v = keyword(t, 'hc'), hc = data('locinfo').hc, r = region(t);

		if (v)
			return [v];
		/* ICU takes h23 where CLDR has no preference */
		v = own(hc, t.lang + '-' + r) || own(hc, r) || 'h23';
		return [v];
	}

	function numberingSystems(t) {
		var v = keyword(t, 'nu'), base, found;

		if (v)
			return [v];
		base = format({ lang: t.lang, script: t.script, region: t.region,
			variants: [], other: {} });
		found = fallback(base, X.hasLocale);
		return [found ? X.entry('n', X.dataTag(found)).nu : 'latn'];
	}

	function timeZones(t) {
		if (!t.region)
			return undefined;
		return (own(data('locinfo').tz, t.region.toUpperCase()) || [])
			.slice();
	}

	function textInfo(t) {
		var m = likely(t), s = (m ? m.script : t.script) || '';

		return { direction: data('locinfo').rtl.indexOf(titleCase(s)) >= 0 ?
			'rtl' : 'ltr' };
	}

	function weekInfo(t) {
		var w = data('locinfo'), r = region(t, true) || '001';
		var fw = keyword(t, 'fw');
		var first = own(w.first, r), start = own(w.start, r);
		var end = own(w.end, r), min = own(w.min, r), weekend = [], d;

		if (first === undefined)
			first = w.first['001'];
		if (start === undefined)
			start = w.start['001'];
		if (end === undefined)
			end = w.end['001'];
		if (min === undefined)
			min = w.min['001'];
		if (fw && WEEKDAYS.indexOf(fw) >= 0)
			first = WEEKDAYS.indexOf(fw) || 7;
		for (d = start; ; d = d % 7 + 1) {
			weekend.push(d);
			if (d === end)
				break;
		}
		weekend.sort(function (a, b) { return a - b; });
		return { firstDay: first, weekend: weekend, minimalDays: min };
	}

	/* the methods of Intl Locale Info, and the getters V8 had before
	 * them */
	[['getCalendars', 'calendars', calendars],
	 ['getCollations', 'collations', collations],
	 ['getHourCycles', 'hourCycles', hourCycles],
	 ['getNumberingSystems', 'numberingSystems', numberingSystems],
	 ['getTimeZones', 'timeZones', timeZones],
	 ['getTextInfo', 'textInfo', textInfo],
	 ['getWeekInfo', 'weekInfo', weekInfo]].forEach(function (m) {
		method(m[0], function () {
			return m[2](slots(this, m[0]).t);
		});
		getter(m[1], function () {
			return m[2](slots(this, m[1]).t);
		});
	});
	Object.defineProperty(proto, Symbol.toStringTag, {
		configurable: true, value: 'Intl.Locale'
	});
	Object.defineProperty(Locale, 'prototype', { writable: false });

	Intl.Locale = Locale;
	/* for vita/js/intl.js: a tag's likely language, script and region
	 * (UTS #35 Add Likely Subtags), or null */
	X.likely = function (tag) {
		var m = likely(parse(tag));

		return m ? { lang: m.lang, script: titleCase(m.script),
			     region: m.region.toUpperCase() } : null;
	};
	C.setCanonical(canonicalize, function (o) {
		var s = SLOTS.get(o);

		return s ? s.tag : null;
	});
};

if (typeof window !== 'undefined' && window.__vitaIntl &&
    window.__vitaIntl.number && window.__vitaIntl.has &&
    window.__vitaIntl.has('aliases') && window.__vitaIntlCore)
	__vitaIntlTags(window, window.__vitaIntl, window.__vitaIntlCore,
		       window.__vitaIntl.number);

if (typeof module !== 'undefined')
	module.exports = __vitaIntlTags;
