# Task — 2026-08-28

## Scope (user's last message)
1. Verify global search covers converted files (.decoded.txt/.strings.txt under apk_full/) in BOTH screens.
2. "كامل" full-file button in viewer header of both screens — chunked progressive load.

## What was done this round
- Kotlin searchFiles: added `"apkfull" -> File(root, "apk_full")` scope branch (ApkScreen was scanning raw apk/ + il2cpp/ dirs — noise). Scope "all" already covers apk_full (only apk/ and il2cpp/ excluded).
- FilesScreen + ApkScreen: viewer state gains full/truncated/loadedLines; loadToken ref; fullLoading state.
- loadFull(): streams entire file in 800-line readFileRange chunks, live counter, FULL_MAX=20000 line safety cap, renders as ONE big <Text selectable> with line-number prefixes (per-line Views would freeze UI), scrolls back to targetLine, toast on truncation.
- closeViewer(): cancels in-flight load via loadToken++; wired to ✕ and Modal onRequestClose.
- Viewer header: "كامل" button before "نسخ" (disabled while loading, shows جاري…); notes: truncated-cap note, window note hidden in full mode, live progress note.
- Styles: fullText added to both StyleSheets.
- npx tsc --noEmit: CLEAN.

## Next
- commit/push, poll CI, download artifact, verify bundle (UTF-16-LE Arabic: 'كامل'), cp to /home/user/IL2CPP-Extractor.apk, deliver, reply in Arabic.

## Gotchas
- Edit tool sometimes silently fails → grep-verify after EVERY edit (done for all edits above).
- Arabic in Hermes bundle = UTF-16-LE.
- TOKEN=$(git remote get-url origin | sed -E 's|https://([^@]+)@.*|\1|')
