#!/usr/bin/env python3
"""Teach PersonaPlex's moshi server.py to take custom voice samples from Trinity.

    python3 patch_voices.py PATH/TO/moshi/server.py            # patch (idempotent)
    python3 patch_voices.py PATH/TO/moshi/server.py --check    # exit 0 if up to date, 3 if not
    python3 patch_voices.py PATH/TO/moshi/server.py --dry-run  # print the diff, write nothing

Adds, each part only when it's missing (marker: "# trinity-voices-patch"):
  (a) the module imports the new code uses (re, secrets, hashlib, ...);
  (b) ServerState.handle_voice_upload / handle_voice_list (+ two small helpers) as one block between
      "# trinity-voices-patch:begin vN" and "# trinity-voices-patch:end" -- a block written by an
      older version of this script is replaced in place;
  (c) the routes, right after  app.router.add_get("/api/chat", state.handle_chat):
        POST /api/voices?name=<name>.wav  raw audio/wav body -> saved into the voice prompt dir
        GET  /api/voices                  -> {"voices": [filenames], "files": {name: {bytes, sha256}}}
      Both need "Authorization: Bearer $PP_ADMIN_TOKEN"; without PP_ADMIN_TOKEN in the server's
      environment they answer 403 "uploads disabled".

Safety: the patched source must parse before anything is written; the previous file is kept as
PATH.bak; writes are atomic (temp file + os.replace) and keep the file mode; a file that is already
up to date is not touched.

Exit status: 0 patched / already up to date, 1 usage or I/O error, 2 the file doesn't look like
moshi's server.py (anchor line or class missing, unparseable, conflicting edits), 3 --check: needs
patching.
"""

import ast
import difflib
import os
import re
import shutil
import sys

MARK = "# trinity-voices-patch"
BOM = chr(0xFEFF)
VERSION = 1

BEGIN_RE = re.compile(r"^(?P<indent>[ \t]*)# trinity-voices-patch:begin v(?P<version>\d+)\b")
END_RE = re.compile(r"^[ \t]*# trinity-voices-patch:end\b")
# The line the routes go after:  app.router.add_get("/api/chat", state.handle_chat)
ANCHOR_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<app>[A-Za-z_]\w*)\.router\.add_get\(\s*"
    r"(?P<q>[\"'])/api/chat(?P=q)\s*,\s*(?P<state>[A-Za-z_][\w.]*?)\.handle_chat\b",
    re.M,
)
GET_ROUTE_RE = re.compile(r"\.router\.add_get\(\s*[\"']/api/voices[\"']")
POST_ROUTE_RE = re.compile(r"\.router\.add_post\(\s*[\"']/api/voices[\"']")

HANDLERS = ("_trinity_voice_auth", "_trinity_voice_dir", "handle_voice_upload", "handle_voice_list")

# Names the handlers use, and how to import each when the module doesn't already.
NEEDED_IMPORTS = (
    ("asyncio", "import asyncio"),
    ("hashlib", "import hashlib"),
    ("os", "import os"),
    ("re", "import re"),
    ("secrets", "import secrets"),
    ("web", "from aiohttp import web"),
)

# The methods, written at method level with 4-space indents; re-indented to fit the class.
BLOCK = r'''
# trinity-voices-patch:begin v@VERSION@ -- custom voice samples for Trinity (pod/patch_voices.py; re-run it to update)
def _trinity_voice_auth(self, request):
    """None when the request carries the admin token, else the error response to send back."""
    token = os.environ.get("PP_ADMIN_TOKEN", "").strip()
    if not token:
        return web.json_response({"error": "uploads disabled: PP_ADMIN_TOKEN is not set on the voice server"}, status=403)
    header = request.headers.get("Authorization", "")
    given = header[7:].strip() if header[:7].lower() == "bearer " else ""
    if not secrets.compare_digest(given.encode("utf-8"), token.encode("utf-8")):
        return web.json_response({"error": "missing or wrong admin token"}, status=401, headers={"WWW-Authenticate": "Bearer"})
    return None

def _trinity_voice_dir(self):
    """The directory voice prompts are read from, or None when the server has none."""
    voice_dir = getattr(self, "voice_prompt_dir", None)
    return voice_dir if voice_dir and os.path.isdir(voice_dir) else None

async def handle_voice_upload(self, request):
    """POST /api/voices?name=<name>.wav with a raw audio/wav body: save it as a custom voice prompt."""
    denied = self._trinity_voice_auth(request)
    if denied is not None:
        return denied
    name = request.query.get("name", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}\.wav", name):
        return web.json_response({"error": "name must be 1-64 characters of a-z 0-9 _ - (starting with a letter or digit) plus .wav"}, status=400)
    voice_dir = self._trinity_voice_dir()
    if voice_dir is None:
        return web.json_response({"error": "the voice server has no voice prompt directory"}, status=503)
    stem = name[:-4]
    for existing in os.listdir(voice_dir):
        if existing.lower() == stem + ".pt":
            return web.json_response({"error": "%s would shadow the built-in voice %s" % (name, existing)}, status=409)
    target = os.path.join(voice_dir, name)
    if os.path.islink(target) or (os.path.lexists(target) and not os.path.isfile(target)):
        return web.json_response({"error": "%s exists and is not a regular file" % name}, status=409)
    limit = 10 * 1024 * 1024
    if request.content_length is not None and request.content_length > limit:
        return web.json_response({"error": "voice samples are limited to 10 MB"}, status=413)
    # Read the stream directly: request.read() would stop at the app's 1 MB client_max_size.
    body = bytearray()
    try:
        async for chunk in request.content.iter_chunked(1 << 16):
            body.extend(chunk)
            if len(body) > limit:
                return web.json_response({"error": "voice samples are limited to 10 MB"}, status=413)
    except ConnectionError:  # the client gave up mid-upload; nothing to save
        print("[trinity-voices] upload of %s was cut off" % name, flush=True)
        return web.json_response({"error": "the upload was cut off"}, status=400)
    data = bytes(body)
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return web.json_response({"error": "the body must be a RIFF/WAVE file"}, status=400)

    def save():
        tmp = os.path.join(voice_dir, ".%s.%d.%s.tmp" % (name, os.getpid(), secrets.token_hex(4)))
        try:
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o644)
            os.replace(tmp, target)
        finally:
            if os.path.lexists(tmp):
                os.unlink(tmp)

    try:
        await asyncio.to_thread(save)  # off the event loop: a live call shares it
    except OSError as e:
        return web.json_response({"error": "could not save %s: %s" % (name, e)}, status=500)
    lm_gen = getattr(self, "lm_gen", None)
    if lm_gen is not None and getattr(lm_gen, "voice_prompt", None) == target:
        lm_gen.voice_prompt = None  # the next session loads the new sample, not the cached one
    digest = hashlib.sha256(data).hexdigest()
    print("[trinity-voices] saved %s (%d bytes, sha256 %s)" % (name, len(data), digest[:12]), flush=True)
    return web.json_response({"ok": True, "name": name, "bytes": len(data), "sha256": digest})

async def handle_voice_list(self, request):
    """GET /api/voices: {"voices": [sorted filenames], "files": {"<name>.wav": {"bytes": n, "sha256": hex}}}."""
    denied = self._trinity_voice_auth(request)
    if denied is not None:
        return denied
    voice_dir = self._trinity_voice_dir()
    if voice_dir is None:
        return web.json_response({"error": "the voice server has no voice prompt directory"}, status=503)
    cache = getattr(self, "_trinity_voice_hashes", None)
    if cache is None:
        cache = self._trinity_voice_hashes = {}

    def scan():
        names, files = [], {}
        with os.scandir(voice_dir) as entries:
            for entry in entries:
                if entry.name.startswith(".") or not entry.is_file(follow_symlinks=False):
                    continue
                names.append(entry.name)
                if not entry.name.endswith(".wav"):
                    continue
                st = entry.stat(follow_symlinks=False)
                key = (entry.name, st.st_size, st.st_mtime_ns)
                digest = cache.get(key)
                if digest is None:
                    h = hashlib.sha256()
                    with open(entry.path, "rb") as f:
                        for block in iter(lambda: f.read(1 << 20), b""):
                            h.update(block)
                    digest = cache[key] = h.hexdigest()
                files[entry.name] = {"bytes": st.st_size, "sha256": digest}
        return sorted(names), files

    try:
        names, files = await asyncio.to_thread(scan)
    except OSError as e:
        return web.json_response({"error": "could not list the voices: %s" % e}, status=500)
    return web.json_response({"voices": names, "files": files})
# trinity-voices-patch:end
'''


class PatchError(Exception):
    """The file doesn't look like something this script knows how to patch."""


def split_lines(text):
    """Split on \\n only (what ast line numbers count), keeping each line's ending."""
    parts = text.split("\n")
    lines = [p + "\n" for p in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


def leading(line):
    return line[: len(line) - len(line.lstrip(" \t"))]


def block_lines(indent, unit, nl):
    out = []
    for raw in BLOCK.replace("@VERSION@", str(VERSION)).strip("\n").split("\n"):
        if not raw.strip():
            out.append(nl)
            continue
        body = raw.lstrip(" ")
        out.append(indent + unit * ((len(raw) - len(body)) // 4) + body + nl)
    return out


def server_state(tree):
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "ServerState":
            return node
    raise PatchError("class ServerState not found -- is this moshi's server.py?")


def method_names(cls):
    return {n.name for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}


def indent_unit(cls, lines):
    unit = leading(lines[cls.body[0].lineno - 1])[len(leading(lines[cls.lineno - 1])):]
    return unit or "    "


def missing_imports(tree):
    bound = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            bound.update(a.asname or a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            bound.update(a.asname or a.name for a in node.names)
    return [stmt for name, stmt in NEEDED_IMPORTS if name not in bound]


def import_position(tree):
    """0-based line index for new imports: before the first import that isn't from __future__."""
    for node in tree.body:
        if isinstance(node, ast.Import) or (isinstance(node, ast.ImportFrom) and node.module != "__future__"):
            return node.lineno - 1
    pos = 0  # no imports at all: after the docstring and any __future__ imports
    for node in tree.body:
        docstring = isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
        if docstring or (isinstance(node, ast.ImportFrom) and node.module == "__future__"):
            pos = node.end_lineno
            continue
        break
    return pos


def chat_route_call(node):
    """(app, state) source text if `node` is the statement  <app>.router.add_get("/api/chat", <state>.handle_chat)."""
    if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)):
        return None
    call = node.value
    f = call.func
    if not (isinstance(f, ast.Attribute) and f.attr == "add_get" and isinstance(f.value, ast.Attribute)
            and f.value.attr == "router" and isinstance(f.value.value, ast.Name)):
        return None
    kw = {k.arg: k.value for k in call.keywords if k.arg}
    path = call.args[0] if len(call.args) > 0 else kw.get("path")
    handler = call.args[1] if len(call.args) > 1 else kw.get("handler")
    if not (isinstance(path, ast.Constant) and path.value == "/api/chat"):
        return None
    if not (isinstance(handler, ast.Attribute) and handler.attr == "handle_chat"):
        return None
    return f.value.value.id, ast.unparse(handler.value)


def find_anchor(text, lines, tree):
    """Where the routes go: (indent, app, state, last line of the /api/chat route statement).

    The route line is found with ANCHOR_RE (its \\s* spans newlines, so a call split over several
    lines still matches); ast confirms it's a real statement (not a comment or string) and gives its
    last line. A call the regex can't read (keyword arguments, odd spacing) is found through ast alone.
    """
    statements = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            statements[(node.lineno, node.col_offset)] = node
    for m in ANCHOR_RE.finditer(text):
        line = text.count("\n", 0, m.start()) + 1
        node = statements.get((line, len(m.group("indent").encode("utf-8"))))
        if node is not None and chat_route_call(node) is not None:
            return m.group("indent"), m.group("app"), m.group("state"), node.end_lineno
    for (line, _col), node in sorted(statements.items()):
        found = chat_route_call(node)
        if found is not None:
            return leading(lines[line - 1]), found[0], found[1], node.end_lineno
    raise PatchError(
        'anchor not found: no line like  app.router.add_get("/api/chat", state.handle_chat)  -- '
        "moshi changed; update ANCHOR_RE in patch_voices.py"
    )


def verify(source):
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        raise PatchError("the patched file wouldn't parse (line %s: %s); nothing was written" % (e.lineno, e.msg))
    lacking = [h for h in HANDLERS if h not in method_names(server_state(tree))]
    if lacking:
        raise PatchError("after patching, ServerState still lacks %s; nothing was written" % ", ".join(lacking))
    if not (GET_ROUTE_RE.search(source) and POST_ROUTE_RE.search(source)):
        raise PatchError("after patching, the /api/voices routes are missing; nothing was written")
    if missing_imports(tree):
        raise PatchError("after patching, imports are still missing; nothing was written")


def plan(text):
    """(patched text, [what was done]) -- or (None, []) when the file is already up to date."""
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = split_lines(text)
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        raise PatchError("it doesn't parse as Python (line %s: %s); refusing to patch it" % (e.lineno, e.msg))
    cls = server_state(tree)
    unit = indent_unit(cls, lines)
    edits = []  # (first line index, lines replaced, new lines)
    done = []

    # (a) imports
    missing = missing_imports(tree)
    if missing:
        edits.append((import_position(tree), 0, ["%s  %s%s" % (stmt, MARK, nl) for stmt in missing]))
        done.append("imports: " + ", ".join(stmt.split()[-1] for stmt in missing))

    # (b) the handlers
    begins = [i for i, line in enumerate(lines) if BEGIN_RE.match(line)]
    if len(begins) > 1:
        raise PatchError("found %d copies of the voice handlers; restore the .bak or reinstall moshi" % len(begins))
    if begins:
        b = begins[0]
        m = BEGIN_RE.match(lines[b])
        e = next((i for i in range(b + 1, len(lines)) if END_RE.match(lines[i])), None)
        if e is None:
            raise PatchError("the voice handlers' begin marker (line %d) has no end marker; restore the .bak" % (b + 1))
        if not cls.lineno <= b + 1 <= cls.end_lineno:
            raise PatchError("the voice handlers (line %d) are outside ServerState; restore the .bak" % (b + 1))
        found = int(m.group("version"))
        if found < VERSION:
            edits.append((b, e - b + 1, block_lines(m.group("indent"), unit, nl)))
            done.append("ServerState voice handlers: v%d -> v%d" % (found, VERSION))
        elif found > VERSION:
            print("patch_voices: keeping the newer v%d voice handlers (this script writes v%d)" % (found, VERSION), file=sys.stderr)
    else:
        clash = sorted(method_names(cls) & set(HANDLERS))
        if clash:
            raise PatchError(
                "ServerState already defines %s without this script's markers; refusing to guess -- "
                "start from an unmodified server.py" % ", ".join(clash)
            )
        chat = next(
            (n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "handle_chat"),
            None,
        )
        if chat is not None:  # just before handle_chat (and its decorators)
            first = min([chat.lineno] + [d.lineno for d in chat.decorator_list])
            edits.append((first - 1, 0, block_lines(leading(lines[first - 1]), unit, nl) + [nl]))
        else:  # at the end of the class
            indent = leading(lines[cls.body[0].lineno - 1])
            edits.append((cls.end_lineno, 0, [nl] + block_lines(indent, unit, nl)))
        done.append("ServerState.handle_voice_upload + handle_voice_list (v%d)" % VERSION)

    # (c) the routes
    has_get = bool(GET_ROUTE_RE.search(text))
    has_post = bool(POST_ROUTE_RE.search(text))
    if not (has_get and has_post):
        indent, app, state, end_line = find_anchor(text, lines, tree)
        new = []
        if not has_get:
            new.append('%s%s.router.add_get("/api/voices", %s.handle_voice_list)  %s%s' % (indent, app, state, MARK, nl))
        if not has_post:
            new.append('%s%s.router.add_post("/api/voices", %s.handle_voice_upload)  %s%s' % (indent, app, state, MARK, nl))
        edits.append((end_line, 0, new))
        verbs = [v for v, have in (("GET", has_get), ("POST", has_post)) if not have]
        done.append("routes: %s /api/voices after line %d" % (" + ".join(verbs), end_line))

    if not edits:
        return None, []
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += nl  # something may be inserted after the last line
    for start, count, new in sorted(edits, key=lambda edit: edit[0], reverse=True):
        lines[start:start + count] = new
    patched = "".join(lines)
    verify(patched)
    return patched, done


def atomic_write(path, data, mode_from):
    directory = os.path.dirname(os.path.abspath(path))
    tmp = os.path.join(directory, ".%s.%d.tmp" % (os.path.basename(path), os.getpid()))
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        shutil.copymode(mode_from, tmp)
        os.replace(tmp, path)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)


USAGE = "usage: python3 patch_voices.py PATH/TO/moshi/server.py [--check | --dry-run]"


def main(argv):
    flags = [a for a in argv if a.startswith("-")]
    paths = [a for a in argv if not a.startswith("-")]
    if "-h" in flags or "--help" in flags:
        print(__doc__.strip())
        return 0
    if len(paths) != 1 or any(f not in ("--check", "--dry-run") for f in flags) or len(set(flags)) > 1:
        print(USAGE, file=sys.stderr)
        return 1
    path = paths[0]
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        print("patch_voices: can't read %s: %s" % (path, e.strerror or e), file=sys.stderr)
        return 1
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        print("patch_voices: %s isn't UTF-8 text (%s)" % (path, e), file=sys.stderr)
        return 2
    bom = BOM if text.startswith(BOM) else ""
    try:
        patched, done = plan(text[len(bom):])
    except PatchError as e:
        print("patch_voices: %s: %s" % (path, e), file=sys.stderr)
        return 2
    if patched is None:
        print("patch_voices: %s already has the Trinity voice routes (v%d); nothing to do" % (path, VERSION))
        return 0
    if "--check" in flags:
        print("patch_voices: %s needs patching: %s" % (path, "; ".join(done)))
        return 3
    if "--dry-run" in flags:
        old, new = split_lines(text[len(bom):]), split_lines(patched)
        sys.stdout.writelines(difflib.unified_diff(old, new, path, path + " (patched)"))
        return 0
    real = os.path.realpath(path)  # patch the file itself, not a symlink to it
    try:
        atomic_write(real + ".bak", raw, mode_from=real)
        atomic_write(real, (bom + patched).encode("utf-8"), mode_from=real)
    except OSError as e:
        print("patch_voices: can't write %s: %s" % (path, e), file=sys.stderr)
        return 1
    print("patch_voices: patched %s" % path)
    for line in done:
        print("  + " + line)
    print("  previous version kept as %s.bak" % real)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
