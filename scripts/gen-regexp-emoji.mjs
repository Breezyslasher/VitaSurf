// Writes deps/libquickjs/libregexp-emoji.h: the properties of strings a
// RegExp with the v flag may name (\p{RGI_Emoji} and the six it is the
// union of), from the @unicode/unicode-<version> npm package
// (VitaSurf). Its version must be the Unicode version of QuickJS's own
// tables (deps/libquickjs/unicode_download.sh).
//
//   node scripts/gen-regexp-emoji.mjs path/to/package/Sequence_Property 17.0.0
//
// Each property is its single code points, as ranges, and its strings
// of more than one: a length byte, then each code point in three bytes.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.argv[2] || '');
const version = process.argv[3] || '?';
const props = ['Basic_Emoji', 'Emoji_Keycap_Sequence', 'RGI_Emoji_Flag_Sequence',
  'RGI_Emoji_Modifier_Sequence', 'RGI_Emoji_Tag_Sequence', 'RGI_Emoji_ZWJ_Sequence'];

let out = `/* Properties of strings for RegExp's v flag (VitaSurf): Unicode ${version},
   written by scripts/gen-regexp-emoji.mjs from the @unicode/unicode-${version}
   package. RGI_Emoji is the union of these. Do not edit. */

`;
const all = new Set(), lens = {};
for (const p of props) {
  const list = (await import(dir + '/' + p + '/index.mjs')).default;
  const singles = [], strings = [];
  for (const s of list) {
    const cps = [...s].map((c) => c.codePointAt(0));
    if (cps.length === 1) singles.push(cps[0]);
    else strings.push(cps);
    all.add(s);
  }
  singles.sort((a, b) => a - b);
  const ranges = [];
  for (const c of singles) {
    if (ranges.length && ranges[ranges.length - 1] === c) ranges[ranges.length - 1] = c + 1;
    else ranges.push(c, c + 1);
  }
  const bytes = [];
  for (const cps of strings) {
    if (cps.length > 255) throw new Error('string too long');
    bytes.push(cps.length);
    for (const c of cps) bytes.push(c >> 16, (c >> 8) & 255, c & 255);
  }
  const wrap = (a, f) => {
    let s = '', line = '   ';
    for (const v of a) {
      const t = ' ' + f(v) + ',';
      if (line.length + t.length > 78) { s += line + '\n'; line = '   '; }
      line += t;
    }
    return s + line + '\n';
  };
  lens[p] = [ranges.length, bytes.length];
  out += `static const uint32_t lre_sp_${p}_ranges[${Math.max(ranges.length, 1)}] = {\n` +
    (ranges.length ? wrap(ranges, (v) => '0x' + v.toString(16)) : '    0\n') + '};\n';
  out += `static const uint8_t lre_sp_${p}_strings[${Math.max(bytes.length, 1)}] = {\n` +
    (bytes.length ? wrap(bytes, (v) => String(v)) : '    0\n') + '};\n\n';
}
out += `typedef struct {
    const char *name;
    const uint32_t *ranges;
    int range_len;
    const uint8_t *strings;
    int strings_len;
} LREStringProperty;

static const LREStringProperty lre_string_props[] = {
`;
for (const p of props) {
  out += `    { "${p}", lre_sp_${p}_ranges, ${lens[p][0]},\n` +
    `      lre_sp_${p}_strings, ${lens[p][1]} },\n`;
}
out += `};
/* ${all.size} sequences in RGI_Emoji */
`;
writeFileSync(new URL('../deps/libquickjs/libregexp-emoji.h', import.meta.url), out);
console.log('wrote libregexp-emoji.h:', all.size, 'sequences');
