(function () {
    'use strict';

    if (window.plugin_hstream_ready) return;
    window.plugin_hstream_ready = true;

    var BASE = 'https://hstream.moe';

    Lampa.Manifest.plugins = {
        type: 'video',
        version: '1.0.0',
        name: 'HStream',
        description: 'Каталог hstream.moe отдельным разделом',
        component: 'hstream'
    };

    function abs(u) {
        if (!u) return '';
        if (u.indexOf('//') === 0) return 'https:' + u;
        if (u.charAt(0) === '/') return BASE + u;
        return u;
    }

    // ---------- сеть ----------
    // hstream.moe не отдаёт CORS, а адрес видео выдаёт только POST /player/api с CSRF-токеном,
    // привязанным к cookie сессии. Поэтому на Android ходим через нативный мост Lampa
    // (без CORS, с заголовками ответа) и сами храним cookie. В остальных средах — обычный XHR.
    var cookies = {};

    function cookieHeader() {
        return Object.keys(cookies).map(function (k) { return k + '=' + cookies[k]; }).join('; ');
    }

    function keepCookies(list) {
        (list || []).forEach(function (c) {
            var kv = String(c).split(';')[0];
            var i = kv.indexOf('=');
            if (i > 0) cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
        });
    }

    function hasNative() {
        try {
            return typeof AndroidJS !== 'undefined' && Lampa.Android && Lampa.Android.httpReq &&
                parseInt(String(AndroidJS.appVersion()).split('-').pop(), 10) >= 16;
        } catch (e) {
            return false;
        }
    }

    function request(url, opts, ok, fail) {
        opts = opts || {};
        var headers = $.extend({ 'Referer': BASE + '/' }, opts.headers || {});

        if (hasNative()) {
            if (Object.keys(cookies).length) headers.Cookie = cookieHeader();
            var data = { url: url, headers: headers, returnHeaders: true, timeout: 20000 };
            if (opts.post) data.post_data = opts.post;

            Lampa.Android.httpReq(data, {
                complite: function (resp) {
                    if (typeof resp === 'string') {
                        try { resp = JSON.parse(resp); } catch (e) { resp = { body: resp }; }
                    }
                    keepCookies(resp.headers && resp.headers['set-cookie']);
                    ok(resp.body || '');
                },
                error: function (e) { fail(e); }
            });
        } else {
            $.ajax({
                url: url,
                type: opts.post ? 'POST' : 'GET',
                data: opts.post || undefined,
                headers: opts.headers || {},
                contentType: opts.post ? 'application/json' : undefined,
                dataType: 'text',
                timeout: 20000,
                xhrFields: { withCredentials: true },
                success: function (s) { ok(s); },
                error: function (e) { fail(e); }
            });
        }
    }

    function parseHtml(str) {
        return new DOMParser().parseFromString(str, 'text/html');
    }

    // ---------- разбор страниц ----------
    function parseSearch(str) {
        var doc = parseHtml(str);
        var items = [];

        doc.querySelectorAll('[wire\\:key^="episode-"]').forEach(function (node) {
            var a = node.querySelector('a[href*="/hentai/"]');
            if (!a) return;
            var img = node.querySelector('img');
            var title = node.querySelector('h3');
            var badge = node.querySelector('.rounded-full');
            var href = a.getAttribute('href');
            items.push({
                url: abs(href),
                slug: href.split('/hentai/').pop(),
                title: (title ? title.textContent : (img && img.getAttribute('alt')) || '').trim(),
                image: abs(img && img.getAttribute('src')),
                badge: badge ? badge.textContent.trim() : ''
            });
        });

        var pages = 1;
        (str.match(/gotoPage\((\d+)\)/g) || []).forEach(function (m) {
            pages = Math.max(pages, parseInt(m.replace(/\D/g, ''), 10));
        });

        var tags = [];
        doc.querySelectorAll('input[name="tags[]"]').forEach(function (input) {
            var label = doc.querySelector('label[for="' + input.id + '"]');
            tags.push({ value: input.value, title: (label ? label.textContent : input.value).trim() });
        });

        return { items: items, pages: pages, tags: tags };
    }

    function parseEpisode(str, url) {
        var eid = str.match(/id="e_id"\s+type="hidden"\s+value="(\d+)"/);
        var csrf = str.match(/data-csrf="([^"]+)"/) || str.match(/name="csrf-token"\s+content="([^"]+)"/);
        var slug = url.split('/hentai/').pop();
        var series = slug.replace(/-\d+$/, '');

        // Остальные серии тайтла — из блока «More from …»
        var siblings = {};
        siblings[slug] = true;
        var re = new RegExp('href="https://hstream\\.moe/hentai/(' + series.replace(/[-]/g, '\\-') + '-\\d+)"', 'g');
        var m;
        while ((m = re.exec(str))) siblings[m[1]] = true;

        var episodes = Object.keys(siblings).map(function (s) {
            return { slug: s, url: BASE + '/hentai/' + s, number: parseInt(s.match(/-(\d+)$/)[1], 10) };
        }).sort(function (a, b) { return a.number - b.number; });

        return {
            id: eid && eid[1],
            csrf: csrf && csrf[1],
            uhd: /tags%5B0%5D=4k"/.test(str),
            title: (str.match(/"name":"([^"]+)"/) || [])[1] || '',
            episodes: episodes
        };
    }

    // Страница серии → /player/api → объект для плеера Lampa
    function resolveEpisode(url, ok, fail) {
        request(url, {}, function (str) {
            var ep = parseEpisode(str, url);
            if (!ep.id || !ep.csrf) return fail('no episode id');

            request(BASE + '/player/api', {
                post: JSON.stringify({ episode_id: ep.id }),
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': ep.csrf,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': url
                }
            }, function (body) {
                var d;
                try { d = typeof body === 'string' ? JSON.parse(body) : body; } catch (e) { return fail('bad api json'); }
                if (!d || !d.stream_url || !d.stream_domains || !d.stream_domains.length) return fail('no stream');

                var domain = d.stream_domains[Math.floor(Math.random() * d.stream_domains.length)];
                var base = domain + '/' + d.stream_url;

                // 720p H.264 — самый совместимый вариант, по умолчанию.
                // Остальное — AV1 DASH: картинка лучше, но не всякий ТВ его тянет.
                var quality = { '720p H.264': base + '/x264.720p.mp4', '1080p AV1': base + '/1080/manifest.mpd' };
                if (d.interpolated) quality['1080p 48fps AV1'] = base + '/1080i/manifest.mpd';
                if (ep.uhd) quality['2160p AV1'] = base + '/2160/manifest.mpd';

                ok({
                    title: d.title || ep.title,
                    url: quality['720p H.264'],
                    quality: quality,
                    subtitles: [{ label: 'English', url: base + '/eng.vtt' }],
                    poster: abs(d.poster)
                }, ep);
            }, fail);
        }, fail);
    }

    function timelineHash(slug) {
        return Lampa.Utils.hash('hstream:' + slug);
    }

    // ---------- каталог ----------
    function Component(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 300 });
        var html = $('<div class="hstream"></div>');
        var head = $('<div class="hstream__head"></div>');
        var grid = $('<div class="hstream__grid"></div>');
        var last;
        var loading = false;

        var state = {
            search: object.search || '',
            tags: object.tags || [],
            page: 0,
            pages: 1
        };
        var allTags = [];

        scroll.minus();
        html.append(head).append(grid);

        this.create = function () {
            this.activity.loader(true);
            scroll.append(html);
            this.drawHead();
            this.load(true);
            return this.render();
        };

        this.searchUrl = function (page) {
            var q = ['order=recently-uploaded'];
            if (state.search) q.push('search=' + encodeURIComponent(state.search));
            state.tags.forEach(function (t, i) { q.push('tags%5B' + i + '%5D=' + encodeURIComponent(t)); });
            if (page > 1) q.push('page=' + page);
            return BASE + '/search?' + q.join('&');
        };

        this.load = function (reset) {
            if (loading) return;
            if (reset) {
                state.page = 0;
                state.pages = 1;
                grid.empty();
                last = null;
            }
            if (state.page >= state.pages) return;

            loading = true;
            var page = state.page + 1;

            request(this.searchUrl(page), {}, function (str) {
                loading = false;
                self.activity.loader(false);

                var res = parseSearch(str);
                state.page = page;
                state.pages = res.pages;
                if (res.tags.length) allTags = res.tags;

                if (reset && !res.items.length) {
                    grid.append('<div class="hstream__empty">Ничего не найдено</div>');
                }
                res.items.forEach(function (item) { self.addCard(item); });

                if (reset) self.start();
                else if (Lampa.Controller.enabled().name === 'content') {
                    // Обновляем список навигации, сохраняя фокус на текущей карточке
                    Lampa.Controller.collectionSet(scroll.render());
                    Lampa.Controller.collectionFocus(last || false, scroll.render());
                }
            }, function () {
                loading = false;
                self.activity.loader(false);
                if (reset) {
                    grid.append('<div class="hstream__empty">Не удалось загрузить hstream.moe' +
                        (hasNative() ? '' : '<br><small>Сайт не отдаёт CORS: раздел работает в приложении Lampa для Android</small>') +
                        '</div>');
                    self.start();
                } else Lampa.Noty.show('HStream: не удалось загрузить следующую страницу');
            });
        };

        // ---------- шапка: поиск и теги ----------
        this.drawHead = function () {
            head.empty();

            var search = $('<div class="hstream__btn selector"></div>')
                .text(state.search ? 'Поиск: ' + state.search : 'Поиск');
            search.on('hover:enter', function () {
                Lampa.Input.edit({ title: 'Поиск', value: state.search, free: true, nosave: true }, function (value) {
                    state.search = (value || '').trim();
                    self.drawHead();
                    self.load(true);
                    Lampa.Controller.toggle('content');
                });
            });

            var tags = $('<div class="hstream__btn selector"></div>')
                .text(state.tags.length ? 'Теги: ' + state.tags.length : 'Теги');
            tags.on('hover:enter', function () { self.openTags(); });

            head.append(search).append(tags);

            if (state.search || state.tags.length) {
                var reset = $('<div class="hstream__btn selector">Сбросить</div>');
                reset.on('hover:enter', function () {
                    state.search = '';
                    state.tags = [];
                    self.drawHead();
                    self.load(true);
                });
                head.append(reset);
            }

            head.find('.selector').on('hover:focus', function (e) {
                last = e.target;
                scroll.update($(e.target), true);
            });
        };

        this.openTags = function () {
            if (!allTags.length) return Lampa.Noty.show('Список тегов ещё не загружен');

            var before = state.tags.join(',');
            var selected = state.tags.slice();

            Lampa.Select.show({
                title: 'Теги',
                items: allTags.map(function (t) {
                    return { title: t.title, value: t.value, checkbox: true, checked: selected.indexOf(t.value) >= 0 };
                }),
                onCheck: function (item) {
                    var i = selected.indexOf(item.value);
                    if (item.checked && i < 0) selected.push(item.value);
                    if (!item.checked && i >= 0) selected.splice(i, 1);
                },
                onBack: function () {
                    state.tags = selected;
                    self.drawHead();
                    if (selected.join(',') !== before) self.load(true);
                    Lampa.Controller.toggle('content');
                }
            });
        };

        // ---------- карточки ----------
        this.addCard = function (item) {
            var card = $('<div class="hstream__card selector">' +
                '<div class="hstream__img"><img alt=""></div>' +
                '<div class="hstream__title"></div>' +
                '<div class="hstream__timeline"></div>' +
                '</div>');

            card.find('img').attr('src', item.image).on('load', function () {
                card.find('.hstream__img').addClass('hstream__img--loaded');
            });
            card.find('.hstream__title').text(item.title);
            if (item.badge) card.find('.hstream__img').append($('<div class="hstream__badge"></div>').text(item.badge));
            card.find('.hstream__timeline').append(Lampa.Timeline.render(Lampa.Timeline.view(timelineHash(item.slug))));

            card.on('hover:focus', function () {
                last = card[0];
                scroll.update(card, true);

                // Подгружаем следующую страницу, когда фокус дошёл до последнего ряда
                var cards = grid.children('.hstream__card');
                if (cards.index(card) >= cards.length - 6) self.load(false);
            });
            card.on('hover:enter', function () { self.play(item); });

            grid.append(card);
        };

        this.play = function (item) {
            Lampa.Loading.start(function () { Lampa.Loading.stop(); });

            resolveEpisode(item.url, function (first, ep) {
                Lampa.Loading.stop();

                first.timeline = Lampa.Timeline.view(timelineHash(item.slug));

                // Плейлист из остальных серий тайтла; ссылки получаем по требованию
                var playlist = ep.episodes.map(function (e) {
                    if (e.slug === item.slug) return first;
                    var cell = {
                        title: ep.title.replace(/\s*Episode\s+\d+$/, '') + ' - ' + e.number,
                        timeline: Lampa.Timeline.view(timelineHash(e.slug))
                    };
                    cell.url = function (call) {
                        resolveEpisode(e.url, function (res) {
                            $.extend(cell, res);
                            call();
                        }, function () {
                            cell.url = '';
                            Lampa.Noty.show('HStream: не удалось получить ссылку');
                            call();
                        });
                    };
                    return cell;
                });

                if (playlist.length > 1) first.playlist = playlist;
                Lampa.Player.play(first);
                Lampa.Player.playlist(playlist.length > 1 ? playlist : [first]);
            }, function () {
                Lampa.Loading.stop();
                Lampa.Noty.show('HStream: не удалось получить ссылку на видео');
            });
        };

        // ---------- жизненный цикл ----------
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
            scroll.destroy();
            html.remove();
        };
    }

    Lampa.Component.add('hstream', Component);

    // ---------- пункт в левом меню ----------
    function addMenu() {
        if ($('.menu .menu__item[data-action="hstream"]').length) return;

        var item = $('<li class="menu__item selector" data-action="hstream">' +
            '<div class="menu__ico"><svg viewBox="0 0 24 24" width="24" height="24" fill="none">' +
            '<rect x="2" y="4" width="20" height="16" rx="3" stroke="currentColor" stroke-width="2"/>' +
            '<path d="M10 9v6l5-3z" fill="currentColor"/></svg></div>' +
            '<div class="menu__text">HStream</div></li>');

        item.on('hover:enter', function () {
            Lampa.Activity.push({ url: '', title: 'HStream', component: 'hstream', page: 1 });
        });

        $('.menu .menu__list').eq(0).append(item);
    }

    $('<style>' +
        '.hstream{padding:0 1.5em 2em}' +
        '.hstream__head{display:flex;flex-wrap:wrap;gap:1em;padding:1em 0 .5em}' +
        '.hstream__btn{padding:.6em 1.2em;border-radius:.4em;background:rgba(255,255,255,.1);font-size:1.2em}' +
        '.hstream__btn.focus{background:#fff;color:#000}' +
        '.hstream__grid{display:flex;flex-wrap:wrap;margin:0 -.6em}' +
        '.hstream__card{width:25%;padding:.6em;box-sizing:border-box}' +
        '.hstream__img{position:relative;padding-bottom:56.25%;border-radius:.5em;overflow:hidden;background:rgba(255,255,255,.06)}' +
        '.hstream__img img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .3s}' +
        '.hstream__img--loaded img{opacity:1}' +
        '.hstream__card.focus .hstream__img::after{content:"";position:absolute;inset:0;border:.25em solid #fff;border-radius:.5em}' +
        '.hstream__badge{position:absolute;top:.5em;right:.5em;padding:.2em .6em;border-radius:1em;background:rgba(0,0,0,.7);font-size:.8em}' +
        '.hstream__title{margin-top:.5em;font-size:1.1em;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '.hstream__timeline .time-line{margin-top:.4em}' +
        '.hstream__empty{width:100%;padding:3em;text-align:center;font-size:1.3em;opacity:.7}' +
        '@media screen and (max-width:900px){.hstream__card{width:33.33%}}' +
        '@media screen and (max-width:580px){.hstream__card{width:50%}}' +
        '</style>').appendTo('head');

    if (window.appready) addMenu();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type == 'ready') addMenu();
    });
})();
