# extract_unity.py — runs on-device via Chaquopy.
# Extracts Unity assets (MonoBehaviour, TextAsset, and all other objects)
# from staged APK files using UnityPy. Stubs out deps not available in
# Chaquopy's wheel index (we only need MonoBehaviour/TextAsset reading).
#
# Binary TextAssets (Lua bytecode bundles, encrypted blobs, etc.) are saved
# raw under raw/ AND get a readable strings-dump .txt so search + viewer work.

import sys
import types


def _stub(name, **attrs):
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


def _install_stubs():
    # tkinter is not on Android; UnityPy 1.7.x imports tkinter.messagebox.NO
    tk = types.ModuleType("tkinter")
    tkmb = types.ModuleType("tkinter.messagebox")
    tkmb.NO = "no"
    tk.messagebox = tkmb
    sys.modules.setdefault("tkinter", tk)
    sys.modules.setdefault("tkinter.messagebox", tkmb)

    # Native decoders missing from Chaquopy index — only needed for
    # Texture2D/AudioClip conversion, which we skip. Provide lazy stubs that
    # raise only if actually used.
    for m in ("texture2ddecoder", "astc_encoder", "etcpak", "fmod_toolkit"):
        if m not in sys.modules:
            _stub(m)

    # Pillow is only used by Texture2D/Sprite export paths (which we never
    # call for MonoBehaviour/TextAsset). Its Chaquopy wheel needs extra native
    # packages (chaquopy-libjpeg etc.) — skip it and stub PIL instead.
    pil = _stub("PIL")
    _stub("PIL.Image")
    _stub("PIL.ImageDraw")
    pil.Image = sys.modules["PIL.Image"]


_install_stubs()

import os
import traceback

import UnityPy  # noqa: E402
from collections import Counter  # noqa: E402

LUA_MAGIC = b"\x1bLua"
PRINTABLE = set(range(0x20, 0x7F)) | {0x09, 0x0A, 0x0D}


def _safe_name(name):
    name = str(name or "unnamed")
    for ch in ('/', '\\', ':', '*', '?', '"', '<', '>', '|'):
        name = name.replace(ch, "_")
    return name[:120]


def _sniff(raw):
    """Return a short content-type label from magic bytes."""
    if raw[:4] == LUA_MAGIC:
        return "lua-bytecode"
    if raw[:2] == b"PK":
        return "zip"
    if raw[:2] == b"\x1f\x8b":
        return "gzip"
    if raw[:4] == b"\x7fELF":
        return "elf"
    if raw[:1] == b"\x78":
        return "zlib?"
    return "binary"


def _is_probably_text(raw):
    head = raw[:4096]
    if not head:
        return True
    if b"\x00" in head:
        return False
    bad = sum(1 for b in head if b not in PRINTABLE and b < 0x80)
    return bad / float(len(head)) < 0.05


def _extract_strings(raw, min_len=4, limit=200000):
    """Pull printable ASCII/UTF-8-ish runs out of binary data."""
    out = []
    cur = bytearray()
    for b in raw:
        if b in PRINTABLE and b not in (0x0A, 0x0D):
            cur.append(b)
        else:
            if len(cur) >= min_len:
                out.append(cur.decode("utf-8", errors="ignore"))
            cur = bytearray()
    if len(cur) >= min_len:
        out.append(cur.decode("utf-8", errors="ignore"))
    return out[:limit]


def _dump_monobehaviour(obj, data, out_dir):
    path = os.path.join(out_dir, "MonoBehaviour_%s_%s.txt" % (obj.path_id, _safe_name(getattr(data, "name", ""))))
    try:
        tree = None
        try:
            tree = obj.read_typetree()
        except Exception:
            tree = None
        with open(path, "w", encoding="utf-8", errors="ignore") as f:
            f.write("TYPE: MonoBehaviour\n")
            f.write("PATH ID: %s\n" % obj.path_id)
            f.write("NAME: %s\n" % getattr(data, "name", ""))
            f.write("\nDATA:\n")
            if tree is not None:
                import json
                f.write(json.dumps(tree, ensure_ascii=False, indent=2, default=str))
            else:
                f.write(repr(getattr(data, "raw_data", data)))
        return path
    except Exception:
        return None


def _dump_textasset(obj, data, out_dir, raw_dir):
    name = _safe_name(getattr(data, "name", obj.path_id))
    try:
        script = getattr(data, "script", None)
        if script is None:
            script = getattr(data, "m_Script", b"")
        if isinstance(script, (bytes, bytearray)):
            raw = bytes(script)
        else:
            raw = str(script).encode("utf-8", errors="ignore")

        if _is_probably_text(raw):
            path = os.path.join(out_dir, "TextAsset_%s.txt" % name)
            with open(path, "w", encoding="utf-8", errors="ignore") as f:
                f.write(raw.decode("utf-8", errors="replace"))
            return path

        # Binary TextAsset (Lua bytecode, encrypted blob, etc.):
        # keep the raw bytes AND emit a readable strings dump.
        kind = _sniff(raw)
        raw_path = os.path.join(raw_dir, "%s.bin" % name)
        with open(raw_path, "wb") as f:
            f.write(raw)

        path = os.path.join(out_dir, "TextAsset_%s.txt" % name)
        with open(path, "w", encoding="utf-8", errors="ignore") as f:
            f.write("TYPE: binary TextAsset (%s)\n" % kind)
            f.write("NAME: %s\n" % getattr(data, "name", ""))
            f.write("SIZE: %d bytes\n" % len(raw))
            f.write("RAW: raw/%s.bin\n" % name)
            if kind == "lua-bytecode":
                f.write("NOTE: compiled Lua bytecode — strings/constants below\n")
            f.write("\nSTRINGS:\n")
            for s in _extract_strings(raw):
                f.write(s + "\n")
        return path
    except Exception:
        return None


def extract(apks_semicolon, out_dir):
    """apks_semicolon: ';'-joined list of staged APK paths (base + ALL splits).
    Returns a human-readable summary string."""
    os.makedirs(out_dir, exist_ok=True)
    raw_dir = os.path.join(out_dir, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    counts = Counter()
    errors = []
    written = 0

    apks = [a for a in apks_semicolon.split(";") if a]
    for apk in apks:
        try:
            env = UnityPy.load(apk)
        except Exception as e:
            errors.append(("LOAD", os.path.basename(apk), repr(e)))
            continue

        for obj in env.objects:
            typ = obj.type.name
            counts[typ] += 1
            try:
                if typ == "MonoBehaviour":
                    data = obj.read()
                    if _dump_monobehaviour(obj, data, out_dir):
                        written += 1
                elif typ == "TextAsset":
                    data = obj.read()
                    if _dump_textasset(obj, data, out_dir, raw_dir):
                        written += 1
            except Exception as e:
                errors.append((typ, getattr(obj, "path_id", "?"), repr(e)[:200]))

    # Write a type summary + errors file
    try:
        with open(os.path.join(out_dir, "_summary.txt"), "w", encoding="utf-8") as f:
            f.write("UnityPy %s\n" % getattr(UnityPy, "__version__", "?"))
            f.write("Files written: %d\n\n" % written)
            f.write("OBJECT TYPES\n")
            for k, v in counts.most_common():
                f.write("%s: %d\n" % (k, v))
        if errors:
            with open(os.path.join(out_dir, "_errors.txt"), "w", encoding="utf-8") as f:
                for e in errors:
                    f.write(repr(e) + "\n")
    except Exception:
        pass

    top = ", ".join("%s:%d" % kv for kv in counts.most_common(6))
    return "written=%d types=%d%s%s" % (
        written,
        sum(counts.values()),
        (" [" + top + "]") if top else "",
        (" errors=%d" % len(errors)) if errors else "",
    )


def _test():  # not used on device
    print(extract(sys.argv[1], sys.argv[2]))
