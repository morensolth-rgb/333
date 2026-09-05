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
import re
import traceback
import zipfile

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

    # ── Safety net ────────────────────────────────────────────────────────
    # MonoBehaviour/TextAsset dumps only cover what UnityPy can parse. A
    # token can hide in an object type we skip, an unreadable/encrypted
    # bundle, or an OBB. So ALSO run a raw strings sweep over EVERY Unity
    # asset file inside the staged APK/OBBs and save one searchable .txt
    # per file — regardless of whether UnityPy understood it.
    swept = 0
    sweep_errors = 0
    UNITY_EXTS = (".assets", ".unity3d", ".unitypackage", ".resS", ".resource", ".dat", ".bundle")
    for apk in apks:
        try:
            zf = zipfile.ZipFile(apk)
        except Exception:
            # Not a zip (raw OBB/obb-mount): sweep the file itself.
            try:
                with open(apk, "rb") as fh:
                    raw = fh.read(32 * 1024 * 1024)
                strs = _extract_strings(raw)
                if strs:
                    name = _safe_name(os.path.basename(apk))
                    with open(os.path.join(out_dir, "RAWSTRINGS_%s.txt" % name), "w", encoding="utf-8", errors="ignore") as f:
                        f.write("RAW STRINGS SWEEP: %s (whole file, first 32MB)\n\n" % os.path.basename(apk))
                        f.write("\n".join(strs))
                    swept += 1
            except Exception:
                sweep_errors += 1
            continue
        try:
            for info in zf.infolist():
                low = info.filename.lower()
                if not ("assets/" in low and (low.endswith(UNITY_EXTS) or ".bundle" in low)):
                    continue
                if info.file_size > 32 * 1024 * 1024:
                    continue
                try:
                    raw = zf.read(info)
                except Exception:
                    sweep_errors += 1
                    continue
                strs = _extract_strings(raw)
                if not strs:
                    continue
                rel = _safe_name(os.path.basename(apk) + "__" + info.filename.replace("/", "_"))
                with open(os.path.join(out_dir, "RAWSTRINGS_%s.txt" % rel), "w", encoding="utf-8", errors="ignore") as f:
                    f.write("RAW STRINGS SWEEP: %s!%s\n\n" % (os.path.basename(apk), info.filename))
                    f.write("\n".join(strs))
                swept += 1
        except Exception:
            sweep_errors += 1
        finally:
            try:
                zf.close()
            except Exception:
                pass

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
    return "written=%d types=%d%s%s sweep=%d%s" % (
        written,
        sum(counts.values()),
        (" [" + top + "]") if top else "",
        (" errors=%d" % len(errors)) if errors else "",
        swept,
        (" sweep_err=%d" % sweep_errors) if sweep_errors else "",
    )


def _test():  # not used on device
    print(extract(sys.argv[1], sys.argv[2]))


# ── Token hunt ─────────────────────────────────────────────────────────
# Scans EVERY object of the staged Unity bundles for a token
# (case-insensitive on raw bytes). Each hit is saved raw as
# {Type}_{path_id}_full.txt — same convention as the desktop script.
# Returns a JSON string: {"count": N, "matches": [...]}

import json  # noqa: E402


def hunt_token(apks_semicolon, out_dir, token):
    os.makedirs(out_dir, exist_ok=True)
    needle = (token or "").encode("utf-8", errors="ignore").lower()
    if not needle:
        return json.dumps({"count": 0, "matches": []})

    matches = []
    apks = [a for a in apks_semicolon.split(";") if a]
    for apk in apks:
        try:
            env = UnityPy.load(apk)
        except Exception:
            continue
        for i, obj in enumerate(env.objects):
            try:
                raw = obj.get_raw_data()
            except Exception:
                continue
            if needle in raw.lower():
                fname = "%s_%s_full.txt" % (obj.type.name, obj.path_id)
                fpath = os.path.join(out_dir, fname)
                try:
                    with open(fpath, "wb") as f:
                        f.write(raw)
                except Exception:
                    continue
                matches.append({
                    "apk": os.path.basename(apk),
                    "type": obj.type.name,
                    "path_id": str(obj.path_id),
                    "file": fname,
                    "path": fpath,
                    "size": len(raw),
                })
            if len(matches) >= 500:
                break
        if len(matches) >= 500:
            break
    return json.dumps({"count": len(matches), "matches": matches})


def hunt_token_in_file(src_path, out_dir, token):
    """Same as hunt_token but for ONE user-picked Unity file
    (.unity3d/.assets/.bundle/...). Scans every object's raw bytes
    (case-insensitive) and saves each hit as {Type}_{path_id}_full.txt.
    Returns JSON: {"count": N, "matches": [{index,type,path_id,size,file,path}]}"""
    os.makedirs(out_dir, exist_ok=True)
    needle = (token or "").encode("utf-8", errors="ignore").lower()
    if not needle:
        return json.dumps({"count": 0, "matches": []})

    try:
        env = UnityPy.load(src_path)
    except Exception as e:
        return json.dumps({"count": 0, "matches": [], "error": "load failed: %r" % (e,)})

    matches = []
    for i, obj in enumerate(env.objects):
        try:
            raw = obj.get_raw_data()
        except Exception:
            continue
        if needle in raw.lower():
            fname = "%s_%s_full.txt" % (obj.type.name, obj.path_id)
            fpath = os.path.join(out_dir, fname)
            try:
                with open(fpath, "wb") as f:
                    f.write(raw)
            except Exception:
                continue
            matches.append({
                "index": i,
                "type": obj.type.name,
                "path_id": str(obj.path_id),
                "file": fname,
                "path": fpath,
                "size": len(raw),
            })
        if len(matches) >= 500:
            break
    return json.dumps({"count": len(matches), "matches": matches})
