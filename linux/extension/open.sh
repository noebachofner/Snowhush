#!/bin/sh
# What the Snowhush launcher in the app grid runs: turns the extension on if it's off, and starts the snow if it was quit.
gnome-extensions enable snowhush@snowhush.pages.dev 2>/dev/null
exec gdbus call --session --dest org.gnome.Shell --object-path /dev/snowhush/Snowhush \
    --method dev.snowhush.Snowhush.Open > /dev/null
