#!/bin/bash
# Starts a headless GNOME Shell with Snowhush and a test helper that allows driving it over D-Bus,
# in a throwaway home folder, and runs the given command against it. For development only.
#   linux/tests/headless.sh [WIDTHxHEIGHT...] -- command...
# The shell runs with animations, as on a machine with a GPU, though it draws in software here.
# SNOWHUSH_SETTINGS holds the extension's settings as keyfile lines; by default the snow shows in screenshots.
# The command gets SHELL_EVAL (a script evaluating JavaScript in the shell) and SCREENSHOT (one that saves a PNG).
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
# Each size before -- adds a virtual monitor.
monitors=""
while [[ -n ${1:-} && ${1:-} != -- ]]; do monitors+=" --virtual-monitor $1"; shift; done
monitors=${monitors:- --virtual-monitor 1600x900}
[[ ${1:-} == -- ]] && shift

work=$(mktemp -d)
export HOME=$work/home XDG_RUNTIME_DIR=$work/run XDG_CONFIG_HOME=$work/home/.config XDG_DATA_HOME=$work/home/.local/share
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME/gnome-shell/extensions" && chmod 700 "$XDG_RUNTIME_DIR"
export GSETTINGS_BACKEND=keyfile
cp -r "$here/extension" "$XDG_DATA_HOME/gnome-shell/extensions/snowhush@snowhush.pages.dev"
cp -r "$here/tests/helper" "$XDG_DATA_HOME/gnome-shell/extensions/snowhush-test-helper@snowhush.pages.dev"
if [[ -d $here/extension/schemas ]]; then
    glib-compile-schemas "$XDG_DATA_HOME/gnome-shell/extensions/snowhush@snowhush.pages.dev/schemas"
fi
mkdir -p "$XDG_CONFIG_HOME/glib-2.0/settings"
cat > "$XDG_CONFIG_HOME/glib-2.0/settings/keyfile" <<KEYS
[org/gnome/shell]
disable-user-extensions=false
enabled-extensions=['snowhush-test-helper@snowhush.pages.dev', 'snowhush@snowhush.pages.dev']
welcome-dialog-last-shown-version='999'

[org/gnome/shell/extensions/snowhush]
${SNOWHUSH_SETTINGS:-show-in-screenshots=true}
KEYS

cat > "$work/eval" <<'SCRIPT'
#!/bin/bash
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"
SCRIPT
cat > "$work/screenshot" <<'SCRIPT'
#!/bin/bash
gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot false false "$1" > /dev/null
SCRIPT
chmod +x "$work/eval" "$work/screenshot"
export SHELL_EVAL=$work/eval SCREENSHOT=$work/screenshot SHELL_LOG=$work/shell.log

# Without a system bus, GNOME Shell must not take the machine for one running systemd-logind.
hide_logind=()
if [[ -d /run/systemd/seats ]] && ! gdbus introspect --system --dest org.freedesktop.login1 --object-path / > /dev/null 2>&1; then
    hide_logind=(unshare --mount bash -c 'mount -t tmpfs none /run/systemd && exec "$@"' bash)
fi

"${hide_logind[@]}" dbus-run-session -- bash -c '
    # A bus of its own stands in for the system bus, which a container may not have.
    if ! gdbus introspect --system --dest org.freedesktop.DBus --object-path / > /dev/null 2>&1; then
        export DBUS_SYSTEM_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address --address=unix:path=$XDG_RUNTIME_DIR/system_bus)
    fi
    gnome-shell --headless --wayland --no-x11 --force-animations '"$monitors"' > "$SHELL_LOG" 2>&1 &
    shell=$!
    for _ in $(seq 100); do
        "$SHELL_EVAL" "1" 2>/dev/null | grep -q true && break
        sleep 0.2
    done
    # GNOME starts in the overview once its startup animation is done; the overview hides the windows and the snow.
    for _ in $(seq 100); do
        "$SHELL_EVAL" "!Main.layoutManager._startingUp" 2>/dev/null | grep -q "true, .true" && break
        sleep 0.2
    done
    for _ in $(seq 50); do
        "$SHELL_EVAL" "Main.overview.hide(); Main.messageTray._bannerBin.hide(); !Main.overview.visible" 2>/dev/null |
            grep -q "true, .true" && break
        sleep 0.2
    done
    status=0
    "$@" || status=$?
    kill $shell 2>/dev/null; wait $shell 2>/dev/null
    exit $status
' bash "$@"
