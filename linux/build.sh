#!/bin/bash
# Packs the extension into dist/snowhush@snowhush.pages.dev.shell-extension.zip, or into the folder given,
# for installing with: gnome-extensions install --force <zip>
set -euo pipefail

out=$(realpath -m "${1:-$(dirname "$0")/../dist}")
cd "$(dirname "$0")/extension"
mkdir -p "$out"
sources=()
for file in *.js icons open.sh; do
    [[ $file == extension.js || $file == prefs.js ]] || sources+=(--extra-source="$file")
done
gnome-extensions pack --force --out-dir="$out" --schema=schemas/org.gnome.shell.extensions.snowhush.gschema.xml "${sources[@]}" .
echo "$out/snowhush@snowhush.pages.dev.shell-extension.zip"
