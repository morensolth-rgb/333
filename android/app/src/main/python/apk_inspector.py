# apk_inspector.py — runs on-device via Chaquopy (stdlib only).
# Extracts EVERY entry from every APK split, classifies each file by magic,
# and converts binary/obfuscated formats into readable .txt siblings:
#   - AXML (binary Android XML)  -> pretty XML text
#   - resources.arsc             -> string pools dump
#   - .dex                       -> header + class list + full string dump
#   - Lua 5.1 bytecode           -> structured chunk dump (constants, locals)
#   - LuaJIT / other Lua         -> strings + constants
#   - protobuf-ish blobs         -> wire-format decode to text
#   - obfuscated blobs           -> zlib/gzip/base64/XOR deobfuscation chain
# Everything lands in one tree so search + viewer cover it all.

import os
import re
import struct
import zipfile
import zlib
import base64
import binascii
from collections import Counter

PRINTABLE = set(range(0x20, 0x7F)) | {0x09, 0x0A, 0x0D}
MAX_CONVERT = 64 * 1024 * 1024   # skip conversions for entries bigger than this

# Fast helpers for the XOR brute-force (C-speed instead of Python byte loops)
_NP = re.compile(rb'[^\x20-\x7e\t\n\r]')
_XOR_T = [bytes(b ^ k for b in range(256)) for k in range(256)]


def _ascii_ratio(data):
    if not data:
        return 1.0
    return 1.0 - len(_NP.findall(data)) / float(len(data))


# Letters + spaces only: digits/punctuation are common in XOR garbage too
# ("x"^0x5A='"', "o"^0x5A='5'...), so only alpha chars discriminate reliably.
_COMMON = set(b' etaoinshrdluETAOINSHRDLUbcfgjkmpqvwxyzBCFGJKMPQVWXYZ')


def _text_likelihood(data):
    if not data:
        return 0.0
    return sum(1 for b in data if b in _COMMON) / float(len(data))


# ───────────────────────── helpers ─────────────────────────

def _safe(path):
    parts = []
    for p in str(path).replace("\\", "/").split("/"):
        if p in ("", ".", ".."):
            continue
        parts.append(p.replace(":", "_"))
    return "/".join(parts)


def _printable_ratio(data):
    """UTF-8-aware: bytes that don't form valid UTF-8 text count as bad."""
    if not data:
        return 1.0
    n = len(data)
    text = data.decode("utf-8", errors="ignore")
    valid = sum(len(ch.encode("utf-8", errors="ignore")) for ch in text) / float(n)
    if not text:
        return 0.0
    printable = sum(1 for ch in text if ch.isprintable() or ch in "\t\n\r")
    return valid * (printable / float(len(text)))


def _looks_text(data):
    head = data[:4096]
    if b"\x00" in head:
        return False
    return _printable_ratio(head) > 0.92


def _strings(data, min_len=4, limit=150000):
    # byte-loop in Python is slow on huge blobs — sample-scan up to 8MB
    if len(data) > 8 * 1024 * 1024:
        data = data[:8 * 1024 * 1024]
    out = []
    cur = bytearray()
    for b in data:
        if b in PRINTABLE and b not in (0x0A, 0x0D):
            cur.append(b)
        else:
            if len(cur) >= min_len:
                out.append(cur.decode("utf-8", errors="ignore"))
            cur = bytearray()
    if len(cur) >= min_len:
        out.append(cur.decode("utf-8", errors="ignore"))
    return out[:limit]


def _uleb128(data, off):
    result = 0
    shift = 0
    while True:
        b = data[off]
        off += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, off


# ───────────────────────── AXML ─────────────────────────

def _axml_string_pool(data, off):
    """Parse a ResStringPool chunk. Returns (strings, next_offset)."""
    ctype, hsize, size = struct.unpack_from("<HHI", data, off)
    scount, stycount, flags, sstart, _ystart = struct.unpack_from("<IIIII", data, off + 8)
    utf8 = bool(flags & 0x100)
    offsets = struct.unpack_from("<%dI" % scount, data, off + hsize)
    base = off + sstart
    strings = []
    for so in offsets:
        p = base + so
        try:
            if utf8:
                ln = data[p]; p += 1
                if ln & 0x80:
                    ln = ((ln & 0x7F) << 8) | data[p]; p += 1
                bln = data[p]; p += 1
                if bln & 0x80:
                    bln = ((bln & 0x7F) << 8) | data[p]; p += 1
                strings.append(data[p:p + bln].decode("utf-8", errors="replace"))
            else:
                ln = struct.unpack_from("<H", data, p)[0]; p += 2
                if ln & 0x8000:
                    ln = ((ln & 0x7FFF) << 16) | struct.unpack_from("<H", data, p)[0]; p += 2
                strings.append(data[p:p + ln * 2].decode("utf-16-le", errors="replace"))
        except Exception:
            strings.append("")
    return strings, off + size


def _axml_value(data_type, data_val, pool):
    if data_type == 0x03:   # string
        return pool[data_val] if 0 <= data_val < len(pool) else ""
    if data_type == 0x12:   # bool
        return "true" if data_val else "false"
    if data_type == 0x10:   # int dec
        v = data_val if data_val < 0x80000000 else data_val - 0x100000000
        return str(v)
    if data_type == 0x11:   # int hex
        return "0x%08x" % data_val
    if data_type == 0x01:   # reference
        return "@0x%08x" % data_val
    if data_type == 0x04:   # float
        return repr(struct.unpack("<f", struct.pack("<I", data_val))[0])
    if 0x1C <= data_type <= 0x1F:  # colors
        return "#%08x" % data_val
    if data_type == 0x00:
        return ""
    return "0x%08x(t0x%02x)" % (data_val, data_type)


def _ns_short(uri):
    if not uri:
        return ""
    if "schemas.android.com" in uri:
        return uri.rstrip("/").split("/")[-1]
    return uri.rstrip("/").split("/")[-1]


def convert_axml(data):
    """Binary Android XML -> pretty text. Raises on failure."""
    if len(data) < 16 or data[2:4] != b"\x08\x00":
        raise ValueError("not axml")
    pool = None
    out = ['<?xml version="1.0" encoding="utf-8"?>']
    indent = 0
    nss = {}
    off = 8  # skip ResXMLTree_header
    while off + 8 <= len(data):
        ctype, hsize, size = struct.unpack_from("<HHI", data, off)
        if size <= 0:
            break
        if ctype == 0x0001:          # string pool
            pool, _ = _axml_string_pool(data, off)
        elif ctype == 0x0100 and pool is not None:  # start namespace
            prefix_idx, uri_idx = struct.unpack_from("<II", data, off + 16)
            nss[uri_idx] = pool[prefix_idx] if prefix_idx < len(pool) else ""
        elif ctype == 0x0102 and pool is not None:  # start element
            ns_idx, name_idx = struct.unpack_from("<II", data, off + 16)
            astart, asize, acount = struct.unpack_from("<HHH", data, off + 24)
            name = pool[name_idx] if name_idx < len(pool) else "node"
            line = ["%s<%s" % ("  " * indent, name)]
            abase = off + 16 + astart
            for i in range(acount):
                aoff = abase + i * asize
                try:
                    ans, aname, araw = struct.unpack_from("<III", data, aoff)
                    dtype = data[aoff + 15]
                    dval = struct.unpack_from("<I", data, aoff + 16)[0]
                    an = pool[aname] if aname < len(pool) else "attr%d" % i
                    nsp = _ns_short(nss.get(ans, ""))
                    if nsp:
                        an = "%s:%s" % (nsp, an)
                    if araw != 0xFFFFFFFF and araw < len(pool):
                        val = pool[araw]
                    else:
                        val = _axml_value(dtype, dval, pool)
                    val = val.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
                    line.append('%s%s="%s"' % ("  " * (indent + 1), an, val))
                except Exception:
                    pass
            line.append("%s>" % ("  " * indent))
            out.append("\n".join(line).lstrip("\n"))
            indent += 1
        elif ctype == 0x0103 and pool is not None:  # end element
            indent = max(0, indent - 1)
            _ns, name_idx = struct.unpack_from("<II", data, off + 16)
            name = pool[name_idx] if name_idx < len(pool) else "node"
            out.append("%s</%s>" % ("  " * indent, name))
        elif ctype == 0x0104 and pool is not None:  # text
            tidx = struct.unpack_from("<I", data, off + 16)[0]
            if tidx < len(pool) and pool[tidx].strip():
                out.append("%s%s" % ("  " * (indent + 1), pool[tidx]))
        off += size
    if pool is None or len(out) < 2:
        raise ValueError("empty axml")
    return "\n".join(out) + "\n"


# ───────────────────────── resources.arsc ─────────────────────────

def convert_arsc(data):
    """Dump every string pool inside resources.arsc."""
    if len(data) < 12 or struct.unpack_from("<H", data, 0)[0] != 0x0002:
        raise ValueError("not arsc")
    out = []
    off = struct.unpack_from("<I", data, 8)[0] and 12 or 12
    total = struct.unpack_from("<I", data, 8)[0]
    end = min(len(data), total if total > 12 else len(data))
    seen = set()
    while off + 8 <= end:
        ctype, hsize, size = struct.unpack_from("<HHI", data, off)
        if size <= 0:
            break
        if ctype == 0x0001:
            try:
                strings, _ = _axml_string_pool(data, off)
                new = [s for s in strings if s and s not in seen]
                seen.update(new)
                out.extend(new)
            except Exception:
                pass
        off += size
    if not out:
        raise ValueError("no strings")
    return "\n".join(out) + "\n"


# ───────────────────────── DEX ─────────────────────────

def convert_dex(data):
    """DEX -> header info + class descriptors + full string table dump."""
    if data[:3] != b"dex" or len(data) < 0x70:
        raise ValueError("not dex")
    version = data[4:7].decode("ascii", errors="replace")
    string_ids_size, string_ids_off = struct.unpack_from("<II", data, 0x38)
    type_ids_size, type_ids_off = struct.unpack_from("<II", data, 0x40)
    class_defs_size, class_defs_off = struct.unpack_from("<II", data, 0x60)

    def read_string(idx):
        if idx >= string_ids_size:
            return ""
        soff = struct.unpack_from("<I", data, string_ids_off + idx * 4)[0]
        _ln, p = _uleb128(data, soff)
        end = data.index(b"\x00", p)
        return data[p:end].decode("utf-8", errors="replace")

    out = ["DEX version: %s" % version,
           "strings: %d  types: %d  classes: %d" % (string_ids_size, type_ids_size, class_defs_size),
           "", "== CLASSES =="]
    for i in range(min(class_defs_size, 200000)):
        try:
            cidx = struct.unpack_from("<I", data, class_defs_off + i * 32)[0]
            sidx = struct.unpack_from("<I", data, type_ids_off + cidx * 4)[0]
            desc = read_string(sidx)
            src_idx = struct.unpack_from("<I", data, class_defs_off + i * 32 + 16)[0]
            src = read_string(src_idx) if src_idx != 0xFFFFFFFF else ""
            out.append(desc + (("   // %s" % src) if src else ""))
        except Exception:
            break
    out.append("")
    out.append("== STRINGS ==")
    for i in range(min(string_ids_size, 400000)):
        try:
            s = read_string(i)
            if len(s) >= 3 and _printable_ratio(s.encode("utf-8", errors="ignore")[:64]) > 0.9:
                out.append(s)
        except Exception:
            break
    return "\n".join(out) + "\n"


# ───────────────────────── Lua ─────────────────────────

def convert_lua51(data):
    """Structured dump of a Lua 5.1 bytecode chunk: constants, locals, protos."""
    if len(data) < 12 or data[:4] != b"\x1bLua" or data[4] != 0x51:
        raise ValueError("not lua51")
    endian = "<" if data[6] == 1 else ">"
    sz_int, sz_szt, sz_instr, sz_num = data[7], data[8], data[9], data[10]
    integral = data[11]
    off = 12

    def rd(fmt, size):
        nonlocal off
        v = struct.unpack_from(endian + fmt, data, off)[0]
        off += size
        return v

    def rd_string():
        nonlocal off
        ln = rd("I", 4) if sz_szt == 4 else rd("Q", 8)
        if ln == 0:
            return None
        s = data[off:off + ln - 1].decode("utf-8", errors="replace")
        off += ln
        return s

    def rd_num():
        nonlocal off
        if integral:
            return rd("i", 4) if sz_num == 4 else rd("q", 8)
        return rd("f", 4) if sz_num == 4 else rd("d", 8)

    out = ["Lua 5.1 bytecode — structured dump", ""]
    depth = [0]

    def parse_proto():
        pad = "  " * depth[0]
        source = rd_string()
        lined = rd("i", 4)
        lastl = rd("i", 4)
        nups, nparams, _vararg, maxstack = data[off], data[off + 1], data[off + 2], data[off + 3]
        off_add(4)
        out.append("%sfunction (params=%d, upvalues=%d, stack=%d, lines %d-%d)%s" % (
            pad, nparams, nups, maxstack, lined, lastl,
            ("  ; source: " + source) if source else ""))
        sizecode = rd("I", 4)
        off_add(sizecode * sz_instr)            # skip instructions
        sizek = rd("I", 4)
        consts = []
        for _ in range(min(sizek, 100000)):
            t = data[off]; off_add(1)
            if t == 0:
                consts.append("nil")
            elif t == 1:
                consts.append("true" if data[off] else "false"); off_add(1)
            elif t == 3:
                consts.append(repr(rd_num()))
            elif t == 4:
                consts.append(repr(rd_string()))
            else:
                break
        if consts:
            out.append("%s  constants:" % pad)
            for c in consts:
                out.append("%s    %s" % (pad, c))
        sizep = rd("I", 4)
        depth[0] += 1
        for _ in range(min(sizep, 10000)):
            parse_proto()
        depth[0] -= 1
        # debug
        szline = rd("I", 4); off_add(szline * sz_int)
        szloc = rd("I", 4)
        locs = []
        for _ in range(min(szloc, 100000)):
            nm = rd_string(); off_add(8)
            if nm:
                locs.append(nm)
        if locs:
            out.append("%s  locals: %s" % (pad, ", ".join(locs)))
        szup = rd("I", 4)
        ups = []
        for _ in range(min(szup, 10000)):
            nm = rd_string()
            if nm:
                ups.append(nm)
        if ups:
            out.append("%s  upvalue names: %s" % (pad, ", ".join(ups)))

    def off_add(n):
        nonlocal off
        off += n

    parse_proto()
    return "\n".join(out) + "\n"


def convert_lua_generic(data, kind):
    ver = data[4] if len(data) > 4 else 0
    out = ["Lua bytecode (%s, version byte 0x%02x)" % (kind, ver),
           "size: %d bytes" % len(data), "",
           "strings / constants:"]
    out += _strings(data)
    return "\n".join(out) + "\n"


# ───────────────────────── protobuf ─────────────────────────

def _pb_decode(data, depth, out, indent):
    if depth > 5:
        return 0
    off = 0
    fields = 0
    ln = len(data)
    while off < ln:
        try:
            key, off = _uleb128(data, off)
        except Exception:
            break
        field = key >> 3
        wire = key & 7
        if field == 0 or field > 0x1FFFFFFF:
            break
        pad = "  " * indent
        try:
            if wire == 0:
                val, off = _uleb128(data, off)
                out.append("%s%d: varint %d" % (pad, field, val))
            elif wire == 1:
                val = struct.unpack_from("<Q", data, off)[0]; off += 8
                out.append("%s%d: fixed64 0x%x" % (pad, field, val))
            elif wire == 2:
                blen, off = _uleb128(data, off)
                if blen < 0 or off + blen > ln:
                    break
                blob = data[off:off + blen]; off += blen
                if blen >= 2 and _printable_ratio(blob) > 0.92 and b"\x00" not in blob:
                    out.append('%s%d: "%s"' % (pad, field, blob.decode("utf-8", errors="replace")[:400]))
                else:
                    sub = []
                    consumed = _pb_decode(blob, depth + 1, sub, indent + 1)
                    if sub and consumed >= blen * 0.95:
                        out.append("%s%d: {" % (pad, field))
                        out.extend(sub)
                        out.append("%s}" % pad)
                    else:
                        out.append("%s%d: bytes[%d] %s" % (pad, field, blen,
                                                           binascii.hexlify(blob[:32]).decode()))
            elif wire == 5:
                val = struct.unpack_from("<I", data, off)[0]; off += 4
                out.append("%s%d: fixed32 0x%x" % (pad, field, val))
            else:
                break
            fields += 1
            if fields > 200000:
                break
        except Exception:
            break
    return off if fields else 0


def convert_protobuf(data):
    out = []
    consumed = _pb_decode(data, 0, out, 0)
    if not out or consumed < len(data) * 0.9:
        raise ValueError("not protobuf")
    return "protobuf wire-format decode (%d/%d bytes consumed)\n\n%s\n" % (
        consumed, len(data), "\n".join(out))


# ───────────────────────── deobfuscation ─────────────────────────

# Tiered magic evidence: 4+ byte signatures are near-impossible to hit by
# chance (safe as XOR-decode targets), 2-3 byte ones are weaker, and
# "{"/"["/"<" are single bytes that XOR junk hits constantly, so they need a
# validating second byte and score lowest.
_MAGIC_HARD = (b"\x1bLua", b"\x1bLJ", b"\x7fELF", b"\x89PNG", b"dex\n",
               b"SQLite", b"UnityFS", b"OggS", b"RIFF", b"OTTO",
               b"\x00\x01\x00\x00")
# NB: zlib headers (\x78..) are deliberately NOT magic — a magic bonus on the
# compressed layer would outscore the decompressed text (2.17 vs 1.8) and the
# DFS would stop at the still-compressed blob. _try_b64 accepts zlib payloads
# via its null-byte/printable criteria instead.
_MAGIC_WEAK = (b"PK", b"\x1f\x8b", b"\xff\xd8\xff")

# Final-artifact formats: decoding them further is never right, so the DFS
# stops branching at them (gzip stays explorable — it is a container layer).
_TERMINAL = _MAGIC_HARD + (b"PK", b"\xff\xd8\xff")


def _magic_bonus(head):
    for m in _MAGIC_HARD:
        if head.startswith(m):
            return 2.0
    for m in _MAGIC_WEAK:
        if head.startswith(m):
            return 1.2
    nxt = head[1:2]
    if head[:1] == b"{" and nxt in b' \t\r\n"}':
        return 0.6
    if head[:1] == b"[" and nxt in b' \t\r\n"-0123456789tfn[{]':
        return 0.6
    if head[:1] == b"<" and (nxt in b"!?/" or nxt.isalpha()):
        return 0.6
    return 0.0


def _word_bonus(data):
    """Text with real space-separated words scores high; solid blobs don't."""
    head = data[:4096]
    if not head:
        return 0.0
    tokens = head.split()
    if len(tokens) < 4:
        return 0.0
    good = sum(1 for t in tokens
               if len(t) >= 3 and sum(chr(c).isalpha() for c in t[:8]) >= 2)
    return min(good / float(len(tokens)), 1.0) * 0.8


def _score(data):
    if not data:
        return -1.0
    head = data[:8192]
    s = _printable_ratio(head) + _magic_bonus(head) + _word_bonus(head)
    if b"\x00" in head[:1024] and not head.startswith(b"PK"):
        s -= 0.5
    return s


_B64_CHARS = set(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r-_")


# zlib/gzip payload signatures — used as *acceptance* signals only (NOT part
# of _MAGIC_WEAK: a magic bonus on the compressed layer would outscore the
# decompressed text and the DFS would stop at the still-compressed blob)
_ZLIB_MAGIC = (b"\x78\x01", b"\x78\x5e", b"\x78\x9c", b"\x78\xda", b"\x1f\x8b")


def _xor_to_magic(head):
    """First key k whose single-byte XOR makes `head` start with a known
    multi-byte signature (incl. zlib), else None. Cheap: 255 translates of
    a few bytes. Used as evidence that a binary blob is one XOR layer away
    from a real artifact — lets _try_b64 accept xor-wrapped payloads."""
    if not head:
        return None
    sigs = _MAGIC_HARD + _MAGIC_WEAK + _ZLIB_MAGIC
    for k in range(1, 256):
        if head[:8].translate(_XOR_T[k]).startswith(sigs):
            return k
    return None


def _try_b64(current):
    head = current[:4096].strip()
    if len(head) < 16 or not set(head).issubset(_B64_CHARS):
        return None
    try:
        dec = base64.b64decode(current.strip(), validate=False)
        # b64 of random text often decodes to junk — require some structure:
        # a known magic, mostly-printable bytes, embedded NULs (binary
        # structs), a compressed payload signature, or one XOR layer away
        # from any of those (b64(zlib(x) ^ k) chains)
        if dec and (_magic_bonus(dec[:8]) > 0 or _printable_ratio(dec[:2048]) > 0.9
                    or b"\x00" in dec[:512] or dec.startswith(_ZLIB_MAGIC)
                    or _xor_to_magic(dec[:16]) is not None):
            return dec
    except Exception:
        pass
    return None


def _single_layer(current):
    """All plausible one-step decodings of `current`. Returns [(name, bytes)]."""
    cands = []
    for name, wbits in (("zlib", 15), ("gzip", 31), ("deflate", -15)):
        try:
            cands.append((name, zlib.decompress(current, wbits)))
        except Exception:
            pass
    dec = _try_b64(current)
    if dec is not None:
        cands.append(("base64", dec))
    # single-byte XOR, C-speed scan over a 4KB window, ranked by how much the
    # result looks like real language (not just printable bytes)
    window = current[:4096]
    if window and len(current) <= 8 * 1024 * 1024:
        best = []
        # 3+ byte signatures are trustworthy as-is. Two-byte ones (zlib/gzip
        # headers, "PK") collide by chance in ~0.4-2% of random blobs across
        # 255 keys, so they must be PROVEN by actually inflating/unzipping the
        # decoded data before the candidate is accepted.
        hard = _MAGIC_HARD + (b"\xff\xd8\xff",)
        for k in range(1, 256):
            w = window.translate(_XOR_T[k])
            if w.startswith(hard):
                # binary-behind-XOR (games love Lua bytecode under a XOR key)
                cands.append(("xor:0x%02x" % k, current.translate(_XOR_T[k])))
            elif w.startswith(_ZLIB_MAGIC):
                full = current.translate(_XOR_T[k])
                try:
                    zlib.decompress(full, 31 if full.startswith(b"\x1f\x8b") else 15)
                    cands.append(("xor:0x%02x" % k, full))
                except Exception:
                    pass
            elif w.startswith(b"PK"):
                full = current.translate(_XOR_T[k])
                try:
                    import io as _io
                    zipfile.ZipFile(_io.BytesIO(full)).infolist()
                    cands.append(("xor:0x%02x" % k, full))
                except Exception:
                    pass
            elif _ascii_ratio(w) > 0.95:
                best.append((_text_likelihood(w), k))
        best.sort(reverse=True)
        for lik, k in best[:2]:
            if lik < 0.75:
                break
            cands.append(("xor:0x%02x" % k, current.translate(_XOR_T[k])))
    return cands


def deobfuscate(data, max_depth=3):
    """Decode chained obfuscation (zlib/gzip/base64/XOR) via bounded DFS:
    explores up to 3 layers and returns the chain whose final content scores
    highest (real text / known magic beats sideways junk).
    Returns (decoded_bytes, [layer names]) or (None, []).
    Hard deadline: if _deadline is past, bail immediately."""
    base_score = _score(data)

    def search(blob, depth, layers):
        # (score, data, layers) candidates; the blob itself counts as one
        s = _score(blob)
        results = [(s, blob, layers)]
        if depth <= 0 or _time.time() > _deadline[0]:
            return results
        # Reached a final artifact (lua/dex/elf/zip/...) — decoding it further
        # is always wrong, so don't branch below it. Gzip is a container
        # layer and stays explorable.
        head = blob[:16]
        for m in _TERMINAL:
            if head.startswith(m):
                return results
        for name, cand in _single_layer(blob)[:3]:
            if cand == blob or not cand:
                continue
            results.extend(search(cand, depth - 1, layers + [name]))
        return results

    best = None
    best_layers = []
    best_score = base_score
    for s, blob, layers in search(data, max_depth, []):
        if layers and s > best_score + 0.1:
            best, best_layers, best_score = blob, layers, s
    return best, best_layers


# ───────────────────────── classification ─────────────────────────

def classify(name, head):
    lower = name.lower()
    if head[:4] == b"\x1bLua":
        ver = head[4] if len(head) > 4 else 0
        return "lua51" if ver == 0x51 else "lua"
    if head[:4] == b"\x1bLJ\x01" or head[:3] == b"\x1bLJ":
        return "luajit"
    if head[:3] == b"dex":
        return "dex"
    if head[:2] == b"PK":
        return "zip"
    if head[:2] == b"\x1f\x8b":
        return "gzip"
    if head[:4] == b"\x7fELF":
        return "elf"
    if head[:7] == b"UnityFS":
        return "unity"
    if head[:6] == b"SQLite":
        return "sqlite"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:4] == b"OggS":
        return "ogg"
    if head[:4] == b"\x00\x01\x00\x00" or head[:4] == b"OTTO":
        return "font"
    if len(head) >= 4 and struct.unpack_from("<H", head, 0)[0] == 0x0003 and head[2:4] == b"\x08\x00":
        return "axml"
    if len(head) >= 4 and struct.unpack_from("<H", head, 0)[0] == 0x0002:
        return "arsc"
    if lower.endswith((".json", ".xml", ".txt", ".csv", ".md", ".html", ".js", ".css",
                       ".properties", ".cfg", ".ini", ".yaml", ".yml", ".lua", ".proto")):
        return "text"
    # printable is not enough — XOR-obfuscated text with a high key also looks
    # printable. Require it to look like real language too (words/letters).
    if _looks_text(head) and _text_likelihood(head) > 0.55:
        return "text"
    return "binary"


# ───────────────────────── main ─────────────────────────

def _convert_one(kind, data):
    if kind == "axml":
        return convert_axml(data)
    if kind == "arsc":
        return convert_arsc(data)
    if kind == "dex":
        return convert_dex(data)
    if kind == "lua51":
        return convert_lua51(data)
    if kind in ("lua", "luajit"):
        return convert_lua_generic(data, kind)
    return None


def inspect(apks_semicolon, out_dir):
    """Extract every entry of every APK split + readable conversions.
    Returns a summary string. Also writes _index.txt.
    Writes _progress.txt continuously so the UI can show live progress,
    and stops gracefully at the time limit keeping whatever was produced."""
    os.makedirs(out_dir, exist_ok=True)
    _deadline[0] = _time.time() + INSPECT_TIME_LIMIT
    counts = Counter()
    errors = []
    index = []
    converted = 0
    timed_out = False
    done_entries = 0
    prog_path = os.path.join(out_dir, "_progress.txt")

    # total count first for a meaningful n/total in the progress line
    total = 0
    for apk in [a for a in apks_semicolon.split(";") if a]:
        try:
            with zipfile.ZipFile(apk) as zc:
                total += sum(1 for i in zc.infolist() if not i.is_dir())
        except Exception:
            pass

    def progress(cur):
        try:
            left = max(0, int(_deadline[0] - _time.time()))
            with open(prog_path, "w", encoding="utf-8") as pf:
                pf.write("%d/%d %s (%ds left)\n" % (done_entries, total, cur, left))
        except Exception:
            pass

    apks = [a for a in apks_semicolon.split(";") if a]
    for apk in apks:
        label = _safe(os.path.splitext(os.path.basename(apk))[0]) or "apk"
        base = os.path.join(out_dir, label)
        os.makedirs(base, exist_ok=True)
        try:
            zf = zipfile.ZipFile(apk)
        except Exception as e:
            errors.append((label, "OPEN", repr(e)))
            continue
        for info in zf.infolist():
            if info.is_dir():
                continue
            if _time.time() > _deadline[0]:
                timed_out = True
                break
            done_entries += 1
            if done_entries % 10 == 0:
                progress(info.filename)
            rel = _safe(info.filename)
            if not rel:
                continue
            dest = os.path.join(base, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            try:
                with zf.open(info) as src, open(dest, "wb") as dst:
                    while True:
                        chunk = src.read(1024 * 512)
                        if not chunk:
                            break
                        dst.write(chunk)
            except Exception as e:
                errors.append((rel, "COPY", repr(e)[:120]))
                continue

            size = os.path.getsize(dest)
            try:
                with open(dest, "rb") as f:
                    head = f.read(8192)
            except Exception:
                head = b""
            kind = classify(rel, head)
            counts[kind] += 1
            index.append("%-8s %10d  %s/%s" % (kind, size, label, rel))

            if size > MAX_CONVERT:
                continue
            try:
                with open(dest, "rb") as f:
                    data = f.read()
            except Exception:
                continue
            try:
                text = _convert_one(kind, data)
                if text:
                    with open(dest + ".txt", "w", encoding="utf-8", errors="ignore") as f:
                        f.write(text)
                    converted += 1
                    continue
            except Exception:
                pass

            # gzip entries: decompress outright into a sibling file
            if kind == "gzip" and size >= 8:
                try:
                    dec = zlib.decompress(data, 31)
                    with open(dest + ".gz.out", "wb") as f:
                        f.write(dec)
                    note = "decompressed gzip: %d -> %d bytes\n\n" % (size, len(dec))
                    note += (dec[:400000].decode("utf-8", errors="replace") if _looks_text(dec)
                             else "content still binary — strings:\n" + "\n".join(_strings(dec)))
                    with open(dest + ".gz.txt", "w", encoding="utf-8", errors="ignore") as f:
                        f.write(note)
                    converted += 1
                    continue
                except Exception:
                    pass

            # zip entries nested inside the apk (asset bundles): unpack listing
            if kind == "zip" and size >= 8:
                try:
                    import io as _io
                    with zipfile.ZipFile(_io.BytesIO(data)) as inner:
                        listing = ["%10d  %s" % (i.file_size, i.filename) for i in inner.infolist() if not i.is_dir()]
                    with open(dest + ".zip.txt", "w", encoding="utf-8", errors="ignore") as f:
                        f.write("nested ZIP archive — %d entries\n\n" % len(listing) + "\n".join(listing[:5000]))
                    converted += 1
                    continue
                except Exception:
                    pass

            # Unknown/binary: deobfuscation first (it must *prove* an encoding
            # chain by improving the content score), then protobuf (very
            # permissive — random bytes often parse as wire format), then strings
            if kind == "binary" and size >= 8:
                done = False
                # Brute-force chains only make sense on small blobs — a 20MB
                # asset under DFS*xor-255 costs minutes for nothing.
                if size <= MAX_DEOBFUSC:
                    try:
                        dec, layers = deobfuscate(data)
                        if dec is not None:
                            dpath = dest + ".decoded"
                            with open(dpath, "wb") as f:
                                f.write(dec)
                            note = "auto-decoded via: %s\noriginal: %d bytes -> decoded: %d bytes\n\n" % (
                                " -> ".join(layers), size, len(dec))
                            # re-classify the decoded payload: lua/dex behind XOR
                            # deserve the real structured converters, not strings
                            dk = classify(rel, dec[:8192])
                            inner = None
                            try:
                                inner = _convert_one(dk, dec)
                            except Exception:
                                inner = None
                            if inner:
                                note += inner
                            elif dk == "gzip":
                                try:
                                    g = zlib.decompress(dec, 31)
                                    note += ("gzip payload: %d -> %d bytes\n\n" % (len(dec), len(g))) + \
                                        (g[:400000].decode("utf-8", errors="replace") if _looks_text(g)
                                         else "\n".join(_strings(g)))
                                except Exception:
                                    note += "\n".join(_strings(dec))
                            elif _looks_text(dec):
                                note += dec[:400000].decode("utf-8", errors="replace")
                            else:
                                note += "decoded content is still binary — strings:\n" + "\n".join(_strings(dec))
                            with open(dest + ".decoded.txt", "w", encoding="utf-8", errors="ignore") as f:
                                f.write(note)
                            converted += 1
                            done = True
                    except Exception:
                        pass
                if not done and size <= MAX_DEOBFUSC:
                    try:
                        text = convert_protobuf(data)
                        with open(dest + ".proto.txt", "w", encoding="utf-8", errors="ignore") as f:
                            f.write(text)
                        converted += 1
                        done = True
                    except Exception:
                        pass
                if not done and size >= 16 and size <= MAX_STRINGS:
                    try:
                        strs = _strings(data)
                        if strs:
                            with open(dest + ".strings.txt", "w", encoding="utf-8", errors="ignore") as f:
                                f.write("binary file — extracted strings\n\n" + "\n".join(strs))
                            converted += 1
                    except Exception:
                        pass

            # known-but-opaque formats: at least a strings dump so search sees them
            if kind in ("elf", "sqlite", "unity", "font") and size >= 16 and size <= MAX_CONVERT:
                try:
                    strs = _strings(data)
                    if strs:
                        with open(dest + ".strings.txt", "w", encoding="utf-8", errors="ignore") as f:
                            f.write("%s file — extracted strings\n\n" % kind + "\n".join(strs))
                        converted += 1
                except Exception:
                    pass
        if timed_out:
            break

    try:
        with open(os.path.join(out_dir, "_index.txt"), "w", encoding="utf-8") as f:
            f.write("APK FULL EXTRACTION INDEX\n")
            f.write("entries: %d   converted-to-readable: %d\n\n" % (sum(counts.values()), converted))
            f.write("TYPES\n")
            for k, v in counts.most_common():
                f.write("%s: %d\n" % (k, v))
            f.write("\nFILES\n")
            for line in index:
                f.write(line + "\n")
        if errors:
            with open(os.path.join(out_dir, "_errors.txt"), "w", encoding="utf-8") as f:
                for e in errors:
                    f.write(repr(e) + "\n")
    except Exception:
        pass

    top = ", ".join("%s:%d" % kv for kv in counts.most_common(8))
    return "entries=%d converted=%d%s%s" % (
        sum(counts.values()), converted,
        (" [" + top + "]") if top else "",
        (" errors=%d" % len(errors)) if errors else "",
    )
