# Task: Full-APK inspection feature (long-press flow)

## Goal (user-confirmed)
- Long-press app → new screen: extract button → file list + search (separate from IL2CPP dump flow)
- Extract ALL entries from ALL splits; convert binary → readable:
  AXML→XML, dex→strings/classes, Lua 5.1→structured dump, protobuf→text,
  auto-deobfuscation (zlib/gzip/base64/XOR, chained), gzip→decompress,
  nested zip→listing, elf/sqlite/unity/font→strings dump
- Tap file → analyzeFile type detection + readable preview (done earlier)
- Search scope "apkfull" covers everything extracted

## Status
- [x] analyzeFile native method + FileAnalysis type + viewers (built green earlier, APK delivered)
- [x] apk_inspector.py engine written (stdlib only for Chaquopy)
- [x] inspectApk Kotlin method + searchFiles "apkfull" scope
- [x] ApkScreen.tsx (extract button/log → files+search+viewer)
- [x] App.tsx nav + AppsScreen long-press → ApkInspect
- [x] tsc clean
- [x] deobfuscation DFS (zlib/b64/xor chains) verified: zlib/b64/xor/dbl/triple pass, random passes (None)
- [ ] FIX IN PROGRESS: XOR'd printable-text misclassified as "text" (charset too wide) → restrict _COMMON to letters+space; add XOR magic-header scan for binary payloads
- [ ] Final local test → commit → push → watch CI run → download APK → deliver

## Cautions
- Chaquopy: stdlib-only python; no Pillow; UnityPy --no-deps
- Kotlin errors only surface in CI logs — watch run till green
- Files edited this session sometimes lost edits (sandbox weirdness) — verify with grep after each edit
- Commit: -c user.name="morensolth-rgb" -c user.email="morensolth-rgb@users.noreply.github.com"
- CI artifact: IL2CPP-Extractor-release (app-release.apk)
