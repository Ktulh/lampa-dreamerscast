(function () {
    'use strict';

    if (window.plugin_dreamerscast_ready) return;
    window.plugin_dreamerscast_ready = true;

    var BASE = 'https://dreamerscast.com';

    Lampa.Manifest.plugins = {
        type: 'video',
        version: '1.1.0',
        name: 'Dreamerscast',
        description: 'Онлайн просмотр релизов команды Dream Cast',
        component: 'dreamerscast'
    };

    function norm(s) {
        return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
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

    function Component(object) {
        var network = new Lampa.Reguest();
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var html = $('<div class="dreamerscast"></div>');
        var items = [];
        var last;
        var movie = object.movie || {};
        var self = this;

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
                    list.sort(function (a, b) { return score(b, self.names) - score(a, self.names); });
                    self.showReleases(list);
                } else self.search(queries);
            }, function () {
                self.search(queries);
            }, 'search=' + encodeURIComponent(q) + '&status=&pageSize=16&pageNumber=1', {
                dataType: 'json',
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
        };

        // ---------- выбор релиза (сезона) ----------
        this.showReleases = function (list) {
            if (list.length === 1) return this.loadRelease(list[0]);

            this.reset();
            this.activity.loader(false);

            list.forEach(function (rel) {
                var info = [rel.dateissue, rel.season, rel.series + ' из ' + rel.currentSeries + ' эп.'].filter(Boolean).join(' • ');
                self.addItem(rel.russian + (rel.original ? ' / ' + rel.original : ''), info, function () {
                    self.loadRelease(rel);
                });
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
                self.parseRelease(String(str));
            }, function () {
                self.empty();
            }, false, { dataType: 'text' });
        };

        this.parseRelease = function (str) {
            var playlist = [];
            var m = str.match(/atob\(\s*["']([^"']+)["']\s*\)\s*\.split\(\s*["']\|\|\|\|["']\s*\)/);

            if (m) {
                try {
                    atob(m[1]).split('||||').forEach(function (u) {
                        u = u.trim();
                        if (u) playlist.push(u);
                    });
                } catch (e) {
                    console.log('Dreamerscast', e);
                }
            }

            if (!playlist.length) return this.empty();

            this.activity.loader(false);
            var rel = this.release;

            var episodes = playlist.map(function (u, i) {
                return { title: 'Серия ' + (i + 1), url: u };
            });

            this.reset();
            episodes.forEach(function (ep, i) {
                self.addItem(ep.title, rel.russian, function () {
                    var queue = episodes.map(function (e) {
                        return { title: e.title, url: e.url };
                    });
                    var cur = { title: queue[i].title, url: queue[i].url, playlist: queue };
                    Lampa.Player.play(cur);
                    Lampa.Player.playlist(queue);
                });
            });
            this.finish();
        };

        // ---------- UI ----------
        this.reset = function () {
            items = [];
            html.empty();
        };

        this.addItem = function (title, subtitle, onEnter) {
            var el = $('<div class="selector dreamerscast__item" style="margin:.5em 1.5em;padding:1em 1.2em;background:rgba(255,255,255,.08);border-radius:.5em">' +
                '<div style="font-size:1.3em"></div><div style="opacity:.6;margin-top:.3em"></div></div>');
            el.children().eq(0).text(title);
            el.children().eq(1).text(subtitle || '');
            el.on('hover:enter', onEnter);
            el.on('hover:focus', function () {
                last = el[0];
                scroll.update(el, true);
            });
            html.append(el);
            items.push(el);
        };

        this.finish = function () {
            scroll.append(html);
            this.start();
        };

        this.empty = function () {
            this.activity.loader(false);
            this.reset();
            html.append('<div class="empty" style="padding:2em;text-align:center">Не удалось найти «' +
                $('<i>').text(movie.title || movie.name || '').html() + '» на Dreamerscast</div>');
            scroll.append(html);
            this.start();
        };

        // ---------- жизненный цикл компонента ----------
        this.start = function () {
            if (Lampa.Activity.active().activity !== this.activity) return;

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
                back: function () { Lampa.Activity.backward(); }
            });
            Lampa.Controller.toggle('content');
        };

        this.render = function () { return scroll.render(); };
        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            network.clear();
            scroll.destroy();
            html.remove();
            items = [];
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

    // Подсветка выбранной серии
    $('<style>.dreamerscast__item.focus{background:#fff!important;color:#000}' +
        '.dreamerscast__item.focus div{opacity:1!important}</style>').appendTo('head');

    Lampa.Listener.follow('full', function (e) {
        if (e.type == 'complite') addButton(e);
    });
})();
