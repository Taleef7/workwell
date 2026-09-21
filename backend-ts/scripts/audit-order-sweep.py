"""Every `await` that precedes an audit write in the same function, with no verb whitelist.

The first sweep matched a verb list (create|update|set|...) and therefore missed
`valueSets.link(...)` / `unlink(...)`. This one inverts the filter: find the audit write, then list
EVERY preceding await in that function, excluding only calls that are obviously reads. Noisy on
purpose — the output is for reading, and a false positive costs a glance while a false negative costs
a wrong claim in an always-loaded document.
"""
import io
import os
import re

AUDIT = re.compile(r"\b(appendAudit|recordCaseEvents?|audit)\s*\(")
AWAIT = re.compile(r"await\s+([A-Za-z_$][\w$.]*)\s*\(")
# Obvious reads. Anything not matching these is reported.
READ = re.compile(r"(^|\.)(get|list|find|load|resolve|read|count|fetch|latest|to|is|has|expand|"
                  r"select|query|build|compute|derive|parse|validate|check)[A-Z0-9_]|"
                  r"(^|\.)(get|list|find|load|resolve|read|count|fetch)$", re.I)
FUNC = re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|"
                  r"^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(")

roots = ['src']
hits = []

for root in roots:
    for dirpath, _dirs, files in os.walk(root):
        if 'node_modules' in dirpath:
            continue
        for f in files:
            if not f.endswith('.ts') or '.test.' in f:
                continue
            path = os.path.join(dirpath, f).replace('\\', '/')
            lines = io.open(path, encoding='utf-8').read().replace('\r\n', '\n').split('\n')
            fn = '(top level)'
            awaits = []
            for i, line in enumerate(lines):
                m = FUNC.match(line)
                if m:
                    fn = m.group(1) or m.group(2)
                    awaits = []
                    continue
                if AUDIT.search(line) and 'await' in line:
                    for (ln, call) in awaits:
                        if not READ.search(call):
                            hits.append((path, i + 1, fn, ln + 1, call))
                    awaits = []
                    continue
                am = AWAIT.search(line)
                if am and not AUDIT.search(line):
                    awaits.append((i, am.group(1)))

seen = set()
for path, audit_line, fn, mut_line, call in hits:
    key = (path, mut_line)
    if key in seen:
        continue
    seen.add(key)
    print('%s:%d  in %s()  `await %s(...)` precedes the audit at :%d' % (path, mut_line, fn, call, audit_line))
