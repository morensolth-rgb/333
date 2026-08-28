# Task: fix "جاري الاستخراج" hanging forever (ApkInspect)

## Done
- apk_inspector.py: added MAX_DEOBFUSC (2MB), MAX_STRINGS (16MB), INSPECT_TIME_LIMIT (10min), _deadline
- deobfuscate: depth 4→3, branches 4→3, deadline check in DFS
- _strings: cap scan at 8MB
- inspect(): writes _progress.txt every 10 entries + counts total entries first; sets timed_out on deadline

## Remaining
1. inspect(): outer loop must also break on timed_out; summary must mention timeout
2. ApkScreen.tsx: poll _progress.txt every 2s during running phase, show in log/UI (rootBridge.getScratchRoot + readFile)
3. npx tsc --noEmit, commit (user.name/email -c flags), push origin main
4. Poll CI (curl api.github.com/actions/runs), download artifact, verify bundle strings, cp to /home/user/IL2CPP-Extractor.apk, deliver

## Key facts
- scratch root: ctx.filesDir/extracted/<pkg>/apk_full/_progress.txt
- remote token: git remote get-url origin | sed -E 's|https://([^@]+)@.*|\1|'
- repo branch: main
