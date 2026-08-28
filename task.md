# Task — 2026-08-28 — DONE & DELIVERED

## Delivered build
- Commit c6e88b7, CI run 33146656534 (success), artifact 9676125567
- /home/user/IL2CPP-Extractor.apk (48.5 MB) — zip OK, bundle verified:
  'كامل'/'جاري تحميل الملف كامل'/'الملف ضخم'/'نسخ' UTF-16LE ✓, loadFull/readFileRange ASCII ✓

## Changes
1. Kotlin searchFiles: "apkfull" scope → apk_full/ only (was falling through to root, grepping raw apk/ + il2cpp/ noise). Scope "all" already covers apk_full/.
2. Both screens: "كامل" button in viewer header — streams whole file in 800-line readFileRange chunks, live counter, 20000-line cap + truncation note, ONE big selectable Text (not per-line Views), scrolls back to search hit, closeViewer cancels in-flight load (✕ + back button).

## Answer to user (search coverage)
- شاشة الملفات "الكل": نعم، الملفات المحوّلة مشمولة (يستثني بس apk/ و il2cpp/).
- شاشة APK: كان في مشكلة (بيفتش الخام) → صار محصور بـ apk_full/.

## Reply in Arabic — done in chat
