#!/bin/bash
# Removes Snowhush for GNOME and its settings for this user.
set -euo pipefail

uuid=snowhush@snowhush.pages.dev
data=${XDG_DATA_HOME:-$HOME/.local/share}

gnome-extensions disable "$uuid" 2> /dev/null || true
enabled=$(gsettings get org.gnome.shell enabled-extensions)
if [[ $enabled == *"'$uuid'"* ]]; then
    remaining=$(echo "$enabled" | sed -e "s/'$uuid'//" -e 's/, ,/,/' -e 's/\[, /[/' -e 's/, \]/]/')
    gsettings set org.gnome.shell enabled-extensions "$remaining"
fi
rm -rf "$data/gnome-shell/extensions/$uuid"
rm -f "$data/applications/snowhush.desktop" "$data/icons/hicolor/256x256/apps/snowhush.png"
dconf reset -f /org/gnome/shell/extensions/snowhush/ 2> /dev/null || true
echo "Snowhush is uninstalled. The snow on screen goes with your next login."
