#!/usr/bin/env python3
"""Write every workflow `run:` block to a temp file and print the paths, one per line.

Companion to `workflow-run-blocks.test.sh` (review, #356). Deliberately does NOT import PyYAML — CI
runners have python3 but not necessarily that package, and adding a dependency to a guard whose whole
job is to be cheap and always-run would undermine it.

Block scalars are handled by INDENTATION, which is what YAML actually specifies: the body of a `run: |`
continues while lines are blank or indented deeper than the `run:` key itself. Getting that wrong would
silently truncate a block and check nothing, which is the failure mode this guard exists to prevent — so
the script prints how many blocks it found and the shell wrapper reports that count.

Only `run:` blocks that are shell are emitted. A step with `shell: python` or similar would be a false
positive; none exist today, and one appearing without this being updated is a loud failure (a python
body will not parse as bash) rather than a silent one.
"""
import os
import re
import sys
import tempfile

WORKFLOWS = os.path.join(".github", "workflows")
RUN_KEY = re.compile(r"^(\s*)-?\s*run:\s*(\|[-+]?|>[-+]?)?\s*(.*)$")


def blocks(path):
    """Yield (line_number, body) for each `run:` block in one workflow file."""
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    i = 0
    while i < len(lines):
        m = RUN_KEY.match(lines[i])
        if not m:
            i += 1
            continue
        indent, style, inline = m.group(1), m.group(2), m.group(3)
        start = i + 1
        if not style:
            # `run: some-command` on one line. Skip empties and anything that is only a GitHub
            # expression (nothing for bash to parse).
            if inline.strip():
                yield start, inline
            i += 1
            continue

        key_indent = len(indent)
        body, i = [], i + 1
        while i < len(lines):
            line = lines[i]
            if line.strip() and (len(line) - len(line.lstrip())) <= key_indent:
                break
            body.append(line)
            i += 1
        # Strip the common leading indentation so the body is valid standalone shell.
        real = [ln for ln in body if ln.strip()]
        if real:
            pad = min(len(ln) - len(ln.lstrip()) for ln in real)
            body = [ln[pad:] if len(ln) >= pad else ln for ln in body]
        yield start, "\n".join(body)


def main():
    # LF regardless of platform: on Windows `print()` emits CRLF, and the consuming shell then reads a
    # path with a trailing \r that cannot be stat'd — every block silently skipped. The wrapper's
    # minimum-block floor catches it, but a guard that only works on CI is half a guard.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(newline="\n")
    if not os.path.isdir(WORKFLOWS):
        print(f"no {WORKFLOWS} directory", file=sys.stderr)
        return 1
    tmp = tempfile.mkdtemp(prefix="wf-run-blocks-")
    n = 0
    for name in sorted(os.listdir(WORKFLOWS)):
        if not name.endswith((".yml", ".yaml")):
            continue
        path = os.path.join(WORKFLOWS, name)
        for lineno, body in blocks(path):
            if not body.strip():
                continue
            n += 1
            out = os.path.join(tmp, f"block-{n:03d}.sh")
            with open(out, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(body + "\n")
            with open(out + ".label", "w", encoding="utf-8", newline="\n") as fh:
                fh.write(f"{name}:{lineno}\n")
            # Forward slashes so the consuming shell can stat these on Git Bash as well as on CI.
            # Windows-style paths made the wrapper skip every block silently — caught only because the
            # wrapper has a minimum-block floor, which is precisely why it has one.
            print(out.replace(os.sep, "/"))
    if n == 0:
        print("extracted ZERO run-blocks — the extractor is broken, not the workflows", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
