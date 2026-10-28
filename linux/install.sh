#!/bin/bash
# Installs Snowhush for GNOME for this user, without administrator rights: the extension, its settings,
# and Snowhush in the app grid. Running it again updates an installed copy.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
uuid=snowhush@snowhush.pages.dev
data=${XDG_DATA_HOME:-$HOME/.local/share}
target=$data/gnome-shell/extensions/$uuid
tested=46

command -v gnome-shell > /dev/null || { echo "Snowhush needs the GNOME desktop (Zorin OS Core, Pro or Education), and GNOME Shell isn't installed." >&2; exit 1; }
command -v glib-compile-schemas > /dev/null || { echo "glib-compile-schemas is missing: sudo apt install libglib2.0-bin" >&2; exit 1; }
version=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)

echo "Installing Snowhush into $target"
rm -rf "$target"
mkdir -p "$target"
cp -r "$here/extension/." "$target/"
glib-compile-schemas "$target/schemas"
chmod +x "$target/open.sh"
if [[ $version != "$tested" ]]; then
    # GNOME only loads an extension made for its own version; this one is tried on the running version anyway.
    echo "Note: Snowhush was made and tested for GNOME $tested (Zorin OS 18). This is GNOME $version, so it may not work fully."
    sed -i "s/\"shell-version\": \[/\"shell-version\": [\n    \"$version\",/" "$target/metadata.json"
fi

# Snowhush in the app grid, which opens it again after Quit.
mkdir -p "$data/applications" "$data/icons/hicolor/256x256/apps"
cp "$here/extension/icons/snowhush.png" "$data/icons/hicolor/256x256/apps/snowhush.png"
cat > "$data/applications/snowhush.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Snowhush
Comment=It's snowing on your desktop
Icon=snowhush
Exec=sh "$target/open.sh"
Terminal=false
Categories=Utility;
Keywords=snow;winter;weather;desktop;
StartupNotify=false
DESKTOP
gtk-update-icon-cache -q -t "$data/icons/hicolor" 2>/dev/null || true
update-desktop-database -q "$data/applications" 2>/dev/null || true

# Turned on for the next login, and right away where the shell already knows it, as after an update.
if [[ $(gsettings get org.gnome.shell disable-user-extensions) == true ]]; then
    gsettings set org.gnome.shell disable-user-extensions false
    echo "Turned on extensions, which were switched off in the Extensions app."
fi
enabled=$(gsettings get org.gnome.shell enabled-extensions)
if [[ $enabled != *"'$uuid'"* ]]; then
    if [[ $enabled == "@as []" || $enabled == "[]" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['$uuid']"
    else
        gsettings set org.gnome.shell enabled-extensions "${enabled%]*}, '$uuid']"
    fi
fi
gnome-extensions enable "$uuid" 2> /dev/null || true

echo
echo "Snowhush is installed."
if [[ ${XDG_SESSION_TYPE:-} == x11 ]]; then
    echo "Press Alt+F2, type r and press Enter to restart GNOME Shell, and the snow starts."
else
    echo "Log out and back in to start the snow: GNOME can't load new extension code into a running Wayland session."
fi
