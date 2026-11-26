import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MPRIS_INTERFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="PlaybackStatus" type="s" access="read"/>
  </interface>
</node>`;
const MprisProxyWrapper = Gio.DBusProxy.makeProxyWrapper(MPRIS_INTERFACE);

const RESTORE_SCRIPT = GLib.build_filenamev([
    GLib.get_home_dir(),
    'SystemFiles',
    'dynamic-wallpaper-wayland',
    'gnome-wall.sh',
]);

export default class SpotifyVinylWallpaperExtension extends Extension {
    enable() {
        this._httpSession = new Soup.Session();
        this._bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        this._extSettings = this.getSettings('org.gnome.shell.extensions.spotify-vinyl-wallpaper');

        this._loadDb();

        this._isSpotifyActive = false;
        this._currentArtistUri = null;
        this._currentArtist = null;
        this._currentTrackId = null;
        this._currentArtUrl = null;
        this._lastStatus = null;
        this._stopTimerId = null;

        this._proxy = null;
        this._proxyPropId = null;

        const vinylSize = this._extSettings.get_int('vinyl-size') || 200;

        // Container for vinyl layers
        this._container = new Clutter.Actor({
            reactive: true,
            visible: false,
            opacity: 0,
            width: vinylSize,
            height: vinylSize,
        });

        // Layer 1: Rotating Disc (vinyl body, grooves, album art label, spindle hole)
        this._discArea = new St.DrawingArea({
            width: vinylSize,
            height: vinylSize,
            x: 0,
            y: 0,
        });
        this._discArea.set_pivot_point(0.5, 0.5);
        this._discArea.connect('repaint', (area) => this._drawDisc(area));
        this._container.add_child(this._discArea);

        // Layer 2: Stationary Specular Sheen (reflections do NOT rotate)
        this._sheenArea = new St.DrawingArea({
            width: vinylSize,
            height: vinylSize,
            x: 0,
            y: 0,
        });
        this._sheenArea.connect('repaint', (area) => this._drawSheen(area));
        this._container.add_child(this._sheenArea);

        // Click on vinyl container toggles Play/Pause on Spotify
        this._container.connect('button-release-event', () => {
            if (this._proxy) {
                try { this._proxy.PlayPauseRemote(); } catch (_) {}
            }
            return Clutter.EVENT_STOP;
        });

        // Attach to stage based on "always-on-top" setting
        this._attachVinylToStage();

        // Keep vinyl on top of background group when new wallpaper actors are added
        const bgGroup = Main.layoutManager._backgroundGroup;
        if (bgGroup) {
            this._bgChildAddedId = bgGroup.connect('child-added', (group, child) => {
                if (child !== this._container && this._container && this._container.get_parent() === group) {
                    group.set_child_above_sibling(this._container, null);
                }
            });
        }

        // Reposition on display change
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._updateVinylPosition();
        });

        // Optimization: pause continuous spinning when screen is locked or overview is active
        this._overviewShowingId = Main.overview.connect('showing', () => this._onVisibilityChanged());
        this._overviewHidingId = Main.overview.connect('hiding', () => this._onVisibilityChanged());
        if (Main.screenShield) {
            this._screenShieldId = Main.screenShield.connect('active-changed', () => this._onVisibilityChanged());
        }

        // Settings change listeners
        this._settingsSignals = [];
        const watchSetting = (key, cb) => {
            this._settingsSignals.push(this._extSettings.connect(`changed::${key}`, cb));
        };

        watchSetting('always-on-top', () => this._attachVinylToStage());
        watchSetting('margin-x', () => this._updateVinylPosition());
        watchSetting('margin-y', () => this._updateVinylPosition());
        watchSetting('inner-size', () => {
            if (this._currentArtUrl) {
                this._updateAlbumArt(this._currentArtUrl);
            } else if (this._discArea) {
                this._discArea.queue_repaint();
            }
        });
        watchSetting('cover-scale', () => {
            if (this._currentArtUrl) {
                this._updateAlbumArt(this._currentArtUrl);
            } else if (this._discArea) {
                this._discArea.queue_repaint();
            }
        });
        watchSetting('prefer-logo', () => {
            if (this._isSpotifyActive && this._currentArtist) {
                this._updateArtistWallpaper(this._currentArtist, this._currentTrackId, this._currentArtUrl, true);
            }
        });
        watchSetting('cache-max-artists', () => this._enforceCacheLimits());
        watchSetting('cache-max-size-mb', () => this._enforceCacheLimits());
        watchSetting('vinyl-size', () => {
            const sz = this._extSettings.get_int('vinyl-size') || 200;
            this._container.set_size(sz, sz);
            this._discArea.set_size(sz, sz);
            this._sheenArea.set_size(sz, sz);
            if (this._currentArtUrl) {
                this._updateAlbumArt(this._currentArtUrl);
            } else {
                this._discArea.queue_repaint();
            }
            this._sheenArea.queue_repaint();
            this._updateVinylPosition();
        });
        watchSetting('vinyl-speed', () => {
            if (this._lastStatus === 'Playing') {
                this._pauseVinylSpin();
                this._startVinylSpin();
            }
        });
        watchSetting('show-vinyl', () => {
            const show = this._extSettings.get_boolean('show-vinyl');
            if (!show) {
                this._hideVinyl();
            } else if (this._isSpotifyActive) {
                this._showVinyl();
                if (this._lastStatus === 'Playing') {
                    this._startVinylSpin();
                } else {
                    this._pauseVinylSpin();
                }
            }
        });

        // Restore artist wallpaper if external hourly cron overwrites it while Spotify is active
        this._bgChangedId = this._bgSettings.connect('changed::picture-uri', () => {
            if (this._isSpotifyActive && this._currentArtistUri) {
                const currentUri = this._bgSettings.get_string('picture-uri');
                if (currentUri !== this._currentArtistUri) {
                    this._bgSettings.set_string('picture-uri', this._currentArtistUri);
                    this._bgSettings.set_string('picture-uri-dark', this._currentArtistUri);
                }
            }
        });

        // Watch Spotify on DBus
        this._busWatchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            'org.mpris.MediaPlayer2.spotify',
            Gio.BusNameWatcherFlags.NONE,
            () => this._onSpotifyAppeared(),
            () => this._onSpotifyVanished()
        );
    }

    _attachVinylToStage() {
        if (!this._container) return;

        const parent = this._container.get_parent();
        if (parent) {
            parent.remove_child(this._container);
        }

        const alwaysOnTop = this._extSettings.get_boolean('always-on-top');
        if (alwaysOnTop) {
            if (Main.uiGroup) {
                Main.uiGroup.add_child(this._container);
            }
        } else {
            const bgGroup = Main.layoutManager._backgroundGroup;
            if (bgGroup) {
                bgGroup.add_child(this._container);
                bgGroup.set_child_above_sibling(this._container, null);
            } else if (Main.uiGroup) {
                Main.uiGroup.add_child(this._container);
            }
        }

        this._updateVinylPosition();

        if (this._discArea) {
            this._discArea.queue_repaint();
        }
        if (this._sheenArea) {
            this._sheenArea.queue_repaint();
        }

        const showAllowed = this._extSettings.get_boolean('show-vinyl');
        if (showAllowed && this._isSpotifyActive && (this._lastStatus === 'Playing' || this._lastStatus === 'Paused')) {
            this._showVinyl();
            if (this._lastStatus === 'Playing') {
                this._startVinylSpin();
            } else {
                this._pauseVinylSpin();
            }
        }
    }

    _updateVinylPosition() {
        if (!this._container) return;
        const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
        if (!monitor) return;

        const mx = this._extSettings.get_int('margin-x') ?? 36;
        const my = this._extSettings.get_int('margin-y') ?? 36;
        const panelHeight = (Main.panel && Main.panel.visible) ? Main.panel.height : 0;

        const x = monitor.x + mx;
        const y = monitor.y + panelHeight + my;

        this._container.set_position(x, y);
    }

    _onSpotifyAppeared() {
        if (this._proxyPropId && this._proxy) {
            this._proxy.disconnect(this._proxyPropId);
            this._proxyPropId = null;
        }

        this._proxy = new MprisProxyWrapper(
            Gio.DBus.session,
            'org.mpris.MediaPlayer2.spotify',
            '/org/mpris/MediaPlayer2'
        );

        this._proxyPropId = this._proxy.connect('g-properties-changed', () => {
            this._onMprisChanged();
        });

        this._onMprisChanged();
    }

    _onSpotifyVanished() {
        if (this._stopTimerId) {
            GLib.source_remove(this._stopTimerId);
            this._stopTimerId = null;
        }

        if (this._proxyPropId && this._proxy) {
            this._proxy.disconnect(this._proxyPropId);
            this._proxyPropId = null;
        }
        this._proxy = null;

        this._isSpotifyActive = false;
        this._currentArtistUri = null;
        this._currentArtist = null;
        this._currentTrackId = null;
        this._currentArtUrl = null;
        this._albumPixbuf = null;

        this._hideVinyl();
        this._restoreWallpaper();
    }

    _onMprisChanged() {
        if (!this._proxy) return;

        let status = 'Stopped';
        try {
            status = this._proxy.PlaybackStatus || 'Stopped';
        } catch (_) {}

        let meta = null;
        try {
            const raw = this._proxy.Metadata;
            if (raw) {
                meta = {};
                for (const k in raw) {
                    const v = raw[k];
                    meta[k] = (v instanceof GLib.Variant) ? v.recursiveUnpack() : v;
                }
            }
        } catch (_) {}

        // Handle brief Stopped transitions during song switching (800ms debounce)
        if (status === 'Stopped' || !meta) {
            this._pauseVinylSpin();
            if (!this._stopTimerId) {
                this._stopTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                    this._stopTimerId = null;
                    if (!this._proxy || this._lastStatus === 'Stopped') {
                        this._onSpotifyVanished();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }

        if (this._stopTimerId) {
            GLib.source_remove(this._stopTimerId);
            this._stopTimerId = null;
        }

        const artists = meta['xesam:artist'];
        const artist = Array.isArray(artists) ? artists[0] : (artists || 'Unknown');
        const artUrl = meta['mpris:artUrl'] || null;
        const trackId = meta['mpris:trackid'] || null;

        this._isSpotifyActive = true;
        this._lastStatus = status;

        const showAllowed = this._extSettings.get_boolean('show-vinyl');
        if (status === 'Playing') {
            if (showAllowed) {
                this._showVinyl();
                this._startVinylSpin();
            }
        } else if (status === 'Paused') {
            if (showAllowed) {
                this._showVinyl();
            }
            this._pauseVinylSpin();
        }

        const artistChanged = (artist !== this._currentArtist);
        const artChanged = (artUrl !== this._currentArtUrl);

        if (artistChanged || !this._currentArtistUri) {
            this._currentArtist = artist;
            this._currentTrackId = trackId;
            this._updateArtistWallpaper(artist, trackId, artUrl);
        }

        if (artChanged || !this._albumPixbuf) {
            this._currentArtUrl = artUrl;
            this._updateAlbumArt(artUrl);
        }
    }

    _getStorageDir() {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'spotify-vinyl-wallpaper']);
        GLib.mkdir_with_parents(dir, 0o755);
        return dir;
    }

    _getDbPath() {
        return GLib.build_filenamev([this._getStorageDir(), 'artists_db.json']);
    }

    _loadDb() {
        this._db = { artists: {} };
        const dbPath = this._getDbPath();
        if (GLib.file_test(dbPath, GLib.FileTest.EXISTS)) {
            try {
                const [ok, contents] = GLib.file_get_contents(dbPath);
                if (ok) {
                    const parsed = JSON.parse(new TextDecoder().decode(contents));
                    if (parsed && typeof parsed.artists === 'object') {
                        this._db = parsed;
                    }
                }
            } catch (e) {
                console.warn('[SpotifyVinyl] Could not load artists DB:', e.message);
            }
        }
    }

    _saveDb() {
        try {
            const dbPath = this._getDbPath();
            const data = JSON.stringify(this._db, null, 2);
            const file = Gio.File.new_for_path(dbPath);
            file.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn('[SpotifyVinyl] Could not save artists DB:', e.message);
        }
    }

    _getCachedArtist(safeName) {
        if (!this._db || !this._db.artists) return null;
        const entry = this._db.artists[safeName];
        if (!entry) return null;

        const hasWallpaper = entry.wallpaperPath && GLib.file_test(entry.wallpaperPath, GLib.FileTest.EXISTS);
        const hasImage = entry.imagePath && GLib.file_test(entry.imagePath, GLib.FileTest.EXISTS);
        if (!hasWallpaper && !hasImage) {
            delete this._db.artists[safeName];
            this._saveDb();
            return null;
        }

        // Ensure we use a valid composed wallpaper, not an uncomposed raw image
        if (!hasWallpaper || entry.wallpaperPath === entry.imagePath) {
            return null;
        }

        entry.playCount = (entry.playCount || 0) + 1;
        entry.lastPlayed = Date.now();
        this._saveDb();
        return entry;
    }

    _recordCachedArtist(safeName, name, imagePath, wallpaperPath) {
        if (!this._db) this._db = { artists: {} };
        const existing = this._db.artists[safeName] || {};

        let fileSize = 0;
        try {
            if (wallpaperPath && GLib.file_test(wallpaperPath, GLib.FileTest.EXISTS)) {
                const f = Gio.File.new_for_path(wallpaperPath);
                const info = f.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
                fileSize += info.get_size();
            }
            if (imagePath && GLib.file_test(imagePath, GLib.FileTest.EXISTS)) {
                const f = Gio.File.new_for_path(imagePath);
                const info = f.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
                fileSize += info.get_size();
            }
        } catch (_) {}

        this._db.artists[safeName] = {
            name: name,
            imagePath: imagePath,
            wallpaperPath: wallpaperPath,
            playCount: (existing.playCount || 0) + 1,
            lastPlayed: Date.now(),
            fileSize: fileSize,
        };

        this._saveDb();
        this._enforceCacheLimits();
    }

    _enforceCacheLimits() {
        if (!this._db || !this._db.artists) return;

        const maxArtists = this._extSettings.get_int('cache-max-artists') || 50;
        const maxMb = this._extSettings.get_int('cache-max-size-mb') || 200;
        const maxBytes = maxMb * 1024 * 1024;

        const entries = Object.entries(this._db.artists);
        let totalBytes = entries.reduce((acc, [_, item]) => acc + (item.fileSize || 0), 0);

        if (entries.length <= maxArtists && totalBytes <= maxBytes) {
            return;
        }

        // Sort: lowest playCount first; if playCount equal, oldest lastPlayed first
        entries.sort((a, b) => {
            const countA = a[1].playCount || 0;
            const countB = b[1].playCount || 0;
            if (countA !== countB) return countA - countB;
            return (a[1].lastPlayed || 0) - (b[1].lastPlayed || 0);
        });

        // Prune from start (least frequent / oldest)
        while (entries.length > 0 && (entries.length > maxArtists || totalBytes > maxBytes)) {
            const [pruneKey, pruneItem] = entries.shift();
            try {
                if (pruneItem.wallpaperPath && GLib.file_test(pruneItem.wallpaperPath, GLib.FileTest.EXISTS)) {
                    Gio.File.new_for_path(pruneItem.wallpaperPath).delete(null);
                }
                if (pruneItem.imagePath && GLib.file_test(pruneItem.imagePath, GLib.FileTest.EXISTS)) {
                    Gio.File.new_for_path(pruneItem.imagePath).delete(null);
                }
            } catch (_) {}

            totalBytes -= (pruneItem.fileSize || 0);
            delete this._db.artists[pruneKey];
        }

        this._saveDb();
    }

    async _updateArtistWallpaper(artist, trackId, fallbackArtUrl, force = false) {
        if (!artist || artist === 'Unknown') return;

        const primaryArtist = artist.split(/[,&/]/)[0].trim();
        const safeName = primaryArtist.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const preferLogo = this._extSettings.get_boolean('prefer-logo');
        const dbKey = `${safeName}_${preferLogo ? 'logo' : 'photo'}`;

        const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
        const targetW = monitor ? monitor.width : 1920;
        const targetH = monitor ? monitor.height : 1080;

        // 1. Check local DB cache first (zero network hits for frequent artists)
        if (!force) {
            const cachedEntry = this._getCachedArtist(dbKey);
            if (cachedEntry && cachedEntry.wallpaperPath && GLib.file_test(cachedEntry.wallpaperPath, GLib.FileTest.EXISTS)) {
                this._applyWallpaperUri(cachedEntry.wallpaperPath);
                return;
            }
        }

        // 2. Fetch artist visuals (logo / fanart / photo)
        const visuals = await this._fetchArtistVisuals(artist, trackId);

        let wallpaperPath = null;
        let sourcePath = null;

        if (visuals && visuals.type === 'logo') {
            sourcePath = visuals.logoPath;
            const composedPath = GLib.build_filenamev([this._getStorageDir(), `composed_logo_${safeName}_${targetW}x${targetH}.png`]);
            wallpaperPath = this._composeLogoWallpaper(visuals.logoPath, visuals.backdropPath, composedPath, targetW, targetH);
        } else {
            const imagePath = visuals?.imagePath || (fallbackArtUrl ? await this._fetchAlbumArt(fallbackArtUrl) : null);
            if (imagePath) {
                sourcePath = imagePath;
                const composedPath = GLib.build_filenamev([this._getStorageDir(), `composed_photo_${safeName}_${targetW}x${targetH}.png`]);
                wallpaperPath = this._composeWidescreenWallpaper(imagePath, composedPath, targetW, targetH);
            }
        }

        if (wallpaperPath && this._isSpotifyActive) {
            this._recordCachedArtist(dbKey, artist, sourcePath, wallpaperPath);
            this._applyWallpaperUri(wallpaperPath);
        }
    }

    _applyWallpaperUri(filePath) {
        this._currentArtistUri = GLib.filename_to_uri(filePath, null);
        this._bgSettings.set_string('picture-uri', this._currentArtistUri);
        this._bgSettings.set_string('picture-uri-dark', this._currentArtistUri);
        Gio.Settings.sync();
    }

    _composeLogoWallpaper(logoPath, backdropPath, outputPath, targetW = 1920, targetH = 1080) {
        try {
            if (GLib.file_test(outputPath, GLib.FileTest.EXISTS)) {
                return outputPath;
            }

            const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, targetW, targetH);
            const cr = new Cairo.Context(surface);

            // 1. Deep black background
            cr.setSourceRGB(0.02, 0.02, 0.03);
            cr.paint();

            if (!logoPath || !GLib.file_test(logoPath, GLib.FileTest.EXISTS)) {
                surface.writeToPNG(outputPath);
                cr.$dispose();
                return outputPath;
            }

            const logoPixbuf = GdkPixbuf.Pixbuf.new_from_file(logoPath);
            const lw = logoPixbuf.get_width();
            const lh = logoPixbuf.get_height();

            // Fit logo cleanly without any cropping (keeping aspect ratio)
            const maxW = Math.round(targetW * 0.52);
            const maxH = Math.round(targetH * 0.44);
            const scale = Math.min(maxW / lw, maxH / lh);

            const scaledW = Math.max(10, Math.round(lw * scale));
            const scaledH = Math.max(10, Math.round(lh * scale));

            const centerX = Math.round(targetW * 0.52);
            const centerY = Math.round(targetH * 0.50);

            const posX = Math.round(centerX - scaledW / 2);
            const posY = Math.round(centerY - scaledH / 2);

            // 2. Extract logo accent color for ambient backlight glow
            const [cr_r, cr_g, cr_b] = this._extractLogoAccentColor(logoPixbuf);

            // 3. Subtle backlight in logo's color (тихая подсветка цветом логотипа)
            const glowRadius = Math.max(scaledW, scaledH) * 0.95;
            const glow = new Cairo.RadialGradient(
                centerX, centerY, 30,
                centerX, centerY, glowRadius
            );
            glow.addColorStopRGBA(0.0, cr_r, cr_g, cr_b, 0.28);
            glow.addColorStopRGBA(0.4, cr_r, cr_g, cr_b, 0.12);
            glow.addColorStopRGBA(0.8, cr_r, cr_g, cr_b, 0.02);
            glow.addColorStopRGBA(1.0, 0.02, 0.02, 0.03, 0.0);
            cr.setSource(glow);
            cr.paint();

            // 4. Render crisp artist logo with soft drop shadow
            const scaledLogo = logoPixbuf.scale_simple(scaledW, scaledH, GdkPixbuf.InterpType.HYPER);

            // Soft shadow behind logo for depth
            cr.save();
            Gdk.cairo_set_source_pixbuf(cr, scaledLogo, posX, posY + 5);
            cr.paintWithAlpha(0.50);
            cr.restore();

            // Main logo
            cr.save();
            Gdk.cairo_set_source_pixbuf(cr, scaledLogo, posX, posY);
            cr.paint();
            cr.restore();

            surface.writeToPNG(outputPath);
            cr.$dispose();
            return outputPath;
        } catch (e) {
            console.error('[SpotifyVinyl] Error composing logo wallpaper:', e);
            return logoPath || backdropPath;
        }
    }

    _extractLogoAccentColor(logoPixbuf) {
        try {
            const thumb = logoPixbuf.scale_simple(16, 16, GdkPixbuf.InterpType.BILINEAR);
            const pixels = thumb.get_pixels();
            const nChannels = thumb.get_n_channels();
            const rowstride = thumb.get_rowstride();

            let rSum = 0, gSum = 0, bSum = 0, count = 0;
            for (let y = 0; y < 16; y++) {
                for (let x = 0; x < 16; x++) {
                    const offset = y * rowstride + x * nChannels;
                    const a = (nChannels === 4) ? pixels[offset + 3] : 255;
                    if (a > 60) {
                        const r = pixels[offset];
                        const g = pixels[offset + 1];
                        const b = pixels[offset + 2];
                        if (r > 20 || g > 20 || b > 20) {
                            rSum += r;
                            gSum += g;
                            bSum += b;
                            count++;
                        }
                    }
                }
            }

            if (count > 0) {
                return [rSum / count / 255, gSum / count / 255, bSum / count / 255];
            }
        } catch (_) {}

        return [0.75, 0.75, 0.85];
    }

    _composeWidescreenWallpaper(inputPath, outputPath, targetW = 1920, targetH = 1080) {
        try {
            if (GLib.file_test(outputPath, GLib.FileTest.EXISTS)) {
                return outputPath;
            }

            const srcPixbuf = GdkPixbuf.Pixbuf.new_from_file(inputPath);
            const sw = srcPixbuf.get_width();
            const sh = srcPixbuf.get_height();

            const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, targetW, targetH);
            const cr = new Cairo.Context(surface);

            // 1. Dark solid background
            cr.setSourceRGB(0.06, 0.06, 0.07);
            cr.paint();

            // 2. Ambient backdrop: image scaled to cover widescreen, dimmed
            const scaleBg = Math.max(targetW / sw, targetH / sh);
            const bgW = Math.round(sw * scaleBg);
            const bgH = Math.round(sh * scaleBg);
            const bgX = Math.round((targetW - bgW) / 2);
            const bgY = Math.round((targetH - bgH) / 2);

            const bgPixbuf = srcPixbuf.scale_simple(bgW, bgH, GdkPixbuf.InterpType.BILINEAR);
            cr.save();
            Gdk.cairo_set_source_pixbuf(cr, bgPixbuf, bgX, bgY);
            cr.paintWithAlpha(0.25);
            cr.restore();

            // Vignette over ambient backdrop
            const vignette = new Cairo.RadialGradient(targetW / 2, targetH / 2, targetH * 0.25, targetW / 2, targetH / 2, targetW * 0.7);
            vignette.addColorStopRGBA(0, 0, 0, 0, 0.2);
            vignette.addColorStopRGBA(1, 0.04, 0.04, 0.05, 0.88);
            cr.setSource(vignette);
            cr.paint();

            // 3. Foreground sharp artist photo
            // Fit cleanly into screen height (100% visible, no cut-off heads)
            const fitScale = targetH / sh;
            const fgW = Math.round(sw * fitScale);
            const fgH = targetH;
            // Shift right to give comfortable space for vinyl record on top-left
            const fgX = Math.round((targetW - fgW) / 2 + (targetW * 0.08));
            const fgY = 0;

            const fgPixbuf = srcPixbuf.scale_simple(fgW, fgH, GdkPixbuf.InterpType.HYPER);

            cr.save();
            cr.rectangle(fgX, fgY, fgW, fgH);
            cr.clip();

            Gdk.cairo_set_source_pixbuf(cr, fgPixbuf, fgX, fgY);
            cr.paint();

            // Soft left edge feathering
            const fadeWidth = 160;
            const leftFade = new Cairo.LinearGradient(fgX, 0, fgX + fadeWidth, 0);
            leftFade.addColorStopRGBA(0, 0.05, 0.05, 0.06, 1.0);
            leftFade.addColorStopRGBA(1, 0.05, 0.05, 0.06, 0.0);
            cr.rectangle(fgX, 0, fadeWidth, targetH);
            cr.setSource(leftFade);
            cr.fill();

            // Soft right edge feathering
            const rightFade = new Cairo.LinearGradient(fgX + fgW - fadeWidth, 0, fgX + fgW, 0);
            rightFade.addColorStopRGBA(0, 0.05, 0.05, 0.06, 0.0);
            rightFade.addColorStopRGBA(1, 0.05, 0.05, 0.06, 1.0);
            cr.rectangle(fgX + fgW - fadeWidth, 0, fadeWidth, targetH);
            cr.setSource(rightFade);
            cr.fill();

            cr.restore();

            surface.writeToPNG(outputPath);
            cr.$dispose();
            return outputPath;
        } catch (e) {
            console.error('[SpotifyVinyl] Error composing widescreen wallpaper:', e);
            return inputPath;
        }
    }

    async _updateAlbumArt(artUrl) {
        const vinylSize = this._extSettings.get_int('vinyl-size') || 200;
        const innerPercent = this._extSettings.get_int('inner-size') || 44;
        const innerRatio = Math.max(0.20, Math.min(0.75, innerPercent / 100));
        const coverPercent = this._extSettings.get_int('cover-scale') || 100;
        const coverScale = Math.max(0.05, Math.min(3.0, coverPercent / 100));

        if (!artUrl) {
            this._albumPixbuf = null;
            if (this._discArea) this._discArea.queue_repaint();
            return;
        }

        const localPath = await this._fetchAlbumArt(artUrl);
        if (localPath) {
            try {
                const labelDiameter = Math.max(10, Math.round(vinylSize * innerRatio * 2 * coverScale));
                this._albumPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                    localPath,
                    labelDiameter,
                    labelDiameter,
                    false
                );
            } catch (e) {
                console.warn('[SpotifyVinyl] Failed to load album pixbuf:', e.message);
                this._albumPixbuf = null;
            }
        } else {
            this._albumPixbuf = null;
        }

        if (this._discArea) this._discArea.queue_repaint();
    }

    async _fetchArtistVisuals(artist, trackId) {
        if (!artist || artist === 'Unknown') return null;

        const primaryArtist = artist.split(/[,&/]/)[0].trim();
        const safeName = primaryArtist.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const storageDir = this._getStorageDir();

        const logoPath = GLib.build_filenamev([storageDir, `logo_${safeName}.png`]);
        const fanartPath = GLib.build_filenamev([storageDir, `fanart_${safeName}.jpg`]);
        const photoPath = GLib.build_filenamev([storageDir, `artist_${safeName}.jpg`]);

        const preferLogo = this._extSettings.get_boolean('prefer-logo');

        const hasLogo = GLib.file_test(logoPath, GLib.FileTest.EXISTS);
        const hasFanart = GLib.file_test(fanartPath, GLib.FileTest.EXISTS);
        const hasPhoto = GLib.file_test(photoPath, GLib.FileTest.EXISTS);

        if (preferLogo && hasLogo) {
            return { type: 'logo', logoPath, backdropPath: hasFanart ? fanartPath : (hasPhoto ? photoPath : null) };
        }
        if (!preferLogo && (hasFanart || hasPhoto)) {
            return { type: 'photo', imagePath: hasFanart ? fanartPath : photoPath };
        }

        // 1. TheAudioDB Free Music API (Logo + Fanart)
        try {
            const tadbUrl = `https://www.theaudiodb.com/api/v1/json/123/search.php?s=${encodeURIComponent(primaryArtist)}`;
            const msg = Soup.Message.new('GET', tadbUrl);
            msg.request_headers.append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64)');
            const bytes = await this._httpSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
            if (msg.status_code === 200) {
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const a = data?.artists?.[0];
                if (a) {
                    const logoUrl = a.strArtistLogo || a.strArtistClearart;
                    const fanartUrl = a.strArtistFanart || a.strArtistFanart2 || a.strArtistFanart3 || a.strArtistFanart4 || a.strArtistWideThumb || a.strArtistThumb;

                    let downloadedLogo = hasLogo;
                    let downloadedFanart = hasFanart;

                    if (logoUrl && !hasLogo) {
                        downloadedLogo = await this._download(logoUrl, logoPath);
                    }
                    if (fanartUrl && !hasFanart) {
                        downloadedFanart = await this._download(fanartUrl, fanartPath);
                    }

                    if (preferLogo && downloadedLogo) {
                        return { type: 'logo', logoPath, backdropPath: downloadedFanart ? fanartPath : null };
                    }
                    if (downloadedFanart) {
                        return { type: 'photo', imagePath: fanartPath };
                    }
                    if (downloadedLogo) {
                        return { type: 'logo', logoPath, backdropPath: null };
                    }
                }
            }
        } catch (e) {
            console.warn('[SpotifyVinyl] TheAudioDB request failed:', e.message);
        }

        // 2. Deezer API: 1000x1000px artist photo
        try {
            const deezerUrl = `https://api.deezer.com/search/artist?q=${encodeURIComponent(primaryArtist)}`;
            const msg = Soup.Message.new('GET', deezerUrl);
            const bytes = await this._httpSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
            if (msg.status_code === 200) {
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const picUrl = data?.data?.[0]?.picture_xl || data?.data?.[0]?.picture_big;
                if (picUrl) {
                    const ok = await this._download(picUrl, photoPath);
                    if (ok) return { type: 'photo', imagePath: photoPath };
                }
            }
        } catch (_) {}

        // 3. Fallback: Spotify Web track & artist page lookup
        if (trackId) {
            try {
                const cleanId = trackId.split(':').pop().split('/').pop();
                if (cleanId) {
                    const trackUrl = `https://open.spotify.com/track/${cleanId}`;
                    const msg = Soup.Message.new('GET', trackUrl);
                    const bytes = await this._httpSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
                    if (msg.status_code === 200) {
                        const html = new TextDecoder().decode(bytes.get_data());
                        const match = html.match(/open\.spotify\.com\/artist\/([a-zA-Z0-9]+)/);
                        if (match && match[1]) {
                            const artistUrl = `https://open.spotify.com/artist/${match[1]}`;
                            const aMsg = Soup.Message.new('GET', artistUrl);
                            const aBytes = await this._httpSession.send_and_read_async(aMsg, GLib.PRIORITY_DEFAULT, null);
                            if (aMsg.status_code === 200) {
                                const aHtml = new TextDecoder().decode(aBytes.get_data());
                                const ogMatch = aHtml.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
                                if (ogMatch && ogMatch[1]) {
                                    const ok = await this._download(ogMatch[1], photoPath);
                                    if (ok) return { type: 'photo', imagePath: photoPath };
                                }
                            }
                        }
                    }
                }
            } catch (_) {}
        }

        if (hasLogo) return { type: 'logo', logoPath, backdropPath: null };
        if (hasPhoto) return { type: 'photo', imagePath: photoPath };
        if (hasFanart) return { type: 'photo', imagePath: fanartPath };

        return null;
    }

    async _fetchAlbumArt(artUrl) {
        if (!artUrl) return null;
        if (artUrl.startsWith('file://')) {
            return artUrl.replace('file://', '');
        }

        const safeId = artUrl.split('/').pop().split('?')[0].replace(/[^a-z0-9]/gi, '_');
        const cachedPath = GLib.build_filenamev([this._getStorageDir(), `album_${safeId}.jpg`]);

        if (GLib.file_test(cachedPath, GLib.FileTest.EXISTS)) {
            return cachedPath;
        }

        const ok = await this._download(artUrl, cachedPath);
        return ok ? cachedPath : null;
    }

    async _download(url, destPath) {
        try {
            const msg = Soup.Message.new('GET', url);
            msg.request_headers.append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64)');
            const bytes = await this._httpSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
            if (msg.status_code === 200) {
                const file = Gio.File.new_for_path(destPath);
                const [success] = file.replace_contents(
                    bytes.get_data(),
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );
                return success;
            }
        } catch (e) {
            console.warn(`[SpotifyVinyl] Download failed (${url}):`, e.message);
        }
        return false;
    }

    // Layer 1: Disc (body, grooves, album cover, spindle hole) - ROTATES
    _drawDisc(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        if (w <= 0 || h <= 0) {
            cr.$dispose();
            return;
        }

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(cx, cy) - 6;

        // 1. Soft Drop Shadow
        const shadow = new Cairo.RadialGradient(cx, cy + 3, radius - 2, cx, cy + 3, radius + 6);
        shadow.addColorStopRGBA(0, 0, 0, 0, 0.45);
        shadow.addColorStopRGBA(1, 0, 0, 0, 0.0);
        cr.arc(cx, cy + 3, radius + 6, 0, 2 * Math.PI);
        cr.setSource(shadow);
        cr.fill();

        // 2. Vinyl Disc Body
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        const discGradient = new Cairo.RadialGradient(cx - 20, cy - 20, 10, cx, cy, radius);
        discGradient.addColorStopRGBA(0, 0.12, 0.12, 0.14, 1.0);
        discGradient.addColorStopRGBA(0.7, 0.07, 0.07, 0.08, 1.0);
        discGradient.addColorStopRGBA(1, 0.04, 0.04, 0.05, 1.0);
        cr.setSource(discGradient);
        cr.fill();

        // Outer rim
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.setSourceRGBA(0.3, 0.3, 0.33, 0.85);
        cr.setLineWidth(1.5);
        cr.stroke();

        // 3. Realistic Vinyl Grooves
        const innerPercent = this._extSettings.get_int('inner-size') || 44;
        const innerRatio = Math.max(0.20, Math.min(0.75, innerPercent / 100));
        const labelRadius = radius * innerRatio;

        cr.setLineWidth(0.6);
        for (let r = labelRadius + 4; r < radius - 3; r += 2.2) {
            cr.arc(cx, cy, r, 0, 2 * Math.PI);
            const alpha = (Math.sin(r * 2.3) > 0) ? 0.07 : 0.03;
            cr.setSourceRGBA(1, 1, 1, alpha);
            cr.stroke();
        }

        // Sound track breaks
        for (const r of [labelRadius + 8, radius - 8, (labelRadius + radius) / 2]) {
            if (r > labelRadius + 3 && r < radius - 3) {
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                cr.setSourceRGBA(0, 0, 0, 0.5);
                cr.setLineWidth(1.2);
                cr.stroke();
            }
        }

        // 4. Center Album Art Label (rotates with disc!)
        cr.save();
        cr.arc(cx, cy, labelRadius, 0, 2 * Math.PI);
        cr.clip();

        // Label background (fills behind cover if zoomed out)
        cr.arc(cx, cy, labelRadius, 0, 2 * Math.PI);
        cr.setSourceRGB(0.12, 0.12, 0.14);
        cr.fill();

        if (this._albumPixbuf) {
            const pbW = this._albumPixbuf.get_width();
            const pbH = this._albumPixbuf.get_height();
            Gdk.cairo_set_source_pixbuf(cr, this._albumPixbuf, cx - pbW / 2, cy - pbH / 2);
            cr.paint();
        } else {
            // Default stylized center label
            cr.arc(cx, cy, labelRadius, 0, 2 * Math.PI);
            cr.setSourceRGBA(0.85, 0.2, 0.2, 1.0);
            cr.fill();
        }
        cr.restore();

        // Label ring border
        cr.arc(cx, cy, labelRadius, 0, 2 * Math.PI);
        cr.setSourceRGBA(0.85, 0.85, 0.9, 0.4);
        cr.setLineWidth(1.5);
        cr.stroke();

        // 5. Spindle Hole & Metallic Washer Ring
        cr.arc(cx, cy, 10, 0, 2 * Math.PI);
        cr.setSourceRGBA(0.75, 0.75, 0.78, 0.85);
        cr.setLineWidth(1.6);
        cr.stroke();

        cr.arc(cx, cy, 6, 0, 2 * Math.PI);
        cr.setSourceRGBA(0.02, 0.02, 0.03, 1.0);
        cr.fill();

        cr.$dispose();
    }

    // Layer 2: Stationary Specular Reflections & Highlights (STAYS STILL while disc rotates)
    _drawSheen(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        if (w <= 0 || h <= 0) {
            cr.$dispose();
            return;
        }

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(cx, cy) - 6;
        const labelRadius = radius * 0.44;

        // Two opposing specular reflection wedges across the grooves (at 45° and 225°)
        for (const angle of [Math.PI / 4, 5 * Math.PI / 4]) {
            cr.save();
            cr.arc(cx, cy, radius - 2, angle - 0.28, angle + 0.28);
            cr.arcNegative(cx, cy, labelRadius + 2, angle + 0.28, angle - 0.28);
            cr.closePath();
            const sheen = new Cairo.RadialGradient(cx, cy, labelRadius, cx, cy, radius);
            sheen.addColorStopRGBA(0, 1, 1, 1, 0.02);
            sheen.addColorStopRGBA(0.5, 1, 1, 1, 0.18);
            sheen.addColorStopRGBA(1, 1, 1, 1, 0.02);
            cr.setSource(sheen);
            cr.fill();
            cr.restore();
        }

        // Top specular arc highlight
        cr.save();
        cr.arc(cx, cy, radius - 2, -Math.PI * 0.7, -Math.PI * 0.3);
        cr.setSourceRGBA(1, 1, 1, 0.12);
        cr.setLineWidth(2.0);
        cr.stroke();
        cr.restore();

        cr.$dispose();
    }

    _onVisibilityChanged() {
        if (!this._isSpotifyActive || this._lastStatus !== 'Playing') return;

        const isLocked = Main.screenShield ? Main.screenShield.active : false;
        const isOverview = Main.overview ? Main.overview.visible : false;
        const shouldPause = isLocked || isOverview;

        if (shouldPause) {
            this._pauseVinylSpin();
        } else {
            const showAllowed = this._extSettings.get_boolean('show-vinyl');
            if (showAllowed) {
                this._startVinylSpin();
            }
        }
    }

    _showVinyl() {
        if (!this._container) return;
        this._updateVinylPosition();
        this._container.visible = true;
        this._container.ease({
            opacity: 255,
            duration: 350,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hideVinyl() {
        if (!this._container) return;
        this._pauseVinylSpin();
        this._container.ease({
            opacity: 0,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._container) this._container.visible = false;
            },
        });
    }

    _startVinylSpin() {
        if (!this._discArea) return;
        this._discArea.remove_transition('spin');

        const currentAngle = this._discArea.rotation_angle_z % 360;
        this._discArea.rotation_angle_z = currentAngle;

        const speed = this._extSettings.get_int('vinyl-speed') || 2400;

        const transition = new Clutter.PropertyTransition({
            property_name: 'rotation-angle-z',
            interval: new Clutter.Interval({
                value_type: GObject.TYPE_DOUBLE,
                initial: currentAngle,
                final: currentAngle + 360,
            }),
            duration: speed,
            progress_mode: Clutter.AnimationMode.LINEAR,
            repeat_count: -1,
        });

        this._discArea.add_transition('spin', transition);
    }

    _pauseVinylSpin() {
        if (!this._discArea) return;
        const currentAngle = this._discArea.rotation_angle_z;
        this._discArea.remove_transition('spin');
        this._discArea.rotation_angle_z = currentAngle;
    }

    _restoreWallpaper() {
        if (GLib.file_test(RESTORE_SCRIPT, GLib.FileTest.IS_EXECUTABLE)) {
            try {
                const proc = Gio.Subprocess.new(['/bin/bash', RESTORE_SCRIPT], Gio.SubprocessFlags.NONE);
                proc.wait_async(null, null);
            } catch (e) {
                console.error('[SpotifyVinyl] Error running wallpaper script:', e);
            }
        }
    }

    disable() {
        if (this._stopTimerId) {
            GLib.source_remove(this._stopTimerId);
            this._stopTimerId = null;
        }

        if (this._busWatchId) {
            Gio.bus_unwatch_name(this._busWatchId);
            this._busWatchId = null;
        }

        if (this._proxyPropId && this._proxy) {
            this._proxy.disconnect(this._proxyPropId);
            this._proxyPropId = null;
        }
        this._proxy = null;

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }
        if (this._overviewHidingId) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = null;
        }
        if (this._screenShieldId && Main.screenShield) {
            Main.screenShield.disconnect(this._screenShieldId);
            this._screenShieldId = null;
        }

        if (this._settingsSignals && this._extSettings) {
            for (const sig of this._settingsSignals) {
                this._extSettings.disconnect(sig);
            }
            this._settingsSignals = [];
        }

        if (this._bgChangedId) {
            this._bgSettings.disconnect(this._bgChangedId);
            this._bgChangedId = null;
        }

        if (this._bgChildAddedId) {
            const bgGroup = Main.layoutManager._backgroundGroup;
            if (bgGroup) {
                bgGroup.disconnect(this._bgChildAddedId);
            }
            this._bgChildAddedId = null;
        }

        if (this._discArea) {
            this._discArea.remove_transition('spin');
        }

        if (this._container) {
            const parent = this._container.get_parent();
            if (parent) {
                parent.remove_child(this._container);
            }
            this._container.destroy();
            this._container = null;
            this._discArea = null;
            this._sheenArea = null;
        }

        if (this._httpSession) {
            this._httpSession.abort();
            this._httpSession = null;
        }

        // Restore dynamic wallpaper on disable
        this._restoreWallpaper();

        this._albumPixbuf = null;
        this._bgSettings = null;
        this._extSettings = null;
    }
}
