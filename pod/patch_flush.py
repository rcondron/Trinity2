#!/usr/bin/env python3
"""Add a 0x05 "flush" message to a patched PersonaPlex (moshi) server.py.

The streaming patch lets the engine queue words for the agent to say (0x03) and hold
it quiet (0x04), but queued words can't be taken back, so a long reply talks over a
caller who interrupts. 0x05 clears the queue (barge-in / mic off).

    python3 patch_flush.py /path/to/moshi/server.py

Idempotent (marker: "kind == 5"); keeps a .bak; refuses to write if the result
doesn't parse.
"""
import ast
import re
import shutil
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch_flush.py <moshi server.py>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    src = open(path, encoding="utf-8").read()
    if "kind == 5" in src:
        print(f"patch_flush: already applied to {path}")
        return 0

    # Anchor: the hold handler added by the streaming patch (its whole body: every following
    # line indented deeper than the elif).
    m = re.search(r"^(?P<indent>[ \t]*)elif kind == 4:[^\n]*\n(?P<body>(?:(?P=indent)[ \t]+[^\n]*\n)+)", src, re.M)
    if not m:
        print("patch_flush: could not find the 'elif kind == 4:' handler — apply server.patch first", file=sys.stderr)
        return 1
    indent = m.group("indent")
    body_indent = re.match(r"[ \t]*", m.group("body")).group(0)
    addition = (
        f"{indent}elif kind == 5:  # flush: drop words queued for the agent (barge-in / mic off)\n"
        f"{body_indent}forced.clear()\n"
    )
    out = src[: m.end()] + addition + src[m.end():]
    ast.parse(out)  # never write a broken server
    shutil.copyfile(path, path + ".bak")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    print(f"patch_flush: added 0x05 flush handler to {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
