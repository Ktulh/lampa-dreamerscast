(function () {
    'use strict';

    if (window.plugin_dreamerscast_ready) return;
    window.plugin_dreamerscast_ready = true;

    var BASE = 'https://dreamerscast.com';
    var VIEW_KEY = 'dreamerscast_view';     // массив хэшей просмотренных серий
    var CHOICE_KEY = 'dreamerscast_choice'; // последняя открытая серия по каждой карточке

    Lampa.Manifest.plugins = {
        type: 'video',
        version: '1.3.0',
        name: 'Dreamerscast',
        description: 'Онлайн просмотр релизов команды Dream Cast',
        component: 'dreamerscast'
    };

    function norm(s) {
        return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
    }

    function esc(s) {
        return $('<i>').text(s == null ? '' : String(s)).html();
    }

    function pad(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function absUrl(u) {
        return u && u.indexOf('//') === 0 ? 'https:' + u : u;
    }

    // Чем больше число, тем лучше релиз подходит под карточку Lampa
    function score(rel, names) {
        var best = 0;
        var r = [norm(rel.russian), norm(rel.original)];
        names.forEach(function (n) {
            if (!n) return;
            r.forEach(function (x) {
                if (!x) return;
                if (x === n) best = Math.max(best, 3);
                else if (x.indexOf(n) === 0 || n.indexOf(x) === 0) best = Math.max(best, 2);
                else if (x.indexOf(n) >= 0 || n.indexOf(x) >= 0) best = Math.max(best, 1);
            });
        });
        return best;
    }

    // Мастер-плейлист содержит и аудио-дорожку без видео, и адаптивное переключение:
    // плееры (VLC/ExoPlayer) стартуют с самого слабого варианта или застревают на кадре.
    // Поэтому отдаём плееру прямые ссылки на варианты 1080/720/480 (видео+звук).
    function qualities(master) {
        var m = master.match(/^(.*)_,([^/]+),\.mp4\.urlset\/master\.m3u8$/);
        if (!m) return null;

        var tokens = m[2].split(',');
        var videos = tokens.slice(0, -1); // последний токен — аудиокодек
        var map = {};

        videos.forEach(function (t, i) {
            var label = /^\d+$/.test(t) ? t + 'p' : (i === videos.length - 1 ? '480p' : t);
            map[label] = m[1] + '_,' + m[2] + ',.mp4.urlset/index-f' + (i + 1) + '-v1-f' + (videos.length + 1) + '-a1.m3u8';
        });
        return map;
    }

    // Качество по умолчанию берём из настроек плеера Lampa, иначе максимальное
    function defaultUrl(map) {
        var want = parseInt(Lampa.Storage.field('video_quality_default'));
        var keys = Object.keys(map);
        for (var i = 0; i < keys.length; i++) {
            if (parseInt(keys[i]) === want) return map[keys[i]];
        }
        return map[keys[0]];
    }

    // Превью серии: спрайт Dreamerscast — сетка 5x5 кадров 160x90, кадр каждые 10 секунд.
    // Берём кадр на ~3-й минуте, чтобы не попасть на чёрный экран или опенинг.
    var THUMB_TILE = 18;

    function thumbStyle(vtt) {
        if (!vtt) return '';
        var col = THUMB_TILE % 5, row = Math.floor(THUMB_TILE / 5);
        var img = vtt.replace(/thumbnails\.vtt(\?.*)?$/, 'img1.webp');
        return 'background-image:url(' + img + ');background-size:500% 500%;background-position:' + (col * 25) + '% ' + (row * 25) + '%';
    }

    // Конфиг Playerjs на странице релиза: base64 со вставками мусора «//» + 88 символов base64.
    // Вставки бывают вложены одна в другую, поэтому вырезаем их, пока что-то находится.
    function decodePlayerConfig(str) {
        var m = str.match(/new Playerjs\(\s*["']#2([^"']+)["']/);
        if (!m) return null;
        try {
            var clean = m[1], prev;
            do {
                prev = clean;
                clean = clean.replace(/\/\/[A-Za-z0-9+\/]{86}==/g, '');
            } while (clean !== prev);
            while (clean.length % 4) clean += '=';
            return JSON.parse(decodeURIComponent(escape(atob(clean))));
        } catch (e) {
            console.log('Dreamerscast', 'player config', e);
            return null;
        }
    }

    function hlsFrom(file) {
        var parts = String(file || '').split(' or ');
        for (var i = 0; i < parts.length; i++) {
            if (parts[i].indexOf('/hls/') >= 0) return parts[i].trim();
        }
        return '';
    }

    // Список серий: сначала из конфига плеера (названия + превью), иначе из ссылки для VLC
    function parseEpisodes(str) {
        var list = [];
        var cfg = decodePlayerConfig(str);

        if (cfg && cfg.file) {
            var files = typeof cfg.file === 'string' ? [cfg] : cfg.file;
            files.forEach(function (f, i) {
                var url = hlsFrom(f.file);
                if (url) list.push({ title: f.title || 'Серия ' + (i + 1), url: url, thumbnails: f.thumbnails || '' });
            });
        }

        if (!list.length) {
            var m = str.match(/atob\(\s*["']([^"']+)["']\s*\)\s*\.split\(\s*["']\|\|\|\|["']\s*\)/);
            if (m) {
                try {
                    atob(m[1]).split('||||').forEach(function (u, i) {
                        u = u.trim();
                        if (u) list.push({ title: 'Серия ' + (i + 1), url: u, thumbnails: '' });
                    });
                } catch (e) {
                    console.log('Dreamerscast', e);
                }
            }
        }

        list.forEach(function (ep, i) {
            ep.number = i + 1;
            if (!/\d/.test(ep.title)) ep.title = 'Серия ' + ep.number;
        });
        return list;
    }

    function Component(object) {
        var network = new Lampa.Reguest();
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var html = $('<div class="dcast"></div>');
        var last;
        var movie = object.movie || {};
        var movie_key = movie.original_title || movie.original_name || movie.title || movie.name || '';
        var self = this;

        this.releases = [];
        this.view = 'search';

        // ---------- хранилище ----------
        function viewed() {
            return Lampa.Storage.cache(VIEW_KEY, 5000, []);
        }

        function getChoice() {
            var all = Lampa.Storage.cache(CHOICE_KEY, 3000, {});
            return all[Lampa.Utils.hash(movie_key)] || null;
        }

        function saveChoice(rel, ep) {
            var all = Lampa.Storage.cache(CHOICE_KEY, 3000, {});
            all[Lampa.Utils.hash(movie_key)] = {
                release_id: rel.id,
                release_name: rel.russian,
                episode: ep.number,
                title: ep.title
            };
            Lampa.Storage.set(CHOICE_KEY, all);
        }

        // Хэш серии: свой (по id релиза), чтобы второй сезон не пересекался с первым.
        // Позже, при сопоставлении с TMDB, можно будет перейти на хэш Lampa.
        function episodeHash(rel, ep) {
            return Lampa.Utils.hash(['dreamerscast', rel.id, ep.number, movie_key].join(':'));
        }

        // ---------- поиск ----------
        this.create = function () {
            this.activity.loader(true);

            var queries = [];
            [movie.title, movie.name, movie.original_title, movie.original_name].forEach(function (q) {
                if (q && queries.indexOf(q) < 0) queries.push(q);
            });

            // Название в Lampa часто английское, а на Dreamerscast — ромадзи/русское,
            // поэтому добавляем альтернативные названия из TMDB
            var alt = movie.alternative_titles || {};
            (alt.results || alt.titles || []).forEach(function (t) {
                var n = t && t.title;
                if (n && /[a-zа-яё]/i.test(n) && queries.indexOf(n) < 0) queries.push(n);
            });
            queries = queries.slice(0, 8);

            this.names = queries.map(norm);

            this.search(queries.slice());
            return this.render();
        };

        this.search = function (queries) {
            var q = queries.shift();
            if (!q) return this.empty();

            network.clear();
            network.silent(BASE + '/', function (data) {
                if (typeof data === 'string') {
                    try { data = JSON.parse(data); } catch (e) { data = {}; }
                }
                var list = (data && data.releases) || [];
                list = list.filter(function (r) { return score(r, self.names) > 0; });

                if (list.length) {
                    list.sort(function (a, b) {
                        return score(b, self.names) - score(a, self.names) || (a.dateissue || 0) - (b.dateissue || 0);
                    });
                    self.releases = list;
                    self.showReleases();
                } else self.search(queries);
            }, function () {
                self.search(queries);
            }, 'search=' + encodeURIComponent(q) + '&status=&pageSize=16&pageNumber=1', {
                dataType: 'json',
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
        };

        // ---------- выбор релиза (сезона) ----------
        this.showReleases = function () {
            var list = this.releases;
            if (list.length === 1) return this.loadRelease(list[0]);

            this.view = 'releases';
            this.reset();
            this.activity.loader(false);

            var choice = getChoice();
            this.addWatched(choice, function () {
                var rel = list.filter(function (r) { return r.id === choice.release_id; })[0];
                if (rel) self.loadRelease(rel);
            });

            list.forEach(function (rel) {
                var info = [rel.dateissue, rel.season, rel.type, rel.series + ' из ' + rel.currentSeries + ' эп.'];
                var card = self.addCard({
                    title: rel.russian || rel.original,
                    time: rel.original && rel.russian ? rel.original : '',
                    info: info.filter(Boolean).map(esc),
                    poster: absUrl(rel.image),
                    onEnter: function () { self.loadRelease(rel); }
                });
                if (choice && choice.release_id === rel.id) last = card[0];
            });
            this.finish();
        };

        // ---------- страница релиза ----------
        this.loadRelease = function (rel) {
            this.reset();
            this.activity.loader(true);
            this.release = rel;

            network.clear();
            network.silent(BASE + rel.url, function (str) {
                self.showEpisodes(rel, parseEpisodes(String(str)));
            }, function () {
                self.empty();
            }, false, { dataType: 'text' });
        };

        this.showEpisodes = function (rel, episodes) {
            if (!episodes.length) return this.empty();

            this.view = 'episodes';
            this.activity.loader(false);
            this.reset();
            last = null;

            var seen = viewed();
            var choice = getChoice();
            var cards = [];

            episodes.forEach(function (ep) {
                var map = qualities(ep.url);
                ep.quality = map;
                ep.play_url = map ? defaultUrl(map) : ep.url;
                ep.hash = episodeHash(rel, ep);
                ep.timeline = Lampa.Timeline.view(ep.hash);
            });

            this.addWatched(choice && choice.release_id === rel.id ? choice : null, function () {
                var ep = episodes[choice.episode - 1];
                if (ep) play(ep);
            });

            function markViewed(ep, card) {
                var list = viewed();
                if (list.indexOf(ep.hash) < 0) {
                    list.push(ep.hash);
                    Lampa.Storage.set(VIEW_KEY, list);
                }
                if (card && !card.find('.dcast__viewed').length) {
                    card.find('.dcast__img').append('<div class="dcast__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');
                }
                saveChoice(rel, ep);
                self.updateWatched(getChoice());
            }

            function play(ep) {
                var playlist = episodes.map(function (e, i) {
                    return {
                        title: e.title,
                        url: e.play_url,
                        quality: e.quality || undefined,
                        timeline: e.timeline,
                        callback: function () { markViewed(e, cards[i]); }
                    };
                });
                var first = $.extend({}, playlist[ep.number - 1]);
                first.playlist = playlist;

                if (movie.id) Lampa.Favorite.add('history', movie, 100);
                markViewed(ep, cards[ep.number - 1]);

                Lampa.Player.play(first);
                Lampa.Player.playlist(playlist);
            }

            episodes.forEach(function (ep) {
                var card = self.addCard({
                    title: ep.title,
                    info: [esc(rel.russian || rel.original)],
                    thumb: thumbStyle(absUrl(ep.thumbnails)),
                    number: ep.number,
                    timeline: ep.timeline,
                    viewed: seen.indexOf(ep.hash) >= 0,
                    onEnter: function () { play(ep); }
                });
                cards.push(card);
                if (choice && choice.release_id === rel.id && choice.episode === ep.number) last = card[0];
            });

            this.finish();
        };

        // ---------- UI ----------
        this.reset = function () {
            html.empty();
            scroll.reset();
        };

        // Плашка «последний просмотр»
        this.addWatched = function (choice, onEnter) {
            var el = $('<div class="dcast-watched selector">' +
                '<div class="dcast-watched__icon"><svg width="21" height="21" viewBox="0 0 21 21" fill="none">' +
                '<circle cx="10.5" cy="10.5" r="9" stroke="currentColor" stroke-width="3"/>' +
                '<path d="M14.8477 10.5628L8.20312 14.399L8.20313 6.72656L14.8477 10.5628Z" fill="currentColor"/></svg></div>' +
                '<div class="dcast-watched__body"></div></div>');

            el.on('hover:enter', function () {
                if (getChoice()) onEnter();
            });
            el.on('hover:focus', function () {
                last = el[0];
                scroll.update(el, true);
            });
            html.append(el);
            this.updateWatched(choice);
        };

        this.updateWatched = function (choice) {
            var body = html.find('.dcast-watched__body').empty();
            if (choice) {
                ['Dreamerscast', choice.release_name, choice.title].forEach(function (t) {
                    if (t) body.append('<span>' + esc(t) + '</span>');
                });
            } else body.append('<span>Нет истории просмотра</span>');
        };

        this.addCard = function (p) {
            var el = $('<div class="dcast__item selector">' +
                '<div class="dcast__img' + (p.poster ? ' dcast__img--poster' : '') + '"></div>' +
                '<div class="dcast__body">' +
                '<div class="dcast__head"><div class="dcast__title"></div><div class="dcast__time"></div></div>' +
                '<div class="dcast__timeline"></div>' +
                '<div class="dcast__info"></div>' +
                '</div></div>');

            var img = el.find('.dcast__img');
            el.find('.dcast__title').text(p.title);
            el.find('.dcast__time').text(p.time || '');
            el.find('.dcast__info').html((p.info || []).map(function (i) {
                return '<span>' + i + '</span>';
            }).join('<span class="dcast__split">●</span>'));

            if (p.poster) {
                img.append($('<img alt="">').attr('src', p.poster));
            } else if (p.thumb) {
                img.attr('style', p.thumb);
            }
            if (p.number) img.append('<div class="dcast__number">' + pad(p.number) + '</div>');
            if (p.viewed) img.append('<div class="dcast__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');
            if (p.timeline) el.find('.dcast__timeline').append(Lampa.Timeline.render(p.timeline));

            el.on('hover:enter', p.onEnter);
            el.on('hover:focus', function () {
                last = el[0];
                scroll.update(el, true);
            });
            html.append(el);
            return el;
        };

        this.finish = function () {
            scroll.append(html);
            if (last) scroll.update($(last), true);
            this.start();
        };

        this.empty = function () {
            this.activity.loader(false);
            this.reset();
            html.append('<div class="empty" style="padding:2em;text-align:center">Не удалось найти «' +
                esc(movie.title || movie.name || '') + '» на Dreamerscast</div>');
            scroll.append(html);
            this.start();
        };

        // ---------- жизненный цикл компонента ----------
        this.start = function () {
            if (Lampa.Activity.active().activity !== this.activity) return;

            Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(movie));

            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render());
                    Lampa.Controller.collectionFocus(last || false, scroll.render());
                },
                left: function () {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                right: function () { Navigator.move('right'); },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () {
                    if (Navigator.canmove('down')) Navigator.move('down');
                },
                back: function () { self.back(); }
            });
            Lampa.Controller.toggle('content');
        };

        // Из списка серий «назад» возвращает к выбору сезона, если их несколько
        this.back = function () {
            if (this.view === 'episodes' && this.releases.length > 1) {
                network.clear();
                last = null;
                this.showReleases();
            } else Lampa.Activity.backward();
        };

        this.render = function () { return scroll.render(); };
        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            network.clear();
            scroll.destroy();
            html.remove();
        };
    }

    Lampa.Component.add('dreamerscast', Component);

    // ---------- кнопка в карточке ----------
    // Кнопка кладётся в скрытый контейнер .buttons--container: Lampa сама собирает
    // из него меню кнопки «Смотреть» (рядом с трейлерами и другими плагинами).
    function addButton(e) {
        var root = e.object.activity.render();
        if (root.find('.view--dreamerscast').length) return;

        var btn = $('<div class="full-start__button selector view--dreamerscast">' +
            '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>' +
            '<span>Dreamerscast</span></div>');

        btn.on('hover:enter', function () {
            Lampa.Activity.push({
                url: '',
                title: 'Dreamerscast',
                component: 'dreamerscast',
                movie: e.data.movie,
                page: 1
            });
        });

        var box = root.find('.buttons--container').eq(0);
        if (box.length) box.prepend(btn);
        else root.find('.full-start-new__buttons, .full-start__buttons').eq(0).prepend(btn);
    }

    // Вёрстка списка — по мотивам online-prestige из Lampac
    $('<style>' +
        '.dcast{padding:0 1.5em 1.5em}' +
        '.dcast__item,.dcast-watched{position:relative;display:flex;border-radius:.3em;background-color:rgba(0,0,0,.3);margin-top:1.5em}' +
        '.dcast__item.focus::after,.dcast-watched.focus::after{content:"";position:absolute;top:-.6em;left:-.6em;right:-.6em;bottom:-.6em;border-radius:.7em;border:solid .3em #fff;pointer-events:none}' +
        '.dcast__img{position:relative;width:13em;min-height:8.2em;flex-shrink:0;border-radius:.3em;background-color:rgba(255,255,255,.05);background-repeat:no-repeat}' +
        '.dcast__img--poster{width:6em;min-height:9em}' +
        '.dcast__img>img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;border-radius:.3em}' +
        '.dcast__number{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:2em;text-shadow:0 0 .4em rgba(0,0,0,.9)}' +
        '.dcast__viewed{position:absolute;top:1em;left:1em;background:rgba(0,0,0,.45);border-radius:100%;padding:.25em;font-size:.76em;line-height:0}' +
        '.dcast__viewed>svg{width:1.5em!important;height:1.5em!important}' +
        '.dcast__body{padding:1.2em;line-height:1.3;flex-grow:1;min-width:0}' +
        '.dcast__head{display:flex;justify-content:space-between;align-items:center}' +
        '.dcast__title{font-size:1.7em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '.dcast__time{padding-left:2em;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.dcast__timeline{margin:.8em 0}' +
        '.dcast__timeline>.time-line{display:block!important}' +
        '.dcast__info{display:flex;align-items:center;flex-wrap:wrap;opacity:.8}' +
        '.dcast__split{font-size:.8em;margin:0 1em}' +
        '.dcast-watched{padding:1em;align-items:center}' +
        '.dcast-watched__icon>svg{width:1.5em;height:1.5em;display:block}' +
        '.dcast-watched__body{padding-left:1em;display:flex;flex-wrap:wrap}' +
        '.dcast-watched__body>span+span::before{content:" ● ";margin:0 .5em}' +
        '@media screen and (max-width:480px){.dcast__img{width:7em;min-height:6em}.dcast__img--poster{width:4.5em;min-height:6.5em}.dcast__title{font-size:1.4em}.dcast__body{padding:.8em 1.2em}}' +
        '</style>').appendTo('head');

    Lampa.Listener.follow('full', function (e) {
        if (e.type == 'complite') addButton(e);
    });
})();
