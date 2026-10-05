//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// ICU's resource bundles as its data release writes them (genrb's text
// format), read into objects, and looked up as ICU looks them up: a key a
// locale lacks is its parent's, a parent is the locale with its last
// subtag dropped unless %%Parent says otherwise, %%ALIAS makes one locale
// another, and an alias resource is the value at another path, /LOCALE/
// meaning the locale first asked for. Used by the generators of
// resources/intl.pak.

import fs from 'fs';
import path from 'path';

// a table keeps its keys in order; an alias is { alias: path }
export function parseResource(text) {
	let i = 0;
	const n = text.length;

	function skip() {
		for (;;) {
			while (i < n && /\s/.test(text[i]))
				i++;
			if (text.startsWith('//', i)) {
				while (i < n && text[i] !== '\n')
					i++;
			} else if (text.startsWith('/*', i)) {
				i = text.indexOf('*/', i + 2) + 2;
			} else {
				return;
			}
		}
	}
	function str() {
		let out = '';

		i++;
		while (text[i] !== '"') {
			if (text[i] === '\\') {
				const e = text[i + 1];

				if (e === 'u') {
					out += String.fromCharCode(parseInt(text.substr(i + 2, 4), 16));
					i += 6;
				} else if (e === 'U') {
					out += String.fromCodePoint(parseInt(text.substr(i + 2, 8), 16));
					i += 10;
				} else {
					out += { n: '\n', t: '\t', r: '\r' }[e] || e;
					i += 2;
				}
			} else {
				out += text[i++];
			}
		}
		i++;
		return out;
	}
	// strings written one after the other are one string
	function strings() {
		let s = '';

		while (text[i] === '"') {
			s += str();
			skip();
		}
		return s;
	}
	function key() {
		if (text[i] === '"')
			return str();
		const m = /^[^\s{}:",]+/.exec(text.slice(i, i + 200));

		i += m[0].length;
		return m[0];
	}
	// a resource's type after its colon, and (nofallback) after a table's
	function typeOf() {
		const t = /^[a-z0-9]+/.exec(text.slice(i, i + 40))[0];

		i += t.length;
		skip();
		if (text[i] === '(') {
			i = text.indexOf(')', i) + 1;
			skip();
		}
		return t;
	}
	// whether a quoted string here is a table's key: a brace or a
	// type follows it
	function quotedKey() {
		const at = i;

		str();
		skip();
		const r = text[i] === '{' || text[i] === ':';

		i = at;
		return r;
	}
	// the body of { ... }, i just past the brace
	function body(type) {
		skip();
		if (type === 'alias') {
			const a = strings();

			skip();
			i++;
			return { alias: a };
		}
		if (type === 'int') {
			const m = /^-?\d+/.exec(text.slice(i));

			i += m[0].length;
			skip();
			i++;
			return +m[0];
		}
		if (type === 'intvector') {
			const out = [];

			for (;;) {
				skip();
				if (text[i] === '}') {
					i++;
					return out;
				}
				const m = /^-?\d+/.exec(text.slice(i));

				out.push(+m[0]);
				i += m[0].length;
				skip();
				if (text[i] === ',')
					i++;
			}
		}
		if (type === 'bin' && text[i] === '"') {
			const hex = strings();

			skip();
			i++;
			return { bin: hex };
		}
		if (type === 'bin' || type === 'import') {
			let depth = 1;

			while (depth) {
				if (text[i] === '{')
					depth++;
				else if (text[i] === '}')
					depth--;
				i++;
			}
			return null;
		}
		if (text[i] === '}') {
			i++;
			return type === 'array' ? [] : type === 'string' ? '' : {};
		}
		if (text[i] === ':' || (type === 'array' && text[i] !== '"')) {
			const out = [];

			for (;;) {
				skip();
				if (text[i] === '}') {
					i++;
					return out;
				}
				out.push(element());
				skip();
				if (text[i] === ',')
					i++;
			}
		}
		if (text[i] === '"' && !quotedKey()) {
			const s = strings();

			if (text[i] === '}' && type !== 'array') {
				i++;
				return s;
			}
			const out = [s];

			for (;;) {
				skip();
				if (text[i] === ',')
					i++;
				skip();
				if (text[i] === '}') {
					i++;
					return out;
				}
				out.push(element());
			}
		}
		if (text[i] === '{') {
			const out = [];

			for (;;) {
				skip();
				if (text[i] === '}') {
					i++;
					return out;
				}
				out.push(element());
				skip();
				if (text[i] === ',')
					i++;
			}
		}
		const out = {};

		for (;;) {
			skip();
			if (text[i] === '}') {
				i++;
				return out;
			}
			const k = key();
			let t = null;

			skip();
			if (text[i] === ':') {
				i++;
				t = typeOf();
			}
			i++;
			out[k] = body(t);
		}
	}
	// an element of an array: a string, or a braced resource
	function element() {
		skip();
		if (text[i] === '"')
			return strings();
		let t = null;

		if (text[i] === ':') {
			i++;
			t = typeOf();
		}
		i++;
		return body(t);
	}

	skip();
	const name = key();

	skip();
	let t = null;

	if (text[i] === ':') {
		i++;
		t = typeOf();
	}
	i++;
	return { name, value: body(t) };
}

// a tree of bundles (locales, zone, misc...) in the data directory
export class Tree {
	constructor(dir) {
		this.dir = dir;
		this.cache = new Map();
		this.pool = null;
	}
	file(name) {
		if (!this.cache.has(name)) {
			const f = path.join(this.dir, name + '.txt');

			this.cache.set(name, fs.existsSync(f) ?
				parseResource(fs.readFileSync(f, 'utf8')).value : null);
		}
		return this.cache.get(name);
	}
	// the bundle a locale's data is in, and its parent
	parentOf(name) {
		if (name === 'root')
			return null;
		const b = this.file(name);

		if (b && b['%%Parent'] !== undefined)
			return b['%%Parent'];
		const cut = name.lastIndexOf('_');

		return cut > 0 ? name.slice(0, cut) : 'root';
	}
	// the bundle that stands for name, following %%ALIAS
	resolveName(name) {
		for (let k = 0; k < 10; k++) {
			const b = this.file(name);

			if (b && typeof b['%%ALIAS'] === 'string')
				name = b['%%ALIAS'];
			else
				return name;
		}
		return name;
	}
	// the bundles looked in for a locale, the locale first and root last
	chain(name) {
		const out = [];
		let n = this.resolveName(name);

		while (n) {
			if (this.file(n))
				out.push(n);
			n = this.parentOf(n);
			if (n)
				n = this.resolveName(n);
		}
		return out;
	}
	// Where ures_getByKeyWithFallback finds path (an array of keys)
	// for a locale: the first bundle down its chain that has it, an
	// alias on the way followed into its target, /LOCALE/ meaning the
	// locale first asked for. { bundle, path, value } or null.
	locate(locale, keys, requested = locale, depth = 0) {
		if (depth > 30)
			throw new Error('alias loop at ' + keys.join('/'));
		for (const b of this.chain(locale)) {
			let v = this.file(b), k;

			for (k = 0; k < keys.length; k++) {
				if (isAlias(v)) {
					const t = this.target(v.alias, requested);

					return this.locate(t.bundle, t.path.concat(keys.slice(k)),
							   requested, depth + 1);
				}
				if (!v || typeof v !== 'object' || !(keys[k] in v))
					break;
				v = v[keys[k]];
			}
			if (k < keys.length || v === null)
				continue;
			if (isAlias(v)) {
				const t = this.target(v.alias, requested);

				return this.locate(t.bundle, t.path, requested, depth + 1);
			}
			return { bundle: b, path: keys, value: v };
		}
		return null;
	}
	target(alias, requested) {
		const p = alias.split('/').filter(Boolean);

		if (!alias.startsWith('/'))
			return { bundle: p[0], path: p.slice(1) };
		if (p[0] === 'LOCALE')
			return { bundle: requested, path: p.slice(1) };
		if (p[0] === 'ICUDATA')
			p.shift();
		return { bundle: p[0], path: p.slice(1) };
	}
	// The tables getAllItemsWithFallback hands its sink, nearest first:
	// where the path is found, then the same path (where an alias led
	// it) from that bundle's parent on.
	items(locale, keys, requested = locale) {
		const out = [];
		let at = this.locate(locale, keys, requested);

		while (at) {
			out.push(at);
			const p = this.parentOf(at.bundle);

			if (!p)
				break;
			at = this.locate(this.resolveName(p), at.path, requested);
		}
		return out;
	}
	// The value at path: a table as a sink sees it, each key the
	// nearest table's that has it, an alias in it followed; anything
	// else where it is first found. Deep, tables in it are merged the
	// same way all the way down, as DateIntervalInfo's sink reads them.
	get(locale, keys, requested = locale, deep = false, depth = 0) {
		if (depth > 20)
			throw new Error('alias loop at ' + keys.join('/'));
		const its = this.items(locale, keys, requested);

		if (!its.length)
			return undefined;
		if (!isTable(its[0].value))
			return its[0].value;
		return this.merge(its.map(it => it.value), requested, deep, depth);
	}
	merge(tables, requested, deep, depth) {
		const out = {}, seen = {};

		for (const t of tables) {
			if (!isTable(t))
				continue;
			for (const k of Object.keys(t)) {
				let e = t[k];

				if (isAlias(e)) {
					const a = this.target(e.alias, requested);

					e = this.get(a.bundle, a.path, requested, deep, depth + 1);
				}
				if (!(k in out)) {
					out[k] = e;
					seen[k] = [e];
				} else if (deep && isTable(out[k])) {
					seen[k].push(e);
				}
			}
		}
		if (deep) {
			for (const k in out)
				if (isTable(out[k]) && seen[k].length > 1)
					out[k] = this.merge(seen[k], requested, deep, depth + 1);
		}
		return out;
	}
}

function isAlias(v) {
	return v && typeof v === 'object' && !Array.isArray(v) &&
		typeof v.alias === 'string' && Object.keys(v).length === 1;
}

function isTable(v) {
	return v && typeof v === 'object' && !Array.isArray(v) && !isAlias(v);
}

// ---- a tree of bundles for resources/intl.pak ----

// ICU's tables for a locale with no bundle (scripts/gen-icu-fallback.mjs)
const FALLBACK = JSON.parse(fs.readFileSync(new URL('icu-fallback.json',
	import.meta.url), 'utf8'));

// the ICU locale ID of a BCP 47 tag
export function icuId(tag) {
	const p = tag.split('-'), out = [p[0].toLowerCase()];
	let i = 1;

	if (p[i] && p[i].length === 4 && /^[a-z]/i.test(p[i]))
		out.push(p[i][0].toUpperCase() + p[i++].slice(1).toLowerCase());
	if (p[i] && /^([a-z]{2}|\d{3})$/i.test(p[i]))
		out.push(p[i++].toUpperCase());
	for (; i < p.length; i++)
		out.push(p[i].toUpperCase());
	return out[0] === 'und' && out.length === 1 ? 'root' : out.join('_');
}

// getDefaultScript
function defaultScript(lang, region) {
	return (region && FALLBACK.script[lang + '_' + region]) ||
		FALLBACK.script[lang] || 'Latn';
}

// getParentLocaleID: where ICU looks next for a bundle it has not found
function parentLocaleID(name, orig) {
	const p = name.split('_'), chop = () => {
		const cut = name.lastIndexOf('_');

		return cut > 0 ? name.slice(0, cut) : null;
	};
	const isScript = x => /^[A-Z][a-z]{3}$/.test(x || '');
	const isRegion = x => /^([A-Z]{2}|\d{3})$/.test(x || '');
	const lang = p[0], script = isScript(p[1]) ? p[1] : '';
	const region = isRegion(p[script ? 2 : 1]) ? p[script ? 2 : 1] : '';

	if (p.length > 1 + (script ? 1 : 0) + (region ? 1 : 0))
		return chop();	// a variant
	if (FALLBACK.parent[name])
		return FALLBACK.parent[name];
	if (script && region)
		return lang + '_' + (defaultScript(lang, region) === script ?
				     region : script);
	if (region) {
		const o = orig.split('_');

		return lang + '_' + (isScript(o[1]) ? o[1] :
				     defaultScript(lang, region));
	}
	if (script)
		return defaultScript(lang) === script ? lang : null;
	return null;
}

// Each bundle in a directory of ICU's (locales, zone...) with what
// extract keeps of it, as <prefix>:<bundle>, and <prefix>:index: { b: the
// bundles, space separated, p: { bundle: the parent its %%Parent names },
// a: { bundle: the bundle it is an alias of }, f: { locale: the bundle
// ICU opens for it, for each of the given locales that has none of its
// own, as ICU's findFirstExisting finds it } }.
export function bundleEntries(dir, prefix, extract, locales) {
	const tree = new Tree(dir);
	const entries = {}, parents = {}, aliases = {}, bundles = [];

	for (const f of fs.readdirSync(dir).sort()) {
		if (!f.endsWith('.txt') || f === 'res_index.txt' || f === 'pool.txt')
			continue;
		const name = f.slice(0, -4), b = tree.file(name);

		if (typeof b['%%ALIAS'] === 'string') {
			aliases[name] = b['%%ALIAS'];
			continue;
		}
		bundles.push(name);
		if (b['%%Parent'] !== undefined)
			parents[name] = b['%%Parent'];
		const d = extract(b);

		if (d && Object.keys(d).length)
			entries[prefix + ':' + name] = d;
	}
	const set = new Set(bundles);
	const has = n => set.has(n) || aliases[n] !== undefined;
	const first = {};

	for (const tag of locales || []) {
		const orig = icuId(tag);
		let n = orig;

		while (n && !has(n))
			n = parentLocaleID(n, orig);
		if (n !== orig)
			first[orig] = n || 'root';
	}
	entries[prefix + ':index'] = { b: bundles.join(' '), p: parents,
		a: aliases, f: first };
	return entries;
}
