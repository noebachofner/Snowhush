// Checking for a newer Snowhush for GNOME: the version in the repository's own copy of this extension.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const REPOSITORY = 'noebachofner/Snowhush';
const METADATA = `https://raw.githubusercontent.com/${REPOSITORY}/HEAD/linux/extension/metadata.json`;
/// Where a newer version is, with how to install it.
export const PAGE = `https://github.com/${REPOSITORY}/tree/HEAD/linux#readme`;

/// Whether `candidate` is a later version than `current`.
export function newer(candidate, current) {
    const parse = version => `${version}`.split('.').map(part => parseInt(part, 10) || 0).concat([0, 0, 0]).slice(0, 3);
    const [a, b] = [parse(candidate), parse(current)];
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i])
            return a[i] > b[i];
    }
    return false;
}

/// Checks for updates and says so: once a day quietly, speaking up only about a new version, and once at a time.
export class Updates {
    constructor(app) {
        this._app = app;
        this._current = app.metadata['version-name'] ?? '0';
        this._session = new Soup.Session({user_agent: `Snowhush/${this._current}`, timeout: 15});
        this._cancellable = new Gio.Cancellable();
        /// The version the last notification announced, so each is announced once.
        this._announced = null;
        this._source = null;
        // The first check waits until the desktop has settled after login.
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 30, () => {
            this.check(false);
            this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 24 * 60 * 60, () => {
                this.check(false);
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._source?.destroy();
        this._source = null;
        this._dialog?.close();
        this._session.abort();
    }

    /// `asked`: someone chose Check for Updates, so the answer is always shown.
    check(asked) {
        const message = Soup.Message.new('GET', METADATA);
        this._session.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable, (session, result) => {
            let latest;
            try {
                const bytes = session.send_and_read_finish(result);
                const status = message.get_status();
                if (status !== Soup.Status.OK)
                    throw new Error(`GitHub answered ${status}`);
                latest = JSON.parse(new TextDecoder().decode(bytes.get_data()))['version-name'];
                if (!latest)
                    throw new Error('the latest version has no version number');
            } catch (error) {
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                console.log(`Snowhush: update check failed: ${error.message}`);
                if (asked)
                    this._say("Couldn't check for updates.", error.message);
                return;
            }
            this._answer(latest, asked);
        });
    }

    _answer(latest, asked) {
        const current = this._current;
        if (!newer(latest, current)) {
            if (asked)
                this._say("You're up to date.", `Snowhush ${current} is the latest version.`);
        } else if (asked) {
            this._say(`Snowhush ${latest} is available.`, `You have ${current}.\n\nOpen the download page now?`,
                'Open Download Page', () => open(PAGE));
        } else if (this._announced !== latest) {
            this._announced = latest;
            this._notify(`Snowhush ${latest} is available`, 'Click to download it.');
        }
    }

    _say(title, description, action, activate) {
        this._dialog?.close();
        const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
        const buttons = [{label: action ? 'Cancel' : 'OK', action: () => dialog.close(), key: 0xff1b /* Escape */, default: !action}];
        if (action)
            buttons.push({label: action, action: () => {
                dialog.close();
                activate();
            }, default: true});
        dialog.setButtons(buttons);
        dialog.connect('closed', () => {
            if (this._dialog === dialog)
                this._dialog = null;
        });
        this._dialog = dialog;
        dialog.open();
    }

    _notify(title, body) {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: 'Snowhush',
                icon: Gio.icon_new_for_string(`${this._app.path}/icons/snowhush.png`),
            });
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
        const notification = new MessageTray.Notification({source: this._source, title, body});
        notification.connect('activated', () => open(PAGE));
        this._source.addNotification(notification);
    }
}

function open(url) {
    try {
        Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1));
    } catch (error) {
        console.log(`Snowhush: couldn't open ${url}: ${error.message}`);
    }
}
