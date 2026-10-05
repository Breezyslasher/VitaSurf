/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * What every Intl constructor does with the locales it is given
 * (VitaSurf): ECMA-402's CanonicalizeLocaleList, and the lookup of the
 * locale with data that a requested one falls back to. vita/js/intl.js
 * and vita/js/intl_number.js build on it.
 *
 * Plain script with no browser dependencies, so that the generators and
 * tests can load it under Node.
 */
var __vitaIntlCore = (function () {
	'use strict';

	var LANGTAG = /^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?(-([a-z\d]{5,8}|\d[a-z\d]{3}))*(-[a-wyz\d](-[a-z\d]{2,8})+)*(-x(-[a-z\d]{1,8})+)?$/i;

	/* the full canonicalization, once vita/js/intl_tags.js is in */
	var CANON = null, LOCALE_TAG = null;

	function canonicalTag(tag) {
		if (typeof tag !== 'string' && (typeof tag !== 'object' ||
		    tag === null))
			throw new TypeError('Locale must be a string or object');
		if (CANON) {
			var held = typeof tag === 'object' && LOCALE_TAG(tag);

			return held || CANON(String(tag));
		}
		tag = String(tag);
		if (!LANGTAG.test(tag))
			throw new RangeError('Incorrect locale information ' +
					     'provided');
		var p = tag.split('-'), i, ext = false;

		p[0] = p[0].toLowerCase();
		for (i = 1; i < p.length; i++) {
			if (p[i].length === 1)
				ext = true;
			if (ext)
				p[i] = p[i].toLowerCase();
			else if (p[i].length === 4 && /^[a-z]/i.test(p[i]))
				p[i] = p[i].charAt(0).toUpperCase() +
					p[i].slice(1).toLowerCase();
			else if (p[i].length === 2)
				p[i] = p[i].toUpperCase();
			else
				p[i] = p[i].toLowerCase();
		}
		return p.join('-');
	}

	var LISTS = new Map();

	/* f canonicalizes a tag; localeTag gives an Intl.Locale's tag, or
	 * null for anything else */
	function setCanonical(f, localeTag) {
		CANON = f;
		LOCALE_TAG = localeTag;
		LISTS.clear();
	}

	function localeList(locales) {
		var out = [], i;

		if (locales === undefined)
			return out;
		/* a page passes the same tag again and again */
		if (typeof locales === 'string') {
			if (!LISTS.has(locales)) {
				if (LISTS.size >= 64)
					LISTS.clear();
				LISTS.set(locales, canonicalTag(locales));
			}
			return [LISTS.get(locales)];
		}
		if (LOCALE_TAG ? typeof locales === 'object' && locales !== null &&
		    LOCALE_TAG(locales) : typeof Intl !== 'undefined' &&
		    Intl.Locale && locales instanceof Intl.Locale)
			locales = [locales];
		locales = Object(locales);
		for (i = 0; i < (locales.length >>> 0); i++) {
			if (!(i in locales))
				continue;
			var t = canonicalTag(locales[i]);

			if (out.indexOf(t) < 0)
				out.push(t);
		}
		return out;
	}

	/* the tag without its extensions, and its -u- keywords */
	function splitTag(tag) {
		var m = /^(.*?)(-u(-[a-z\d]{2,8})+)?(-x-.*)?$/.exec(tag);
		var kw = {}, base = m[1], u = m[2];

		base = base.replace(/-[a-wyz\d](-[a-z\d]{2,8})+$/, '');
		if (u) {
			var p = u.slice(3).split('-'), key = null, i;

			for (i = 0; i < p.length; i++) {
				if (p[i].length === 2 && /^[a-z\d][a-z]$/.test(p[i])) {
					key = p[i];
					kw[key] = '';
				} else if (key) {
					kw[key] = kw[key] ? kw[key] + '-' + p[i] : p[i];
				}
			}
		}
		return { base: base, kw: kw };
	}

	/* what find gives for the tag, or for the first of its fallbacks,
	 * dropping subtags from the end, that it gives anything for */
	function lookup(base, find) {
		var t = base, r;

		while (t) {
			r = find(t);
			if (r)
				return r;
			var cut = t.lastIndexOf('-');

			t = cut > 0 ? t.slice(0, cut) : '';
			/* a single letter left behind is not a subtag */
			if (/-[a-z\d]$/i.test(t))
				t = t.slice(0, t.lastIndexOf('-'));
		}
		return null;
	}

	return {
		canonicalTag: canonicalTag,
		setCanonical: setCanonical,
		localeList: localeList,
		splitTag: splitTag,
		lookup: lookup
	};
})();

if (typeof module !== 'undefined')
	module.exports = __vitaIntlCore;
