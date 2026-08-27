#!/usr/bin/env bash
# tools/dump_il2cpp.sh
# Usage: ./tools/dump_il2cpp.sh /path/to/unity_folder /output/dir
# Description: Find Unity's global-metadata.dat and libil2cpp.so and run Il2CppDumper (assumes Il2CppDumper.py is in tools/ or in PATH).
set -e
UNITY_DIR="$1"
OUT="$2"

if [ -z "$UNITY_DIR" ] || [ -z "$OUT" ]; then
  echo "Usage: $0 <unity_folder> <output_dir>"
  exit 1
fi

mkdir -p "$OUT"

METADATA=$(find "$UNITY_DIR" -type f -iname "global-metadata.dat" | head -n1)
LIB=$(find "$UNITY_DIR" -type f -iname "libil2cpp.so" | head -n1)

if [ -z "$METADATA" ] || [ -z "$LIB" ]; then
  echo "لم يتم العثور على global-metadata.dat أو libil2cpp.so في $UNITY_DIR"
  exit 2
fi

echo "metadata: $METADATA"
echo "lib: $LIB"

# Run Il2CppDumper.py (place Il2CppDumper.py inside tools/ or have it available in PATH)
# Example: python3 tools/Il2CppDumper.py <global-metadata.dat> <libil2cpp.so> <out_dir>
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "Python not found. Install Python 3 and try again."
  exit 3
fi

if [ -f "tools/Il2CppDumper.py" ]; then
  echo "Using tools/Il2CppDumper.py"
  "$PY" tools/Il2CppDumper.py "$METADATA" "$LIB" "$OUT"
else
  echo "Il2CppDumper.py not found in tools/. Please download Il2CppDumper and place it at tools/Il2CppDumper.py or add it to PATH."
  exit 4
fi

echo "تم تفريغ il2cpp إلى $OUT"
