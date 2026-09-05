# Task — 2026-08-29 — token-in-unity-files gap

## Problem (user report)
Token seen inside a Unity file of game "Crossword Challenge" wasn't found by
app search after dump+assets extraction. Root causes found in code:
1. extract_unity.py only dumps MonoBehaviour + TextAsset — objects UnityPy
   can't parse (new Unity version, encrypted bundles, other types) never land
   on disk → not searchable.
2. OBB files (/sdcard/Android/obb/<pkg>/*.obb) were never staged — assets
   outside the APK were invisible.
3. global-metadata.dat strings (where il2cpp games keep tokens/keys) were
   never saved as searchable text.

## Fixes applied
- Kotlin stageApks: also stage OBB files.
- Kotlin locateUnityFiles/extractUnityAssets/inspectApk: accept .obb.
- Kotlin locateUnityFiles zip copies: streams now properly closed (same
  ETXTBSY class of bug as the dumper fix).
- Kotlin dumpIl2cpp: writes metadata_strings.txt (strings -n 6 of
  global-metadata.dat) into il2cpp_dump/ → covered by "Dump"/"all" search.
- extract_unity.py: raw strings safety-net sweep — every assets/*.unity3d/
  .assets/.bundle/.dat/.resS... entry (and whole OBB files that aren't zips,
  32MB cap) gets a RAWSTRINGS_<name>.txt regardless of UnityPy parsing.
  Summary now reports sweep=N.
- Smoke test PASSED: token inside an unparseable .unity3d found in
  RAWSTRINGS_*.txt; py syntax OK.

## Next
commit/push → poll CI → artifact → verify (RAWSTRINGS in app.imy pyc,
metadata_strings in dex) → cp to /home/user/IL2CPP-Extractor.apk → deliver →
reply in Arabic.

---
# 2026-08-29 part 2 — .unity3d readability (user: "download it yourself, figure out the format")

## Findings (Crossword Challenge = com.nocturnal.crossword, APK 205MB from apkpure)
- assets/bin/Data/data.unity3d: standard UnityFS, Unity 6000.5.7f1 — UnityPy parses OK
  (MonoBehaviour 1473, TextAsset 10, etc.)
- assets/aa/Android/*.bundle (Addressables, 62MB defaultlocalgroup is the big one):
  UnityPy FAILS twice:
  1. UnityFS format 8 flags 0x243: new 0x200 flag (blockinfo+data 32-byte aligned).
     UnityPy aligns blockinfo to 16 only and data to 16 -> misaligned reads.
     Manual parser works: align blockinfo start AND data start to 32 when flags&0x200,
     lz4.block decompress each block. Blocks 965 -> 126MB, dirs: CAB-*.serialized + .resS.
  2. Decompressed CAB serialized file (version 23) has NON-STANDARD header:
     bytes 0..16 = legacy header (meta/filesize/dataoffset zeroed, version=23),
     bytes 16..48 = three big-endian u64 (metadata_size, file_size, data_offset) + u64 unknown.
     NO endian+reserved bytes, and metadata_size is u64 not u32 -> UnityPy reads
     file_size/data_offset garbage -> typetree blob parse explodes
     ("iterative unpacking requires a buffer of a multiple of 32 bytes").
  FIX: rebuild header = raw[0:16] + b'\0'*4 + LE u32 meta + LE i64 filesize + LE i64 dataoff
  + LE i64 0 + raw[48:] -> feed UnityPy BytesIO. (TESTING NOW)
- Token 'kihgyc' very likely inside defaultlocalgroup bundle (word dictionaries).

## Plan
1. Verify normalized CAB parses with UnityPy + find token in extracted text.
2. extract_unity.py: add UnityFS fallback parser (pure python, lz4 via UnityPy dep or
   pure-python lz4 block decoder if Chaquopy lacks lz4 wheel — CHECK build.gradle),
   header normalization, and dump ALL object types via read_typetree -> JSON
   (not just MonoBehaviour/TextAsset). Keep RAWSTRINGS sweep as fallback.
3. Local smoke test with real APK -> commit/push -> CI -> verify APK -> deliver.

---
# 2026-09-05 — token hunt inside the app (user request)

## What
Merged the desktop search+extract UnityPy script into the app itself:
- extract_unity.py: new hunt_token(apks, out_dir, token) — scans EVERY object's
  raw bytes (case-insensitive), saves hits as {Type}_{path_id}_full.txt, returns JSON.
- RootBridgeModule.kt: new @ReactMethod huntToken(pkg, token) → <scratch>/<pkg>/token_hunt/.
- RootBridge.ts: TokenMatch type + huntToken wrapper (JSON.parse).
- FilesScreen.tsx: HUNT button next to FIND + "Hunt" tab listing matches
  (type · path_id · size · apk), tap opens saved file in viewer.

## Verified
- python3 -m py_compile extract_unity.py OK
- npx tsc --noEmit OK

## Next
commit/push → poll CI → artifact → cp to /home/user/IL2CPP-Extractor.apk → deliver → reply Arabic.

---
# 2026-09-05 part 2 — token hunt on a user-picked Unity file (user request)

## What
New standalone flow: pick a Unity file yourself → enter token → scan every
object's raw bytes → each hit extracted as {Type}_{path_id}_full.txt, tap to view.
- extract_unity.py: hunt_token_in_file(src_path, out_dir, token) — same logic
  as the desktop script, returns JSON with index/type/path_id/size/file/path.
- RootBridgeModule.kt: huntTokenInFile(srcPath, token) — stages the picked file
  via root cp into scratch/token_hunt_files/staged, output to <name>_hunt/.
- RootBridge.ts: huntTokenInFile wrapper.
- HuntFileScreen.tsx: 3-step wizard (browse fs → enter token → results+viewer).
  Unity extensions highlighted (.unity3d/.assets/.bundle/.dat/.resS...).
- App.tsx: registered HuntFile route. AppsScreen: 🎯 entry button.

## Verified
- python3 -m py_compile OK; npx tsc --noEmit OK.

## Next
commit/push → poll CI → artifact → verify (hunt_token_in_file in app.imy,
HuntFile in bundle, huntTokenInFile in dex) → cp to /home/user/IL2CPP-Extractor.apk → deliver → reply Arabic.

---
# 2026-09-05 part 3 — data.unity3d not showing in hunt browser (user report)

## Problem
User's data.unity3d exists on device but didn't appear in the hunt file browser.
Root cause: readDir's Java listFiles() returns null/empty on scoped-storage or
root-only dirs (Android/data, Termux home), and the old root fallback parsed
`ls -la` output where File.isDirectory()/length() silently fail on root-only
paths — dirs showed as files, sizes as 0, or nothing at all.

## Fixes
- RootBridgeModule.kt readDir: root fallback now emits machine-readable
  "d|size|name" lines (dir-ness + size from shell stat, not Java File).
  Also triggers when listFiles() returns EMPTY (scoped storage), not just null.
- HuntFileScreen.tsx: direct-path input row — paste the full path to the file
  (e.g. /sdcard/.../data.unity3d) → GO picks it directly; a dir path browses it.

## Verified
- npx tsc --noEmit OK.

## Next
commit/push → poll CI → artifact → verify → cp to /home/user/IL2CPP-Extractor.apk → deliver → reply Arabic.

---
# 2026-09-05 part 4 — token found in raw file but hunt said 0 results (user report)

## Problem
User hunted token "gccekseplj40" in a data.unity3d — app said no results, but
the token is plainly visible in the file bytes (file browser showed it).
Root cause: hunt_token_in_file only scanned objects UnityPy could parse. This
game's bundle uses a new/non-standard Unity format UnityPy can't decompose,
so zero objects → zero matches, even though the token sits in the raw bytes.

## Fix — hunt now scans 3 layers (extract_unity.py hunt_token_in_file)
1. Parsed objects (as before) → {Type}_{path_id}_full.txt
2. Decompressed container entries via env.file.files → BLOB_<name>.txt
3. Raw file sweep: find token in file bytes, save strings of 64KB window
   around the hit → RAW_<name>_hit.txt (type RawFile)
Also returns "note" when UnityPy load failed; HuntFileScreen shows it.

## Verified
- py_compile OK; tsc --noEmit OK.

## Next
commit/push → poll CI → artifact → verify → cp to /home/user/IL2CPP-Extractor.apk → deliver → reply Arabic.
