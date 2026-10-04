#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Intl.Segmenter's data for resources/intl.pak (vita/js/intl_segmenter.js),
// from the ICU data release whose ICU Node has (icu4c-<version>-data.zip):
// its break rules (brkitr/rules/char.txt, word.txt, sent.txt and their
// locale variants), compiled here the way ICU's RBBIRuleBuilder compiles
// them, with the character properties they name read from
// unidata/ppucd.txt; and its word dictionaries (brkitr/dictionaries),
// which Thai, Lao, Khmer, Burmese, Chinese and Japanese words are found
// in. The ICU data is under the Unicode licence, which is GPL-compatible.
// scripts/gen-intl-numbers.mjs calls segmenterEntries() when given the
// unpacked data directory.
//
// Entries: g:meta (which rules each granularity and locale takes, the
// character sets of the dictionary engines, the scripts a character
// without an engine is skipped by), g:r:<rules> (a compiled rule set:
// each code point's category and the state table) and g:d:<dict>:<block>
// (the words of a dictionary that start in a block of 256 code points,
// sorted, a line each, with their costs where the dictionary has them).
//
// The compiler follows ICU's: a rule set is one regular expression, the
// rules joined by |, made a DFA from the positions' followpos sets (Aho
// 3.9), with !!chain letting a match that ends on a character continue
// into any rule (not one written with ^) that starts with that
// character's category, {bof} and {eof} as categories 2 and 1, '/' as a
// look-ahead break, and {n} as the status of the rules that end in a
// state.

import fs from 'fs';
import path from 'path';

const N = 0x110000;

// ---- Unicode properties, from ppucd.txt ----

const loose = s => s.toLowerCase().replace(/[\s_-]/g, '');
const ENUMS = ['gc', 'sc', 'lb', 'GCB', 'WB', 'SB', 'InCB', 'ccc', 'NFKC_QC'];
const BINS = ['ExtPict', 'Ideo'];

export function loadUcd(file) {
	const ucd = { prop: {}, value: {}, ids: {}, arr: {}, bin: {} };

	for (const p of ENUMS) {
		ucd.ids[p] = new Map();
		ucd.arr[p] = new Uint8Array(N);
		ucd.value[p] = {};
	}
	for (const b of BINS)
		ucd.bin[b] = new Uint8Array(N);
	const idOf = (p, v) => {
		let id = ucd.ids[p].get(v);

		if (id === undefined) {
			id = ucd.ids[p].size;
			if (id > 255)
				throw new Error('too many values of ' + p);
			ucd.ids[p].set(v, id);
		}
		return id;
	};
	// ccc is not on the defaults line: 0 is its default
	idOf('ccc', '0');
	let defaults = [];
	const apply = (lo, hi, items) => {
		for (const it of items) {
			if (!it)
				continue;
			const eq = it.indexOf('=');

			if (eq < 0) {
				const neg = it[0] === '-', name = neg ? it.slice(1) : it;

				if (ucd.bin[name])
					ucd.bin[name].fill(neg ? 0 : 1, lo, hi + 1);
				continue;
			}
			const k = it.slice(0, eq), v = it.slice(eq + 1);

			if (ucd.arr[k])
				ucd.arr[k].fill(idOf(k, v), lo, hi + 1);
		}
	};
	for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		if (!line || line[0] === '#')
			continue;
		const f = line.split(';');

		if (f[0] === 'property') {
			const short = f[2] || f[3];

			for (const n of [f[2], f[3]])
				if (n)
					ucd.prop[loose(n)] = short;
		} else if (f[0] === 'value') {
			if (!ucd.value[f[1]])
				ucd.value[f[1]] = {};
			for (const n of f.slice(2))
				if (n)
					ucd.value[f[1]][loose(n)] = f[2];
		} else if (/^(defaults|block|cp|unassigned)$/.test(f[0])) {
			const r = f[1].split('..').map(h => parseInt(h, 16));
			const lo = r[0], hi = r.length > 1 ? r[1] : r[0];

			// as ICU's ppucd.cpp: a block and an unassigned range
			// start from the defaults, a cp range from its block's
			if (f[0] === 'defaults') {
				defaults = f.slice(2);
			} else if (f[0] !== 'cp') {
				for (const b of BINS)
					ucd.bin[b].fill(0, lo, hi + 1);
				ucd.arr.ccc.fill(0, lo, hi + 1);
				apply(lo, hi, defaults);
			}
			apply(lo, hi, f.slice(2));
		}
	}
	return ucd;
}

const GC_GROUPS = { L: ['Lu', 'Ll', 'Lt', 'Lm', 'Lo'], LC: ['Lu', 'Ll', 'Lt'],
	M: ['Mn', 'Mc', 'Me'], N: ['Nd', 'Nl', 'No'],
	P: ['Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po'], S: ['Sm', 'Sc', 'Sk', 'So'],
	Z: ['Zs', 'Zl', 'Zp'], C: ['Cc', 'Cf', 'Cs', 'Co', 'Cn'] };

// the code points with a property, as a bitmap
export function propertySet(ucd, name, value) {
	const out = new Uint8Array(N);
	const enumSet = (p, vals) => {
		const ids = new Set(vals.map(v => ucd.ids[p].get(v))
			.filter(x => x !== undefined));

		for (let c = 0; c < N; c++)
			if (ids.has(ucd.arr[p][c]))
				out[c] = 1;
		return out;
	};

	if (value === undefined) {
		const p = ucd.prop[loose(name)];

		if (p && ucd.bin[p])
			return out.set(ucd.bin[p]), out;
		const gc = ucd.value.gc[loose(name)];

		if (gc)
			return enumSet('gc', GC_GROUPS[gc] || [gc]);
		const sc = ucd.value.sc[loose(name)];

		if (sc)
			return enumSet('sc', [sc]);
		throw new Error('unknown property ' + name);
	}
	const p = ucd.prop[loose(name)];

	if (!p || !ucd.arr[p])
		throw new Error('unknown property ' + name);
	const v = ucd.value[p][loose(value)];

	if (!v)
		throw new Error('unknown value ' + name + '=' + value);
	return enumSet(p, p === 'gc' && GC_GROUPS[v] ? GC_GROUPS[v] : [v]);
}

// ---- UnicodeSet patterns, as RBBI rules write them ----

// a set: a bitmap of code points and the strings in it ({bof}, {eof})
const newSet = () => ({ bits: new Uint8Array(N), strings: new Set() });

function setOp(acc, op, s) {
	const a = acc.bits, b = s.bits;

	if (op === '-') {
		for (let c = 0; c < N; c++)
			if (b[c])
				a[c] = 0;
		for (const x of s.strings)
			acc.strings.delete(x);
	} else if (op === '&') {
		for (let c = 0; c < N; c++)
			a[c] &= b[c];
		for (const x of [...acc.strings])
			if (!s.strings.has(x))
				acc.strings.delete(x);
	} else {
		for (let c = 0; c < N; c++)
			a[c] |= b[c];
		for (const x of s.strings)
			acc.strings.add(x);
	}
}

// the escaped or literal character at text[i]: [code point, next index]
function charAt(text, i) {
	if (text[i] !== '\\')
		return [text.codePointAt(i), i + (text.codePointAt(i) > 0xffff ? 2 : 1)];
	const e = text[i + 1];

	if (e === 'u')
		return [parseInt(text.slice(i + 2, i + 6), 16), i + 6];
	if (e === 'U')
		return [parseInt(text.slice(i + 2, i + 10), 16), i + 10];
	if (e === 'x' && text[i + 2] === '{') {
		const end = text.indexOf('}', i);

		return [parseInt(text.slice(i + 3, end), 16), end + 1];
	}
	return [text.codePointAt(i + 1), i + 2];
}

// parse the set at text[i]; returns [set, next index]
function parseSet(text, i, ucd, vars) {
	const skip = () => {
		while (i < text.length && /\s/.test(text[i]))
			i++;
	};

	if (text.startsWith('[:', i) || text.startsWith('\\p{', i) ||
	    text.startsWith('\\P{', i)) {
		const posix = text[i] === '[', end = text.indexOf(posix ? ':]' : '}', i);
		let body = text.slice(i + (posix ? 2 : 3), end).trim();
		let neg = text[i + 1] === 'P';

		if (posix && body[0] === '^') {
			neg = true;
			body = body.slice(1);
		}
		const eq = body.indexOf('=');
		const s = newSet();

		s.bits = eq < 0 ? propertySet(ucd, body.trim()) :
			propertySet(ucd, body.slice(0, eq).trim(), body.slice(eq + 1).trim());
		if (neg)
			for (let c = 0; c < N; c++)
				s.bits[c] ^= 1;
		return [s, end + (posix ? 2 : 1)];
	}
	if (text[i] === '$') {
		const m = /^\$[A-Za-z0-9_]+/.exec(text.slice(i));
		const v = vars.get(m[0].slice(1));

		if (!v || v.kind !== 'set')
			throw new Error('not a set: ' + m[0]);
		const s = newSet();

		setOp(s, '|', v.set);
		return [s, i + m[0].length];
	}
	if (text[i] !== '[')
		throw new Error('set expected at ' + text.slice(i, i + 20));
	i++;
	skip();
	let neg = false;

	if (text[i] === '^') {
		neg = true;
		i++;
	}
	const acc = newSet();
	let op = null, lastChar = -1;

	for (;;) {
		skip();
		if (i >= text.length)
			throw new Error('unterminated set');
		const ch = text[i];

		if (ch === ']') {
			i++;
			break;
		}
		if (ch === '[' || ch === '$' || text.startsWith('\\p{', i) ||
		    text.startsWith('\\P{', i)) {
			const [s, j] = parseSet(text, i, ucd, vars);

			setOp(acc, op === '-' || op === '&' ? op : '|', s);
			op = null;
			lastChar = -1;
			i = j;
			continue;
		}
		if (ch === '{') {
			const end = text.indexOf('}', i);

			acc.strings.add(text.slice(i + 1, end));
			i = end + 1;
			continue;
		}
		if ((ch === '-' || ch === '&') && lastChar < 0) {
			op = ch;
			i++;
			continue;
		}
		if (ch === '-' && lastChar >= 0) {
			i++;
			skip();
			const [hi, j] = charAt(text, i);

			acc.bits.fill(1, lastChar, hi + 1);
			lastChar = -1;
			i = j;
			continue;
		}
		const [c, j] = charAt(text, i);

		acc.bits[c] = 1;
		lastChar = c;
		i = j;
	}
	if (neg)
		for (let c = 0; c < N; c++)
			acc.bits[c] ^= 1;
	return [acc, i];
}

// ---- the rule language ----

// the text of a set expression starting at text[i]
function setExtent(text, i) {
	if (text[i] === '\\') {
		const end = text.indexOf('}', i);

		return end + 1;
	}
	let depth = 0;

	for (; i < text.length; i++) {
		if (text[i] === '\\') {
			i++;
			continue;
		}
		if (text[i] === '[')
			depth++;
		else if (text[i] === ']' && --depth === 0)
			return i + 1;
	}
	throw new Error('unterminated set');
}

function parseRuleFile(text, ucd) {
	const src = text.replace(/^\uFEFF/, '').split('\n')
		.map(l => l.replace(/\r$/, '').replace(/#.*$/, '')).join('\n');
	const vars = new Map(), usets = [], usetByKey = new Map(), rules = [];
	let chain = false, ruleNum = 0;

	// a set as a term of an expression: the uset it stands for, made once
	// per distinct text, as ICU's findSetFor does
	function uset(key, set, name) {
		let u = usetByKey.get(key);

		if (u === undefined) {
			u = usets.length;
			usets.push({ set, name, key });
			usetByKey.set(key, u);
		}
		return u;
	}

	function parseExpr(s, pos, num) {
		let i = pos;
		const skip = () => {
			while (i < s.length && /\s/.test(s[i]))
				i++;
		};

		function primary() {
			skip();
			const ch = s[i];

			if (ch === '(') {
				i++;
				const e = alt();

				skip();
				if (s[i] !== ')')
					throw new Error(') expected');
				i++;
				return e;
			}
			if (ch === '[' || (ch === '\\' && /[pP]/.test(s[i + 1]))) {
				const end = setExtent(s, i), t = s.slice(i, end);
				const [set] = parseSet(t, 0, ucd, vars);

				i = end;
				return { t: 'set', u: uset(t, set) };
			}
			if (ch === '$') {
				const m = /^\$[A-Za-z0-9_]+/.exec(s.slice(i));

				i += m[0].length;
				if (!vars.has(m[0].slice(1)))
					throw new Error('undefined ' + m[0]);
				return { t: 'var', name: m[0].slice(1) };
			}
			if (ch === '.') {
				i++;
				const set = newSet();

				set.bits.fill(1);
				return { t: 'set', u: uset('<any>', set) };
			}
			if (ch === '{') {
				const end = s.indexOf('}', i);
				const v = parseInt(s.slice(i + 1, end), 10);

				i = end + 1;
				return { t: 'tag', v };
			}
			if (ch === '/') {
				i++;
				return { t: 'la', rule: num };
			}
			if (ch === '\'') {
				const end = s.indexOf('\'', i + 1);
				const lit = s.slice(i + 1, end);
				let e = null;

				i = end + 1;
				for (const c of lit) {
					const set = newSet();

					set.bits[c.codePointAt(0)] = 1;
					const leaf = { t: 'set', u: uset('\'' + c, set) };

					e = e ? { t: 'cat', a: e, b: leaf } : leaf;
				}
				return e;
			}
			throw new Error('unexpected ' + s.slice(i, i + 20));
		}
		function postfix() {
			let e = primary();

			for (;;) {
				skip();
				const ch = s[i];

				if (ch === '*' || ch === '+' || ch === '?') {
					e = { t: ch === '*' ? 'star' : ch === '+' ? 'plus' : 'q', a: e };
					i++;
				} else {
					return e;
				}
			}
		}
		function cat() {
			let e = postfix();

			for (;;) {
				skip();
				if (i >= s.length || s[i] === '|' || s[i] === ')')
					return e;
				e = { t: 'cat', a: e, b: postfix() };
			}
		}
		function alt() {
			let e = cat();

			for (;;) {
				skip();
				if (s[i] !== '|')
					return e;
				i++;
				e = { t: 'or', a: e, b: cat() };
			}
		}
		const e = alt();

		skip();
		if (i < s.length)
			throw new Error('trailing ' + s.slice(i, i + 20));
		return e;
	}

	// statements end at a ';' outside a set or quotes
	const stmts = [];
	let start = 0;

	for (let i = 0; i < src.length; i++) {
		const ch = src[i];

		if (ch === '\\') {
			i++;
		} else if (ch === '[') {
			i = setExtent(src, i) - 1;
		} else if (ch === '\'') {
			i = src.indexOf('\'', i + 1);
		} else if (ch === ';') {
			stmts.push(src.slice(start, i).trim());
			start = i + 1;
		}
	}
	for (const st of stmts) {
		if (!st)
			continue;
		if (st.startsWith('!!')) {
			if (st === '!!chain')
				chain = true;
			continue;
		}
		ruleNum++;
		const asg = /^\$([A-Za-z0-9_]+)\s*=\s*([\s\S]*)$/.exec(st);

		if (asg) {
			const rhs = asg[2].trim();
			let isSet = false;

			if (rhs[0] === '[' || rhs.startsWith('\\p') || rhs.startsWith('\\P'))
				isSet = setExtent(rhs, 0) === rhs.length;
			if (isSet) {
				const [set] = parseSet(rhs, 0, ucd, vars);

				uset(rhs, set, asg[1]);
				vars.set(asg[1], { kind: 'set', set,
					ast: { t: 'set', u: usetByKey.get(rhs) } });
			} else {
				vars.set(asg[1], { kind: 'expr', ast: parseExpr(rhs, 0, ruleNum) });
			}
			continue;
		}
		const noChain = st[0] === '^';
		const ast = parseExpr(noChain ? st.slice(1) : st, 0, ruleNum);

		rules.push({ ast, chainIn: chain && !noChain, num: ruleNum,
			lookahead: hasNode(ast, 'la', vars) });
	}
	return { rules, usets, vars, chain };
}

function hasNode(n, t, vars) {
	if (!n)
		return false;
	if (n.t === t)
		return true;
	if (n.t === 'var')
		return hasNode(vars.get(n.name).ast, t, vars);
	return hasNode(n.a, t, vars) || hasNode(n.b, t, vars);
}

// ---- categories ----

// group code points by the usets they are in, numbering the groups as
// ICU does: 3 up in code point order, the dictionary's after the rest
function categories(usets) {
	let group = new Int32Array(N), count = 1;

	for (const u of usets) {
		const map = new Map(), bits = u.set.bits;
		const next = new Int32Array(N);

		count = 0;
		for (let c = 0; c < N; c++) {
			const k = group[c] * 2 + bits[c];
			let g = map.get(k);

			if (g === undefined)
				map.set(k, g = count++);
			next[c] = g;
		}
		group = next;
	}
	const dictUset = usets.findIndex(u => u.name === 'dictionary');
	const isDict = new Uint8Array(count), first = [];
	const seen = new Uint8Array(count);

	for (let c = 0; c < N; c++) {
		const g = group[c];

		if (!seen[g]) {
			seen[g] = 1;
			first.push(g);
		}
		if (dictUset >= 0 && usets[dictUset].set.bits[c])
			isDict[g] = 1;
	}
	const cat = new Int32Array(count);
	let n = 3;

	for (const g of first)
		if (!isDict[g])
			cat[g] = n++;
	const dictStart = n;

	for (const g of first)
		if (isDict[g])
			cat[g] = n++;
	const ofCp = new Int32Array(N);

	for (let c = 0; c < N; c++)
		ofCp[c] = cat[group[c]];
	// each uset's categories
	for (const u of usets) {
		const cats = new Set();

		for (let c = 0; c < N; c++)
			if (u.set.bits[c])
				cats.add(ofCp[c]);
		u.cats = [...cats].sort((a, b) => a - b);
		if (u.set.strings.has('eof'))
			u.cats.unshift(1);
		if (u.set.strings.has('bof'))
			u.cats.splice(u.cats[0] === 1 ? 1 : 0, 0, 2);
	}
	return { ofCp, count: n, dictStart };
}

// ---- the state table ----

function compile(file, ucd) {
	const parsed = parseRuleFile(fs.readFileSync(file, 'utf8'), ucd);
	const { usets, vars } = parsed;
	const cats = categories(usets);
	const leaves = [];
	let bofUsed = false;

	// a fresh copy of an expression, its sets made into ORs of leaves, one
	// per category, as RBBINode::flattenVariables and flattenSets make them
	function build(n) {
		switch (n.t) {
		case 'var':
			return build(vars.get(n.name).ast);
		case 'set': {
			let e = null;

			for (const c of usets[n.u].cats) {
				const leaf = { t: 'leaf', cat: c };

				if (c === 2)
					bofUsed = true;
				leaves.push(leaf);
				e = e ? { t: 'or', a: e, b: leaf } : leaf;
			}
			if (!e)
				throw new Error('empty set: ' + usets[n.u].key);
			e.fromSet = true;
			return e;
		}
		case 'tag':
			return { t: 'tag', v: n.v };
		case 'la':
			return { t: 'la', rule: n.rule };
		default:
			return { t: n.t, a: build(n.a), b: n.b && build(n.b) };
		}
	}
	let tree = null;

	for (const r of parsed.rules) {
		let e = build(r.ast);

		if (r.lookahead)
			e = { t: 'cat', a: e, b: { t: 'end', v: r.num } };
		// a rule that is a set alone loses its root mark in ICU when
		// the set is flattened, so nothing chains into it
		if (!e.fromSet) {
			e.root = true;
			e.chainIn = r.chainIn;
		}
		tree = tree ? { t: 'or', a: tree, b: e } : e;
	}
	let bofLeaf = null, rulesTree = tree;

	if (bofUsed) {
		bofLeaf = { t: 'leaf', cat: 2 };
		leaves.push(bofLeaf);
		tree = { t: 'cat', a: bofLeaf, b: tree };
	}
	const endMark = { t: 'end', v: 0 };

	tree = { t: 'cat', a: tree, b: endMark };

	// positions: leaves, tags, look-ahead marks and end marks
	let ids = 0;
	const positions = [];

	(function number(n) {
		if (!n)
			return;
		if (n.t === 'leaf' || n.t === 'tag' || n.t === 'la' || n.t === 'end') {
			n.id = ids++;
			positions.push(n);
			n.follow = new Set();
			return;
		}
		number(n.a);
		number(n.b);
	})(tree);

	(function calc(n) {
		if (!n)
			return;
		calc(n.a);
		calc(n.b);
		switch (n.t) {
		case 'leaf': case 'end':
			n.nullable = false;
			n.first = n.last = [n];
			break;
		case 'tag': case 'la':
			n.nullable = true;
			n.first = n.last = [n];
			break;
		case 'or':
			n.nullable = n.a.nullable || n.b.nullable;
			n.first = n.a.first.concat(n.b.first);
			n.last = n.a.last.concat(n.b.last);
			break;
		case 'cat':
			n.nullable = n.a.nullable && n.b.nullable;
			n.first = n.a.nullable ? n.a.first.concat(n.b.first) : n.a.first;
			n.last = n.b.nullable ? n.b.last.concat(n.a.last) : n.b.last;
			for (const p of n.a.last)
				for (const q of n.b.first)
					p.follow.add(q);
			break;
		case 'star': case 'q': case 'plus':
			n.nullable = n.t !== 'plus';
			n.first = n.a.first;
			n.last = n.a.last;
			if (n.t !== 'q')
				for (const p of n.last)
					for (const q of n.first)
						p.follow.add(q);
			break;
		}
	})(tree);

	if (parsed.chain) {
		const starts = [];

		(function roots(n) {
			if (!n)
				return;
			if (n.root) {
				if (n.chainIn)
					starts.push(...n.first);
				return;
			}
			roots(n.a);
			roots(n.b);
		})(rulesTree);
		for (const end of leaves) {
			if (!end.follow.has(endMark))
				continue;
			for (const st of starts)
				if (st.t === 'leaf' && st.cat === end.cat)
					for (const q of st.follow)
						end.follow.add(q);
		}
	}
	if (bofLeaf)
		for (const st of rulesTree.first)
			if (st.t === 'leaf' && st.cat === 2)
				for (const q of st.follow)
					bofLeaf.follow.add(q);

	// the DFA
	const key = set => [...set].map(p => p.id).sort((a, b) => a - b).join(',');
	const states = [{ pos: new Set(), next: new Int32Array(cats.count) }];
	const byKey = new Map([['', 0]]);
	const init = new Set(tree.first);

	states.push({ pos: init, next: new Int32Array(cats.count) });
	byKey.set(key(init), 1);
	for (let s = 1; s < states.length; s++) {
		const T = states[s];

		for (let a = 1; a < cats.count; a++) {
			const U = new Set();

			for (const p of T.pos)
				if (p.t === 'leaf' && p.cat === a)
					for (const q of p.follow)
						U.add(q);
			if (!U.size)
				continue;
			const k = key(U);
			let u = byKey.get(k);

			if (u === undefined) {
				u = states.length;
				states.push({ pos: U, next: new Int32Array(cats.count) });
				byKey.set(k, u);
			}
			T.next[a] = u;
		}
	}

	// look-ahead slots, accepting states, tags
	const laMap = new Map();
	let slots = 1;

	for (const st of states) {
		const las = [...st.pos].filter(p => p.t === 'la');

		if (!las.length)
			continue;
		let slot = 0;

		for (const p of las)
			if (laMap.has(p.rule))
				slot = slot || laMap.get(p.rule);
		if (!slot)
			slot = ++slots;
		for (const p of las)
			laMap.set(p.rule, slot);
	}
	const ends = positions.filter(p => p.t === 'end');

	for (const st of states) {
		st.acc = 0;
		st.la = 0;
		st.tag = 0;
		for (const e of ends) {
			if (!st.pos.has(e))
				continue;
			if (st.acc === 0)
				st.acc = laMap.get(e.v) || 1;
			if (st.acc === 1 && e.v !== 0)
				st.acc = laMap.get(e.v);
		}
		for (const p of st.pos) {
			if (p.t === 'la')
				st.la = laMap.get(p.rule);
			if (p.t === 'tag')
				st.tag = Math.max(st.tag, p.v);
		}
	}

	// code points as runs of one category
	const runs = [];

	for (let c = 0; c < N; c++)
		if (c === 0 || cats.ofCp[c] !== cats.ofCp[c - 1])
			runs.push(c, cats.ofCp[c]);
	return {
		cats: runs, ncat: cats.count, dict: cats.dictStart, bof: bofUsed,
		next: states.flatMap(s => Array.from(s.next)),
		acc: states.map(s => s.acc), la: states.map(s => s.la),
		tag: states.map(s => s.tag), slots: slots + 1
	};
}

// ---- dictionaries ----

const DICTS = { thai: ['thaidict', 0x0e00], lao: ['laodict', 0x0e80],
	khmer: ['khmerdict', 0x1780], burmese: ['burmesedict', 0x1000],
	cj: ['cjdict', -1] };

function readDictionary(file) {
	const words = [];

	for (let line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
		.split(/\r?\n/)) {
		line = line.replace(/#.*$/, '').replace(/\s+$/, '');
		if (!line)
			continue;
		const m = /^(\S+)(?:\s+(\S+))?$/.exec(line);

		words.push([m[1], m[2] === undefined ? 0 : +m[2]]);
	}
	// code unit order, as JS compares strings
	return words.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

// a chunk's words, sorted, a line each, after its cost as a character
// (0x20 + cost) where the dictionary has costs: searched as it is, with
// nothing to decode
function dictionaryChunks(name, words) {
	const chunks = {};

	for (const [w, v] of words) {
		const b = (w.codePointAt(0) >> 8).toString(16).toUpperCase();

		(chunks[b] = chunks[b] || []).push([w, v]);
	}
	const out = {};

	for (const b in chunks)
		out['g:d:' + name + ':' + b] = chunks[b].map(([w, v]) =>
			(name === 'cj' ? String.fromCharCode(0x20 + v) : '') + w + '\n').join('');
	return out;
}

// ---- the entries ----

function ranges(bits) {
	const out = [];

	for (let c = 0; c < N; c++)
		if (bits[c] && (c === 0 || !bits[c - 1]))
			out.push(c);
		else if (!bits[c] && c > 0 && bits[c - 1])
			out.push(c);
	if (bits[N - 1])
		out.push(N);
	return out;
}

function set(ucd, pattern) {
	return parseSet(pattern, 0, ucd, new Map())[0].bits;
}

export function segmenterEntries(icuDir, tags) {
	const ucd = loadUcd(path.join(icuDir, 'unidata', 'ppucd.txt'));
	const rulesDir = path.join(icuDir, 'brkitr', 'rules');
	const entries = {};

	for (const r of ['char', 'word', 'word_POSIX', 'sent', 'sent_el'])
		entries['g:r:' + r] = compile(path.join(rulesDir, r + '.txt'), ucd);

	// the dictionary engines' sets, as dictbe.cpp makes them
	const engine = (script, begin, end, extra) => {
		const word = set(ucd, '[[:' + script + ':]&[:LineBreak=SA:]]');
		const mark = set(ucd, '[[:' + script + ':]&[:LineBreak=SA:]&[:M:]]');

		mark[0x20] = 1;
		const endSet = word.slice(), beginSet = new Uint8Array(N);

		for (const [lo, hi] of end)
			endSet.fill(0, lo, hi + 1);
		for (const [lo, hi] of begin)
			beginSet.fill(1, lo, hi + 1);
		return Object.assign({ set: ranges(word), mark: ranges(mark),
			end: ranges(endSet), begin: ranges(beginSet) }, extra);
	};
	const cj = set(ucd, '[[:Han:][:Hiragana:][:Katakana:]\\u30fc\\uff70\\uff9e\\uff9f]');

	// the CJ characters NFKC has no boundary before (Normalizer2's
	// hasBoundaryBefore): combining, combining backwards, or decomposing
	// to a character that is
	const ccc0 = ucd.ids.ccc.get('0'), qcM = ucd.ids.NFKC_QC.get('M');
	const inert = c => ucd.arr.ccc[c] === ccc0 && ucd.arr.NFKC_QC[c] !== qcM;
	const noBoundary = new Uint8Array(N);

	for (let c = 0; c < N; c++)
		if (cj[c] && !(inert(c) &&
		    inert(String.fromCodePoint(c).normalize('NFKD').codePointAt(0))))
			noBoundary[c] = 1;
	// the scripts of characters the word rules hand to the dictionaries
	// that have no engine, which ICU then skips by script
	const word = entries['g:r:word'];
	const dictCp = new Uint8Array(N);

	for (let i = 0; i < word.cats.length; i += 2)
		if (word.cats[i + 1] >= word.dict)
			dictCp.fill(1, word.cats[i], i + 2 < word.cats.length ? word.cats[i + 2] : N);
	const engineCp = new Uint8Array(N);

	for (const s of ['Thai', 'Laoo', 'Khmr', 'Mymr'])
		set(ucd, '[[:' + s + ':]&[:LineBreak=SA:]]').forEach((v, c) => {
			if (v)
				engineCp[c] = 1;
		});
	// ICU makes an engine for a character by its script, so CJ's engine
	// is not made for the four Common characters it also takes
	const cjScripts = set(ucd, '[[:Han:][:Hiragana:][:Katakana:]]');

	cj.forEach((v, c) => {
		if (v && cjScripts[c])
			engineCp[c] = 1;
		else if (v && [0x30fc, 0xff70, 0xff9e, 0xff9f].indexOf(c) < 0)
			throw new Error('unexpected CJ character ' + c.toString(16));
	});
	const scripts = new Set();

	for (let c = 0; c < N; c++)
		if (dictCp[c] && !engineCp[c])
			scripts.add(ucd.arr.sc[c]);
	const scriptRuns = [];

	for (let c = 0; c < N; c++) {
		const s = scripts.has(ucd.arr.sc[c]) ? ucd.arr.sc[c] + 1 : 0;

		if (c === 0 || s !== (scripts.has(ucd.arr.sc[c - 1]) ? ucd.arr.sc[c - 1] + 1 : 0))
			scriptRuns.push(c, s);
	}
	entries['g:meta'] = {
		rules: { grapheme: 'char', word: 'word', sentence: 'sent' },
		locales: { el: { sentence: 'sent_el' },
			'en-US-POSIX': { word: 'word_POSIX' } },
		engines: {
			thai: engine('Thai', [[0x0e01, 0x0e2e], [0x0e40, 0x0e44]],
				[[0x0e31, 0x0e31], [0x0e40, 0x0e44]], { suffix: true }),
			lao: engine('Laoo', [[0x0e81, 0x0eae], [0x0edc, 0x0edd],
				[0x0ec0, 0x0ec4]], [[0x0ec0, 0x0ec4]]),
			burmese: engine('Mymr', [[0x1000, 0x102a]], []),
			khmer: engine('Khmr', [[0x1780, 0x17b3]], [[0x17d2, 0x17d2]]),
			cj: { set: ranges(cj), nb: ranges(noBoundary) }
		},
		offsets: Object.fromEntries(Object.entries(DICTS)
			.filter(([, d]) => d[1] >= 0).map(([k, d]) => [k, d[1]])),
		// the script runs of the scripts a character without an engine
		// can have, [start, script + 1 or 0, ...]
		scripts: scriptRuns
	};
	for (const [name, [file]] of Object.entries(DICTS))
		Object.assign(entries, dictionaryChunks(name, readDictionary(
			path.join(icuDir, 'brkitr', 'dictionaries', file + '.txt'))));
	// the locales Segmenter offers, as ICU's: its main locales
	if (tags) {
		const icuTags = fs.readdirSync(path.join(icuDir, 'locales'))
			.filter(f => /^[a-z].*\.txt$/.test(f) && !/^(root|pool|res_index)\.txt$/.test(f))
			.map(f => f.slice(0, -4).replace(/_/g, '-')).filter(t => {
				try {
					return new Intl.Segmenter(t).resolvedOptions().locale === t;
				} catch (e) {
					return false;
				}
			});

		entries['g:meta'].noseg = tags.filter(t =>
			new Intl.Segmenter(t).resolvedOptions().locale !== t);
		entries['g:meta'].seg = icuTags.filter(t => tags.indexOf(t) < 0);
	}
	return entries;
}

if (import.meta.url === 'file://' + process.argv[1]) {
	const e = segmenterEntries(process.argv[2]);

	for (const k of Object.keys(e).filter(k => k.startsWith('g:r:')))
		console.log(k, 'categories', e[k].ncat, 'dict from', e[k].dict,
			'states', e[k].acc.length, 'runs', e[k].cats.length / 2,
			'bof', e[k].bof, 'slots', e[k].slots);
	console.log('chunks', Object.keys(e).filter(k => k.startsWith('g:d:')).length);
	if (process.argv[3])
		fs.writeFileSync(process.argv[3], JSON.stringify(e));
}
