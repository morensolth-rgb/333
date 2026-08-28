# Task: NameError fix + copy-all button + b64 deobfuscation

## User asks
1. Fix `NameError: name 'time' is not defined` during APK inspect
2. Copy-all button in file viewer (both FilesScreen + ApkScreen)

## Progress
- [x] Found: header constants block (MAX_DEOBFUSC, MAX_STRINGS, INSPECT_TIME_LIMIT, import time as _time, _deadline) was MISSING from apk_inspector.py → re-added
- [x] Found: base64 blobs classified as "text" → never deobfuscated. classify() now returns "b64ish" for solid base64 blobs
- [x] Conversion block condition changed to kind in ("binary","b64ish")
- [x] Direct deobfuscate() call works: layers [base64, zlib] decode fine
- [ ] PROBLEM: inspect() still not writing .decoded.txt — summary shows converted=0 though kind=b64ish counted. Verify edit actually in file, then debug inside inspect
- [ ] Copy-all button: RN 0.73 core Clipboard (node_modules/react-native/Libraries/Components/Clipboard exists) — import {Clipboard} from 'react-native', add button in viewer header of FilesScreen.tsx (~line 289-313) and ApkScreen.tsx (same pattern)
- [ ] tsc + python checks, commit, push, CI poll, artifact, verify, deliver

## Facts
- repo /home/user/333, branch main, token via: git remote get-url origin | sed -E 's|https://([^@]+)@.*|\1|'
- commit flags: -c user.name="morensolth-rgb" -c user.email="morensolth-rgb@users.noreply.github.com"
- CI poll: curl -H "Authorization: token $TOKEN" https://api.github.com/repos/morensolth-rgb/333/actions/runs?per_page=1
