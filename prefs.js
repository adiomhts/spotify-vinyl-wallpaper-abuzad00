import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SpotifyVinylWallpaperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.spotify-vinyl-wallpaper');

        const page = new Adw.PreferencesPage({
            title: 'Виниловая пластинка',
            icon_name: 'media-optical-audio-symbolic',
        });
        window.add(page);

        const groupDisplay = new Adw.PreferencesGroup({
            title: 'Внешний вид',
            description: 'Настройки отображения и поведения виниловой пластинки',
        });
        page.add(groupDisplay);

        // 1. Show vinyl switch
        const showVinylRow = new Adw.SwitchRow({
            title: 'Отображать пластинку',
            subtitle: 'Показывать вращающийся винил при воспроизведении музыки',
        });
        groupDisplay.add(showVinylRow);
        settings.bind('show-vinyl', showVinylRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // 2. Always on top
        const alwaysOnTopRow = new Adw.SwitchRow({
            title: 'Поверх всех окон',
            subtitle: 'Держать пластинку поверх окон (плавающий виджет) или на обоях рабочего стола',
        });
        groupDisplay.add(alwaysOnTopRow);
        settings.bind('always-on-top', alwaysOnTopRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // 3. Size spin row
        const sizeRow = new Adw.SpinRow({
            title: 'Размер пластинки (px)',
            subtitle: 'Диаметр диска в пикселях',
            adjustment: new Gtk.Adjustment({
                lower: 80,
                upper: 500,
                step_increment: 10,
                page_increment: 50,
                value: settings.get_int('vinyl-size'),
            }),
        });
        groupDisplay.add(sizeRow);
        settings.bind('vinyl-size', sizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // 4. Inner label size
        const innerSizeRow = new Adw.SpinRow({
            title: 'Размер обложки внутри (%)',
            subtitle: 'Процент радиуса пластинки, занимаемый центральной круглой обложкой',
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 75,
                step_increment: 2,
                page_increment: 10,
                value: settings.get_int('inner-size'),
            }),
        });
        groupDisplay.add(innerSizeRow);
        settings.bind('inner-size', innerSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // 5. Cover scale / zoom inside circle
        const coverScaleRow = new Adw.SpinRow({
            title: 'Масштаб обложки внутри кружка (%)',
            subtitle: 'Степень обрезки краев обложки (71% = видно всю обложку без обрезки углов)',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 300,
                step_increment: 2,
                page_increment: 10,
                value: settings.get_int('cover-scale'),
            }),
        });
        groupDisplay.add(coverScaleRow);
        settings.bind('cover-scale', coverScaleRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // 6. Rotation duration
        const speedRow = new Adw.SpinRow({
            title: 'Длительность оборота (мс)',
            subtitle: 'Время полного оборота на 360° (меньше значение = быстрее крутится)',
            adjustment: new Gtk.Adjustment({
                lower: 800,
                upper: 6000,
                step_increment: 100,
                page_increment: 500,
                value: settings.get_int('vinyl-speed'),
            }),
        });
        groupDisplay.add(speedRow);
        settings.bind('vinyl-speed', speedRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const groupPosition = new Adw.PreferencesGroup({
            title: 'Позиция на экране',
            description: 'Смещение пластинки относительно левого верхнего угла',
        });
        page.add(groupPosition);

        // 6. Margin X
        const marginXRow = new Adw.SpinRow({
            title: 'Отступ слева (px)',
            subtitle: 'Расстояние от левого края монитора',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 1000,
                step_increment: 5,
                page_increment: 20,
                value: settings.get_int('margin-x'),
            }),
        });
        groupPosition.add(marginXRow);
        settings.bind('margin-x', marginXRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // 7. Margin Y
        const marginYRow = new Adw.SpinRow({
            title: 'Отступ сверху (px)',
            subtitle: 'Расстояние от панели задач / верхнего края монитора',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 1000,
                step_increment: 5,
                page_increment: 20,
                value: settings.get_int('margin-y'),
            }),
        });
        groupPosition.add(marginYRow);
        settings.bind('margin-y', marginYRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Wallpaper Style Group
        const groupWallpaper = new Adw.PreferencesGroup({
            title: 'Обои рабочего стола',
            description: 'Оформление фонового изображения артиста',
        });
        page.add(groupWallpaper);

        const preferLogoRow = new Adw.SwitchRow({
            title: 'Предпочитать логотип артиста',
            subtitle: 'Отображать официальный логотип группы на темном фоне вместо фотографии (если доступен)',
        });
        groupWallpaper.add(preferLogoRow);
        settings.bind('prefer-logo', preferLogoRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Database & Cache Group
        const groupCache = new Adw.PreferencesGroup({
            title: 'База данных и кэш исполнителей',
            description: 'Локальное сохранение обоев частых артистов (TheAudioDB API)',
        });
        page.add(groupCache);

        const maxArtistsRow = new Adw.SpinRow({
            title: 'Максимум исполнителей в базе',
            subtitle: 'Количество самых часто прослушиваемых артистов, сохраняемых на диске',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 500,
                step_increment: 5,
                page_increment: 25,
                value: settings.get_int('cache-max-artists'),
            }),
        });
        groupCache.add(maxArtistsRow);
        settings.bind('cache-max-artists', maxArtistsRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const maxMbRow = new Adw.SpinRow({
            title: 'Максимальный объем кэша (МБ)',
            subtitle: 'Лимит дискового пространства под обои исполнителей',
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 2000,
                step_increment: 20,
                page_increment: 100,
                value: settings.get_int('cache-max-size-mb'),
            }),
        });
        groupCache.add(maxMbRow);
        settings.bind('cache-max-size-mb', maxMbRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const clearRow = new Adw.ActionRow({
            title: 'Очистить кэш обоев',
            subtitle: 'Удалить сохраненные файлы обоев и историю частоты артистов',
        });
        const clearBtn = new Gtk.Button({
            label: 'Очистить',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        clearBtn.connect('clicked', () => {
            const cacheDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'spotify-vinyl-wallpaper']);
            try {
                const dir = Gio.File.new_for_path(cacheDir);
                if (dir.query_exists(null)) {
                    const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                    let info;
                    while ((info = enumerator.next_file(null)) !== null) {
                        const child = dir.get_child(info.get_name());
                        child.delete(null);
                    }
                }
                clearBtn.set_label('Очищено!');
                clearBtn.set_sensitive(false);
            } catch (e) {
                console.warn('Failed to clear cache:', e.message);
            }
        });
        clearRow.add_suffix(clearBtn);
        groupCache.add(clearRow);
    }
}
