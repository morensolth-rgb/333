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
