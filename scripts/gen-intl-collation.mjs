//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Intl.Collator's data for resources/intl.pak (vita/js/intl_collator.js),
// from ICU's own: its root collation (unidata/FractionalUCA.txt, CLDR's
// root order with ICU's weights) and each locale's tailoring rules
// (coll/*.txt), taken from the ICU data release whose ICU Node has
// (icu4c-<version>-data.zip). The ICU data is under the Unicode licence,
// which is GPL-compatible. scripts/gen-intl-numbers.mjs calls
// collationEntries() when given the unpacked data directory.
//
// Entries: k:meta (Han ranges, combining classes, script groups for
// reordering, the locales and their collations), k:r:<block> (the root's
// elements for 256 code points, with the contractions and prefixes that
// start or end there) and k:t:<locale>-<type> (a tailoring, built here
// the way ICU's CollationBuilder builds one).
//
// A weight is ICU's root weight and, for what a tailoring inserts, a
// position between two root weights ("+n" in the pack), so the order is
// ICU's though the bytes are not.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname),
	'..');
const { core: makeCore } = require(path.join(ROOT_DIR,
	'vita/js/intl_collator.js'));

const MID = 0x8000;
const hex = n => n.toString(16).toUpperCase();
const HAN_BASE = 0x81100000;

// ---- the root ----

function parseFractional(file) {
	const text = fs.readFileSync(file, 'utf8').split('\n');
	const map = new Map(), prefixes = [], special = {}, starts = [];
	let han = [], vt = 0, topBytes = {}, hanRank = null;
	const order = [];

	// Han's order, radical by radical and by strokes within, as ICU's
	// root has it: [radical n=...:chars and a-b ranges]
	for (const line of text) {
		if (!line.startsWith('[radical'))
			continue;
		const body = line.slice(line.indexOf(':') + 1, line.lastIndexOf(']'));
		const cps = [...body].map(c => c.codePointAt(0));

		for (let i = 0; i < cps.length; i++) {
			if (cps[i + 1] === 0x2d && i + 2 < cps.length) {
				for (let c = cps[i]; c <= cps[i + 2]; c++)
					order.push(c);
				i += 2;
			} else {
				order.push(cps[i]);
			}
		}
	}
	const runs = [];

	{
		const seen = new Set();

		for (const cp of order) {
			if (seen.has(cp))
				continue;
			seen.add(cp);
			const last = runs[runs.length - 1];

			if (last && last[0] + last[1] === cp)
				last[1]++;
			else
				runs.push([cp, 1]);
		}
		hanRank = new Map();
		let r = 0;

		for (const [cp, n] of runs)
			for (let k = 0; k < n; k++)
				hanRank.set(cp + k, r++);
	}

	const bytes = s => s.trim() ? s.trim().split(/\s+/).map(b =>
		parseInt(b, 16)) : [];
	const p32 = b => b.reduce((v, x, i) => v + x * 2 ** (24 - 8 * i), 0);
	const w16 = b => b.length ? b[0] * 256 + (b[1] || 0) : 0;
	const hanP32 = cp => {
		let at = 0;

		if (hanRank.has(cp))
			return HAN_BASE + hanRank.get(cp);
		for (const [a, z] of han) {
			if (cp >= a && cp <= z)
				return HAN_BASE + 0x30000 + at + cp - a;
			at += z - a + 1;
		}
		throw new Error('not Han: ' + hex(cp));
	};
	const parseCE = s => {
		const parts = s.split(',');
		const m = /^U\+([0-9A-F]+)$/.exec(parts[0].trim());

		// a Han character's implicit weight, its tertiary given or not
		if (m)
			return [hanP32(parseInt(m[1], 16)), 0x0500,
				parts[1] ? w16(bytes(parts[1])) : 0x0500];
		return [p32(bytes(parts[0])), w16(bytes(parts[1])),
			w16(bytes(parts[2]))];
	};
	const parseCEs = s => [...s.matchAll(/\[([^\]]*)\]/g)].map(m =>
		parseCE(m[1]));

	for (let line of text) {
		const hash = line.indexOf('#');
		const comment = hash >= 0 ? line.slice(hash + 1).trim() : '';

		if (hash >= 0)
			line = line.slice(0, hash);
		line = line.trim();
		if (!line)
			continue;
		let m;

		if ((m = /^\[Unified_Ideograph (.*)\]$/.exec(line))) {
			han = m[1].split(/\s+/).map(r => {
				const [a, z] = r.split('..');

				return [parseInt(a, 16), parseInt(z || a, 16)];
			});
			continue;
		}
		if ((m = /^\[variable top = ([0-9A-F ]+)\]$/.exec(line))) {
			vt = p32(bytes(m[1]));
			continue;
		}
		if ((m = /^\[top_byte\s+([0-9A-F]+)\s+([^\]]*)\]$/.exec(line))) {
			topBytes[parseInt(m[1], 16)] = m[2].replace(/COMPRESS/, '')
				.trim().split(/\s+/);
			continue;
		}
		if ((m = /^\[((?:first|last) [a-z ]+?) (\[.*\])\]$/.exec(line))) {
			special[m[1]] = parseCEs(m[2])[0];
			continue;
		}
		if (line.startsWith('['))
			continue;
		if ((m = /^([0-9A-F ]+?)(?:\s*\|\s*([0-9A-F ]+?))?\s*;\s*(.*)$/
		     .exec(line))) {
			const cps = m[1].trim().split(/\s+/).map(h => parseInt(h, 16));
			const ces = parseCEs(m[3]);

			if (m[2]) {
				// "prefix | char"
				const ch = m[2].trim().split(/\s+/).map(h =>
					parseInt(h, 16));

				prefixes.push([String.fromCodePoint(...ch),
					String.fromCodePoint(...cps), ces]);
				continue;
			}
			const key = String.fromCodePoint(...cps);

			map.set(key, ces);
			if (cps[0] === 0xFDD1 && cps.length === 2 && /first primary/
			    .test(comment))
				starts.push([ces[0][0], cps[1],
					comment.replace(/ first primary.*/, '')]);
		}
	}
	return { map, prefixes, special, starts, han, vt, topBytes,
		runs: [].concat(...runs) };
}

// the canonical combining classes, as ranges "from:to:class"
function combiningClasses(file) {
	const out = [];

	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const f = line.split(';');

		if (f.length < 4 || f[3] === '0')
			continue;
		const cp = parseInt(f[0], 16), cc = +f[3], last = out[out.length - 1];

		if (last && last[1] === cp - 1 && last[2] === cc)
			last[1] = cp;
		else
			out.push([cp, cp, cc]);
	}
	return out.map(r => hex(r[0]) + ':' + hex(r[1]) + ':' + r[2]);
}

// the script groups, in root order, with the codes [reorder] names
// them by
function scriptGroups(root) {
	const SPECIAL = { SPACE: 'space', PUNCTUATION: 'punct',
		SYMBOL: 'symbol', CURRENCY: 'currency', DIGIT: 'digit' };
	const ALIAS = { kana: ['hira', 'hrkt'], hira: ['kana', 'hrkt'],
		hani: ['hans', 'hant'] };
	const groups = [[0, [], 'low']];
	const sorted = root.starts.slice().sort((a, b) => a[0] - b[0]);

	for (const [p, cp, name] of sorted) {
		let codes = [];
		const lead = Math.floor(p / 2 ** 24);

		if (SPECIAL[name]) {
			codes = [SPECIAL[name]];
		} else {
			const ch = String.fromCodePoint(cp);
			const cands = root.topBytes[lead] || [];

			for (const code of cands) {
				let ok = false;

				try {
					ok = new RegExp('\\p{scx=' + code + '}', 'u').test(ch);
				} catch (e) {
				}
				if (ok)
					codes.push(code.toLowerCase());
			}
			if (!codes.length && cands.length)
				codes.push(cands[0].toLowerCase());
			for (const c of codes.slice())
				for (const a of ALIAS[c] || [])
					if (!codes.includes(a))
						codes.push(a);
		}
		if (name === 'HAN' && !codes.includes('hani'))
			codes.push('hani', 'hans', 'hant');
		groups.push([p, codes]);
	}
	groups.push([0xE4000000, [], 'end']);
	return groups;
}

// ---- elements as the pack writes them ----

function cePart(v, width, sub) {
	let h = '';

	if (v) {
		h = hex(v).padStart(width, '0');
		while (h.length > 2 && h.endsWith('00'))
			h = h.slice(0, -2);
	}
	return sub !== undefined && sub !== MID ? h + '+' + (sub - MID) : h;
}

function ceText(ces) {
	return ces.map(c => cePart(c[0], 8, c[3]) + ',' + cePart(c[1], 4, c[4]) +
		',' + cePart(c[2], 4, c[5])).join(' ');
}

// the root's blocks: the pack's, and the builder's with the U+FDD0/1
// markers ICU's rules reset to
function rootBlocks(root, withMarkers) {
	const blocks = {};
	const blk = cp => {
		const b = hex(cp >> 8);

		return blocks[b] || (blocks[b] = { s: {}, c: {}, x: {} });
	};

	for (const [key, ces] of root.map) {
		const cps = [...key].map(c => c.codePointAt(0));

		if (!withMarkers && (cps[0] === 0xFDD0 || cps[0] === 0xFDD1))
			continue;
		const b = blk(cps[0]), low = hex(cps[0] & 0xff);

		if (cps.length === 1)
			b.s[low] = ceText(ces);
		else
			(b.c[low] = b.c[low] || []).push([key.slice(
				String.fromCodePoint(cps[0]).length), ceText(ces)]);
	}
	for (const [ch, prefix, ces] of root.prefixes) {
		const cp = ch.codePointAt(0), b = blk(cp), low = hex(cp & 0xff);

		(b.x[low] = b.x[low] || []).push([prefix, ceText(ces)]);
	}
	return blocks;
}

// ---- ICU's rules ----

// an ICU resource file: { name: { collations: { type: rules }, default,
// alias, parent } }
function readResources(dir) {
	const out = {};

	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith('.txt') || f.includes('__'))
			continue;
		const text = fs.readFileSync(path.join(dir, f), 'utf8')
			.replace(/^\ufeff/, '');
		const name = f.slice(0, -4), info = { types: {} };
		let m;

		if ((m = /"%%ALIAS"\{"([^"]+)"\}/.exec(text)))
			info.alias = m[1];
		if ((m = /%%Parent\{"([^"]+)"\}/.exec(text)))
			info.parent = m[1];
		if ((m = /default\{"([^"]+)"\}/.exec(text)))
			info.dflt = m[1];
		// each type's Sequence strings, in order
		const re = /\n {8}([a-z0-9-]+)\{\s*\n?\s*Sequence\{([\s\S]*?)\}\s*\n\s*Version/g;

		while ((m = re.exec(text)))
			info.types[m[1]] = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
				.map(x => unescapeResource(x[1])).join('');
		out[name] = info;
	}
	return out;
}

function unescapeResource(s) {
	return s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|x[0-9A-Fa-f]{2}|.)/g,
		(m, e) => {
			if (e[0] === 'u' || e[0] === 'U' || e[0] === 'x')
				return String.fromCodePoint(parseInt(e.slice(1), 16));
			return e;
		});
}

const SYNTAX = /[&<=\/|\[\]*\-,;@!#$%^?{}~"'\\]/;
// ICU's Pattern_White_Space: the bidi marks the Arabic rules are strewn
// with, but no no-break space, which Pashto's rules reset to
const WS = /[\t\n\u000B\f\r \u0085\u200E\u200F\u2028\u2029]/;

// ICU's rule syntax as operations: { op: 'reset', str, before } |
// { op: 'rel', strength, str, prefix, ext } | { op: 'opt', text }
function parseRules(rules) {
	const ops = [];
	let i = 0;
	const n = rules.length;
	const ws = () => {
		while (i < n && WS.test(rules[i]))
			i++;
	};
	// a quoted or literal string, up to the next syntax character
	const string = () => {
		let out = '';

		ws();
		while (i < n) {
			const c = rules[i];

			if (c === '\'') {
				if (rules[i + 1] === '\'') {
					out += '\'';
					i += 2;
					continue;
				}
				const end = rules.indexOf('\'', i + 1);

				out += rules.slice(i + 1, end);
				i = end + 1;
				continue;
			}
			if (c === '\\') {
				out += rules[i + 1];
				i += 2;
				continue;
			}
			if (WS.test(c) || SYNTAX.test(c))
				break;
			const cp = rules.codePointAt(i);

			out += String.fromCodePoint(cp);
			i += cp > 0xffff ? 2 : 1;
		}
		return out;
	};
	// a bracketed option, nested brackets and all
	const bracket = () => {
		let depth = 0, start = i;

		for (; i < n; i++) {
			if (rules[i] === '\\') {
				i++;
				continue;
			}
			if (rules[i] === '[')
				depth++;
			else if (rules[i] === ']' && --depth === 0) {
				i++;
				break;
			}
		}
		return rules.slice(start + 1, i - 1).trim();
	};

	while (i < n) {
		ws();
		if (i >= n)
			break;
		const c = rules[i];

		if (c === '[') {
			ops.push({ op: 'opt', text: bracket() });
			continue;
		}
		if (c === '&') {
			i++;
			ws();
			let before = 0, special = null;

			while (rules[i] === '[') {
				const t = bracket();
				const m = /^before ([123])$/.exec(t);

				if (m)
					before = +m[1];
				else
					special = t;
				ws();
			}
			ops.push({ op: 'reset', before, special,
				str: special ? '' : string() });
			continue;
		}
		let strength;

		if (rules.startsWith('<<<<', i))
			strength = 4;
		else if (rules.startsWith('<<<', i))
			strength = 3;
		else if (rules.startsWith('<<', i))
			strength = 2;
		else if (c === '<')
			strength = 1;
		else if (c === '=')
			strength = 0;
		else
			throw new Error('rule syntax at ' + i + ': ' +
					rules.slice(i, i + 20));
		i += strength === 0 ? 1 : strength;
		if (rules[i] === '*') {
			// each character of a list, with a-b ranges
			i++;
			const s = string(), cps = [...s];
			const list = [];

			for (let k = 0; k < cps.length; k++)
				list.push(cps[k]);
			ws();
			while (rules[i] === '-') {
				i++;
				const to = string(), from = list[list.length - 1];

				for (let cp = from.codePointAt(0) + 1;
				     cp <= to.codePointAt(0); cp++)
					list.push(String.fromCodePoint(cp));
				list.push(...[...to].slice(1));
				ws();
			}
			for (const ch of list)
				ops.push({ op: 'rel', strength, str: ch, prefix: '',
					ext: '' });
			continue;
		}
		let str = string(), prefix = '', ext = '';

		ws();
		if (rules[i] === '|') {
			i++;
			prefix = str;
			str = string();
			ws();
		}
		if (rules[i] === '/') {
			i++;
			ext = string();
		}
		ops.push({ op: 'rel', strength, str, prefix, ext });
	}
	return ops;
}

// a UnicodeSet as [suppressContractions] has it: characters, a-b
// ranges and \u escapes
function unicodeSet(text) {
	const s = unescapeResource(text.replace(/^\[|\]$/g, ''))
		.replace(/\s+/g, '');
	const cps = [...s].map(c => c.codePointAt(0)), out = [];

	for (let k = 0; k < cps.length; k++) {
		if (cps[k + 1] === 0x2d && k + 2 < cps.length) {
			for (let c = cps[k]; c <= cps[k + 2]; c++)
				out.push(c);
			k += 2;
		} else {
			out.push(cps[k]);
		}
	}
	return out;
}

// ---- building a tailoring ----

// A weight is a root value (sub MID) or a node in a list of nodes
// tailored after, or before, a root value or another node.
let nodeIds = 0;

function newList() {
	const head = { list: null }, tail = { list: null };

	head.next = tail;
	tail.prev = head;
	const L = { head, tail };

	head.list = tail.list = L;
	return L;
}

function insertAfter(node, item) {
	item.list = node.list;
	item.prev = node;
	item.next = node.next;
	node.next.prev = item;
	node.next = item;
	return item;
}

class Builder {
	constructor(core, root) {
		this.core = core;
		this.root = root;
		this.map = new Map();		// NFD key -> CE objects
		this.prefixed = [];		// [char, prefix, CEs]
		this.lists = new Map();
		this.settings = {};
		this.sup = [];
	}

	// a weight's identity for list keys
	id(w) {
		if (typeof w === 'number')
			return 'r' + w;
		return w.id || (w.id = 'n' + ++nodeIds);
	}

	listFor(key, base, dir) {
		const k = key + '|' + base + '|' + dir;
		let L = this.lists.get(k);

		if (!L) {
			L = newList();
			L.base = base;
			L.dir = dir;
			this.lists.set(k, L);
		}
		return L;
	}

	// a new weight at the level of w (root number or node), after it
	// or (before) before it, in the lists under key
	insert(key, w, before) {
		const item = {};

		if (typeof w === 'number') {
			const L = this.listFor(key, w, before ? -1 : 1);

			return before ? insertAfter(L.tail.prev, item) :
				insertAfter(L.head, item);
		}
		return before ? insertAfter(w.prev, item) : insertAfter(w, item);
	}

	// CE objects { p, s, t, tcase } for NFD text, the tailored strings
	// first, longest match
	ces(text) {
		const out = [];
		let i = 0, plain = '';
		const flush = () => {
			if (!plain)
				return;
			const flat = this.core.ces(plain, null, false);

			for (let k = 0; k < flat.length; k += 3) {
				const p = Math.floor(flat[k] / 65536);
				const s = Math.floor(flat[k + 1] / 65536);
				const t = Math.floor(flat[k + 2] / 65536);

				out.push({ p, s, t: t & 0x3fff, tcase: t >> 14 });
			}
			plain = '';
		};

		while (i < text.length) {
			let best = null;

			// a character with a prefix rule, after its prefix
			for (const [ch, prefix, ces] of this.prefixed) {
				if (text.startsWith(ch, i) && i >= prefix.length &&
				    text.slice(i - prefix.length, i) === prefix) {
					best = [ces, ch.length];
					break;
				}
			}
			for (let len = Math.min(text.length - i, this.maxKey || 1);
			     len > 0 && !best; len--) {
				const v = this.map.get(text.substr(i, len));

				if (v) {
					best = [v, len];
					break;
				}
			}
			if (best) {
				flush();
				out.push(...best[0]);
				i += best[1];
			} else {
				const cp = text.codePointAt(i);

				plain += String.fromCodePoint(cp);
				i += cp > 0xffff ? 2 : 1;
			}
		}
		flush();
		return out.map(c => Object.assign({}, c));
	}

	special(name) {
		const S = this.root.special;

		// ICU puts what is tailored after the last regular primary in
		// Han's group, before Han, so that [reorder Hani] takes it
		// along: after Han's marker here, which no character has
		if (name === 'last regular')
			return [{ p: 0x81020200, s: 0x0500, t: 0x0500, tcase: 0 }];
		const ce = S[name];

		if (!ce)
			throw new Error('no position ' + name);
		return [{ p: ce[0], s: ce[1], t: ce[2] & 0x3fff,
			tcase: ce[2] >> 14 }];
	}

	reset(op) {
		this.anchor = op.special ? this.special(op.special) :
			this.ces(op.str.normalize('NFD'));
		if (!this.anchor.length)
			this.anchor = [{ p: 0, s: 0, t: 0, tcase: 0 }];
		this.before = op.before || 0;
	}

	// ICU's CollationBuilder::setCaseBits, from the root elements of
	// the string
	caseBits(nfd, ces) {
		const tailored = ces.filter(c => c.p !== 0).length;
		let cases = [], last = 0, n = 0;

		if (tailored) {
			const flat = this.core.ces(nfd, null, false);

			for (let k = 0; k < flat.length; k += 3) {
				if (Math.floor(flat[k] / 65536) === 0)
					continue;
				const c = (Math.floor(flat[k + 2] / 65536) >> 14) & 3;

				n++;
				if (n < tailored)
					cases.push(c);
				else if (n === tailored)
					last = c;
				else if (c !== last) {
					last = 1;
					break;
				}
			}
			if (n >= tailored)
				cases.push(last);
		}
		for (const c of ces) {
			if (c.p !== 0)
				c.tcase = cases.length ? cases.shift() : 0;
			else if (c.s === 0 && c.t !== 0)
				c.tcase = 2;
			else
				c.tcase = 0;
		}
	}

	relation(op) {
		const nfd = op.str.normalize('NFD');
		const anchor = this.anchor, last = anchor[anchor.length - 1];
		let ces;

		// a quaternary difference is no difference at the strengths
		// Intl.Collator asks for
		if (op.strength === 0 || op.strength === 4) {
			ces = anchor.map(c => Object.assign({}, c));
		} else {
			const before = this.before === op.strength;
			const c = { p: last.p, s: last.s, t: last.t, tcase: 0 };

			if (op.strength === 1) {
				c.p = this.insert('p', last.p, before);
				c.s = 0x0500;
				c.t = 0x0500;
			} else if (op.strength === 2) {
				c.s = this.insert('s' + this.id(last.p), last.s, before);
				c.t = 0x0500;
			} else {
				c.t = this.insert('t' + this.id(last.p) + '.' +
					this.id(last.s), last.t, before);
			}
			ces = anchor.slice(0, -1).map(x => Object.assign({}, x));
			ces.push(c);
		}
		this.before = 0;
		if (op.ext)
			ces.push(...this.ces(op.ext.normalize('NFD')));
		this.caseBits(nfd, ces);
		if (op.prefix) {
			this.prefixed.push([nfd, op.prefix.normalize('NFD'), ces]);
		} else {
			this.map.set(nfd, ces);
			this.maxKey = Math.max(this.maxKey || 1, nfd.length);
		}
		// the next relation goes after this one
		this.anchor = op.ext ? ces.slice(0, ces.length -
			this.ces(op.ext.normalize('NFD')).length) : ces;
	}

	option(text, imports) {
		let m;

		if ((m = /^import (.*)$/.exec(text)))
			return imports(m[1].trim());
		if ((m = /^caseFirst (upper|lower|off)$/.exec(text)))
			this.settings.caseFirst = m[1] === 'off' ? undefined : m[1];
		else if (/^alternate shifted$/.test(text))
			this.settings.shifted = true;
		else if (/^alternate non-ignorable$/.test(text))
			this.settings.shifted = undefined;
		else if (/^backwards 2$/.test(text))
			this.settings.backwards = true;
		else if ((m = /^reorder (.*)$/.exec(text)))
			this.settings.reorder = m[1].trim().split(/\s+/);
		else if ((m = /^suppressContractions (.*)$/.exec(text)))
			this.sup.push(...unicodeSet(m[1]));
		else if (/^(normalization|strength|optimize|numericOrdering)/.test(text))
			;
		else
			throw new Error('option ' + text);
	}

	run(rules, imports) {
		for (const op of parseRules(rules)) {
			if (op.op === 'opt')
				this.option(op.text, imports);
			else if (op.op === 'reset')
				this.reset(op);
			else
				this.relation(op);
		}
	}

	// a weight as [value, sub]
	resolve(w) {
		if (typeof w === 'number')
			return [w, MID];
		if (w.sub === undefined) {
			const L = w.list;
			let k = 0, n = 0;

			for (let x = L.head.next; x !== L.tail; x = x.next)
				n++;
			for (let x = L.head.next; x !== L.tail; x = x.next, k++) {
				x.base = L.base;
				x.sub = L.dir > 0 ? MID + 1 + k : MID - n + k;
				if (L.dir > 0 && n > 0x7ffe && L.base === 0x81020200) {
					// the Han tailorings before Han: room below it
					x.base = L.base + Math.floor(k / 0x7ffe);
					x.sub = MID + 1 + k % 0x7ffe;
				}
			}
			if (n > 0x7ffe && L.base !== 0x81020200)
				throw new Error('too many tailored weights at ' +
						hex(L.base));
		}
		return [w.base, w.sub];
	}

	text(ces) {
		return ceText(ces.map(c => {
			const p = this.resolve(c.p), s = this.resolve(c.s);
			const t = this.resolve(c.t);

			return [p[0], s[0], t[0] ? (t[0] & 0x3fff) |
				(c.tcase << 14) : 0, p[1], s[1], t[1]];
		}));
	}

	// the pack's tailoring entry
	output() {
		const blocks = {};
		const blk = cp => {
			const b = hex(cp >> 8);

			return blocks[b] || (blocks[b] = { s: {}, c: {}, x: {} });
		};

		for (const [key, ces] of this.map) {
			const cp = key.codePointAt(0), first = String.fromCodePoint(cp);
			const b = blk(cp), low = hex(cp & 0xff);

			if (key === first)
				b.s[low] = this.text(ces);
			else
				(b.c[low] = b.c[low] || []).push([key.slice(first.length),
					this.text(ces)]);
		}
		for (const [ch, prefix, ces] of this.prefixed) {
			const cp = ch.codePointAt(0), b = blk(cp), low = hex(cp & 0xff);

			(b.x[low] = b.x[low] || []).push([prefix, this.text(ces)]);
		}
		for (const b in blocks)
			for (const k of ['s', 'c', 'x'])
				if (!Object.keys(blocks[b][k]).length)
					delete blocks[b][k];
		const out = { b: blocks };

		for (const k in this.settings)
			if (this.settings[k] === undefined)
				delete this.settings[k];
		if (Object.keys(this.settings).length)
			out.set = this.settings;
		if (this.sup.length)
			out.sup = this.sup;
		return out;
	}
}

// ---- locales and their collations ----

const BCP47 = { phonebook: 'phonebk', traditional: 'trad',
	dictionary: 'dict', gb2312han: 'gb2312' };

const ICU_TYPE = Object.fromEntries(Object.entries(BCP47).map(([k, v]) =>
	[v, k]));

function tagOf(name) {
	return name === 'root' ? 'root' : name.replace(/_/g, '-');
}

export function collationEntries(icuDir, tags) {
	const root = parseFractional(path.join(icuDir,
		'unidata/FractionalUCA.txt'));
	const res = readResources(path.join(icuDir, 'coll'));
	const meta = {
		han: root.han, vt: root.vt,
		ccc: combiningClasses(path.join(icuDir, 'unidata/UnicodeData.txt')),
		groups: scriptGroups(root)
	};
	const builderBlocks = rootBlocks(root, true);
	const data = name => name === 'k:meta' ? meta :
		name === 'k:han' ? root.runs :
		name.startsWith('k:r:') ? JSON.parse(JSON.stringify(
			builderBlocks[name.slice(4)] || null)) : null;
	const core = makeCore(data);
	const entries = { };

	// the file a locale's data comes from, aliases followed
	const fileOf = name => {
		const seen = new Set();

		while (res[name] && res[name].alias && !seen.has(name)) {
			seen.add(name);
			name = res[name].alias;
		}
		return res[name] ? name : null;
	};
	const parentOf = name => {
		if (name === 'root')
			return null;
		if (res[name] && res[name].parent)
			return res[name].parent;
		const cut = name.lastIndexOf('_');

		return cut > 0 ? name.slice(0, cut) : 'root';
	};
	// the rules of a type in a locale, its parents' if it has none
	const rulesOf = (name, type) => {
		for (let n = fileOf(name); n; n = parentOf(n)) {
			const f = fileOf(n);

			if (f && res[f].types[type] !== undefined)
				return { file: f, rules: res[f].types[type] };
		}
		return null;
	};
	// [import x-u-co-type]: those rules, here
	const importer = (b, stack) => spec => {
		const m = /^([a-z]+(?:[-_][A-Za-z0-9]+)*?)(?:-u-co-(.+))?$/.exec(spec);
		const loc = m[1] === 'und' ? 'root' : m[1].replace(/-/g, '_');
		const type = ICU_TYPE[m[2]] || m[2] || defaultOf(loc);
		const r = rulesOf(loc, type);

		if (!r)
			throw new Error('cannot import ' + spec);
		if (stack.includes(r.file + '/' + type))
			return;
		b.run(r.rules, importer(b, stack.concat([r.file + '/' + type])));
	};
	const defaultOf = name => {
		for (let n = fileOf(name); n; n = parentOf(n)) {
			const f = fileOf(n);

			if (f && res[f].dflt)
				return res[f].dflt;
		}
		return 'standard';
	};
	const built = new Map();
	// the tailoring entry for rules defined in a file, built once
	const build = (file, type) => {
		const name = tagOf(file) + '-' + (BCP47[type] || type);

		if (built.has(name))
			return built.get(name);
		const r = res[file].types[type];
		let out = null;

		if (r !== undefined && r.trim()) {
			const b = new Builder(core, root);

			b.run(r, importer(b, [file + '/' + type]));
			entries['k:t:' + name] = b.output();
			out = name;
		}
		built.set(name, out);
		return out;
	};

	meta.locales = {};
	for (const name of Object.keys(res)) {
		const types = {};
		const all = new Set();

		for (let n = fileOf(name); n; n = parentOf(n)) {
			const f = fileOf(n);

			if (f)
				Object.keys(res[f].types).forEach(t => all.add(t));
		}
		for (const type of all) {
			if (type.startsWith('private-'))
				continue;
			const r = rulesOf(name, type);

			types[BCP47[type] || type] = r ? build(r.file, type) : null;
		}
		const dflt = defaultOf(name);

		meta.locales[tagOf(name)] = { types, dflt: BCP47[dflt] || dflt };
	}
	// the locales ICU's Collator does not offer, which resolve to the
	// default locale as they do in a browser
	if (tags) {
		meta.nocoll = tags.filter(t =>
			new Intl.Collator(t).resolvedOptions().locale !== t);
		// and those it offers that the other formats do not
		meta.coll = Object.keys(meta.locales).filter(t =>
			tags.indexOf(t) < 0 && !/^root$|-POSIX$|-$/.test(t) &&
			new Intl.Collator(t).resolvedOptions().locale === t);
	}
	entries['k:meta'] = meta;
	entries['k:han'] = root.runs;
	const blocks = rootBlocks(root, false);

	for (const b in blocks) {
		for (const k of ['s', 'c', 'x'])
			if (!Object.keys(blocks[b][k]).length)
				delete blocks[b][k];
		entries['k:r:' + b] = blocks[b];
	}
	return entries;
}
