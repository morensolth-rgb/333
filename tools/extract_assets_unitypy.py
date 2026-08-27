#!/usr/bin/env python3
# tools/extract_assets_unitypy.py
# Requires: pip install UnityPy
import UnityPy, sys, os

if len(sys.argv) < 3:
    print("Usage: extract_assets_unitypy.py <path_to_assets_file_or_folder> <output_dir>")
    sys.exit(1)

src = sys.argv[1]
out = sys.argv[2]
os.makedirs(out, exist_ok=True)

env = UnityPy.load(src)
count = 0
for obj in env.objects:
    try:
        if obj.type.name in ["Texture2D", "TextAsset", "AudioClip", "MonoBehaviour", "Shader"]:
            data = obj.read()
            name = data.name or f"asset_{count}"
            if obj.type.name == "Texture2D":
                data.save(os.path.join(out, f"{name}.png"))
            elif obj.type.name == "TextAsset":
                b = getattr(data, "script", None) or getattr(data, "bytes", None) or b""
                with open(os.path.join(out, f"{name}.dat"), "wb") as f:
                    f.write(b if isinstance(b, (bytes, bytearray)) else str(b).encode())
            elif obj.type.name == "AudioClip":
                data.save(os.path.join(out, f"{name}.wav"))
            else:
                with open(os.path.join(out, f"{name}.bin"), "wb") as f:
                    raw = getattr(data, "data", None) or b""
                    f.write(raw if isinstance(raw, (bytes, bytearray)) else str(raw).encode())
            count += 1
    except Exception as e:
        print("skip", e)
print(f"extracted ~{count} assets to {out}")
