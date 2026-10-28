# Snowhush for Linux (GNOME)

It's snowing on your desktop, on Linux too. This is Snowhush as a GNOME Shell extension, made for **Zorin OS 18**
(Core, Pro and Education) and other desktops on **GNOME 46**, such as Ubuntu 24.04. It works the same in a Wayland
session and on Xorg.

Why an extension and not an app: on Wayland, GNOME doesn't let ordinary apps draw over other windows or see where they
are. An extension runs inside the desktop itself, so the snow can sit on your windows and your taskbar, follow your
pointer and stay out of screenshots, just as on macOS and Windows.

## Install

You need Git, or download the repository as a ZIP from GitHub and unpack it. Then, in a Terminal:

```sh
git clone https://github.com/noebachofner/Snowhush.git
cd Snowhush
linux/install.sh
```

Then **log out and back in**. A Wayland session can't load new extension code while it runs. On Xorg, pressing
Alt+F2, typing `r` and pressing Enter works too. The first time, a welcome card shows; press **Get Started** and it
crumbles into snow.

The installer works for your user only, without administrator rights. It puts the extension in
`~/.local/share/gnome-shell/extensions/snowhush@snowhush.pages.dev`, adds **Snowhush** to the app grid, and turns the
extension on. Running it again updates an installed copy, and then you log out and back in again.

## Using it

Snowhush lives in the system tray: the snowflake in Zorin's taskbar, or in the top bar on standard GNOME. Its menu has
everything, as on macOS and Windows:

- **Snowfall**: a slider from Off through Light, Steady and Heavy to Variable, which lets the snowfall rise and ease
  on its own over the day.
- **Accumulate**, **Melt Snow**, **Snow on Windows** and **Clear Snow**.
- **Behind Windows**: the snow falls on the desktop behind your windows instead of in front of them.
- **Show in Screenshots**, **Open at Login**, **Check for Updates…** and **Quit**.

The same options are under Settings in the Extensions app. After **Quit**, open **Snowhush** from the app grid to bring
the snow back. With Open at Login off, Snowhush waits at login until you open it from the app grid.

## What the snow does

- **Falls**, each flake at its own pace, swaying in a slow breeze.
- **Settles** in drifts along the bottom of the screen, on top of the taskbar, and on any window with room above it,
  following its rounded corners.
- **Moves**: push the pointer through a drift and it parts and sprays. Drag a window and its snow rides along; shake it
  and the snow slides off and lands below.
- **Drops**: close or minimize a window and its snow drops at once, in lumps that burst into powder where they land.
  Move a window to another workspace and its snow waits for it.
- **Melts** slowly with Melt Snow on, so it never takes over your screen.
- **Rests**: it pauses on the lock screen, while the screen is off, in the Activities overview and behind full-screen
  apps. On battery it draws at most 60 frames a second, and in Power Saver a little less snow falls.
- With **Animations** turned off (Settings → Accessibility → Reduce Animation, or in Tweaks), the snowfall starts out
  Light and Clear Snow melts the snow where it lies instead of blowing it away.
- The time of day tints the light, and the shadows in the drifts pick up the colour of your wallpaper.

## Screenshots and screen sharing

With Show in Screenshots off, screenshots leave the snow out: the Print key, the screenshot tool and apps that take
screenshots through GNOME. Linux can't keep a layer out of a recording or a shared screen while still showing it to
you, so while the screen is recorded or shared, the snow hides and pauses. Turn on Show in Screenshots to keep the
snow in all of them.

## Updating and uninstalling

Check for Updates compares your copy with this repository. To update:

```sh
cd Snowhush
git pull
linux/install.sh
```

and log out and back in. To remove Snowhush and its settings:

```sh
linux/uninstall.sh
```

## If something's wrong

- Check that the extension is on in the Extensions app, and that it shows no error there.
- GNOME's log says what went wrong: `journalctl -b -o cat /usr/bin/gnome-shell | grep -i snowhush`.
- `gnome-shell --version` should say 46. The installer lets a different version try, but Snowhush is only tested on 46.

## For developers

The extension is plain JavaScript; nothing needs building. `simulation.js` and `layer.js` port the simulation of the
Windows app (`windows/src/simulation.rs` and `layer.rs`) and `renderer.js` its shaders (`windows/src/shaders.hlsl`), so
the snow looks and behaves the same everywhere.

```sh
gjs -m linux/tests/simulation.test.js            # the simulation's tests, ported from windows/src/tests.rs
gjs -m linux/tests/simulation.test.js --bench    # what a step costs
linux/build.sh                                   # dist/snowhush@snowhush.pages.dev.shell-extension.zip
```

`linux/tests/headless.sh` starts a headless GNOME Shell with the extension, in a throwaway home folder, and runs a
command against it: `$SHELL_EVAL` evaluates JavaScript in the shell and `$SCREENSHOT` saves a screenshot. It needs
`gnome-shell`, and sizes given before `--` add virtual monitors:

```sh
linux/tests/headless.sh 1280x800 -- bash -c 'sleep 30; "$SCREENSHOT" /tmp/snow.png'
```
