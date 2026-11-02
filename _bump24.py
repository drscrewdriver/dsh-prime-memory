import io
import json
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

sec = io.open('_sec24.txt', encoding='utf-8').read().rstrip('\n')
p = 'CHANGELOG.md'
before = io.open(p, encoding='utf-8').read()
assert '## [0.26.24]' not in before
lines = before.split('\n')
lines.insert(1, '')
lines.insert(2, sec)
io.open(p, 'w', encoding='utf-8', newline='').write('\n'.join(lines))
os_remove = None
io.open('_sec24.txt', 'w', encoding='utf-8').write('')

d = subprocess.run(['git', 'diff', '--numstat', '--', 'CHANGELOG.md'], capture_output=True, text=True).stdout.split()
print('CHANGELOG numstat: +%s -%s  (必须删侧为 0)' % (d[0], d[1]))
assert d[1] == '0', 'changelog must be pure addition'

for f in ('package.json', 'dsh.plugin.json'):
    t = io.open(f, encoding='utf-8').read()
    assert t.count('"version": "0.26.23"') == 1, f
    io.open(f, 'w', encoding='utf-8', newline='').write(t.replace('"version": "0.26.23"', '"version": "0.26.24"', 1))
    print('bumped', f, '->', json.loads(io.open(f, encoding='utf-8').read())['version'])

k = subprocess.run('npm pack', shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
print('pack:', [l for l in (k.stdout + k.stderr).splitlines() if l.strip().endswith('.tgz')][-1:])

r = subprocess.run(['git', 'add', '-A'], capture_output=True, text=True)
msg = ('fix(#20): bound the facade-retry window and fall back to our own read-only store '
       '(0.26.23 could wedge the read path forever when no one activates collector in-process)')
c = subprocess.run(['git', 'commit', '-q', '-m', msg], capture_output=True, text=True, encoding='utf-8', errors='replace')
print('commit rc=', c.returncode, (c.stdout + c.stderr).strip()[:80])
t = subprocess.run(['git', 'tag', 'v0.26.24'], capture_output=True, text=True)
t2 = subprocess.run(['git', 'push', 'origin', 'main', 'v0.26.24'], capture_output=True, text=True, encoding='utf-8', errors='replace')
print('push:', [l.strip() for l in (t2.stdout + t2.stderr).splitlines() if '->' in l][:3])

pub = subprocess.run('npm publish dsh-prime-memory-0.26.24.tgz --tag latest --registry=https://registry.npmjs.org',
                     shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
print('publish rc=', pub.returncode, [l.strip() for l in (pub.stdout + pub.stderr).splitlines() if '+ dsh' in l or 'error' in l][:2])
dt = subprocess.run('npm dist-tag add dsh-prime-memory@0.26.24 dsh-0.2.1-rc.5 --registry=https://registry.npmjs.org',
                    shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
print('dist-tag:', [l.strip() for l in (dt.stdout + dt.stderr).splitlines() if 'dsh-0.2.1-rc.5' in l][-1:])

notes = '_notes24.md'
ls = io.open('CHANGELOG.md', encoding='utf-8').read().splitlines()
i = next(x for x, l in enumerate(ls) if l.startswith('## [0.26.24]'))
j = next(x for x, l in enumerate(ls) if l.startswith('## [0.26.23]'))
io.open(notes, 'w', encoding='utf-8', newline='').write('\n'.join(ls[i + 1:j]).strip() + '\n')
g = subprocess.run(['gh', 'release', 'create', 'v0.26.24', '--title', 'v0.26.24 \u2014 \u95e8\u9762\u91cd\u8bd5\u6536\u655b\u4e3a\u6709\u754c', '--notes-file', notes],
                   capture_output=True, text=True, encoding='utf-8', errors='replace')
print('gh release rc=', g.returncode, (g.stdout or g.stderr).strip()[:60])
io.remove(notes)
io.remove('_sec24.txt')
