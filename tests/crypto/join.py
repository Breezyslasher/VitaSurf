# Reassemble the numbered "RES nnnn chunk" lines gen.html prints into vec.js
import sys, re
parts = {}
for line in sys.stdin:
    m = re.search(r'RES (\d{4}) (.*)$', line.rstrip('\n'))
    if m:
        parts[int(m.group(1))] = m.group(2)
sys.stdout.write('window.VEC = ' + ''.join(parts[k] for k in sorted(parts)) + ';\n')
