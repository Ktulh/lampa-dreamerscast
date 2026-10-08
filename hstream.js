(function () {
    'use strict';

    if (window.plugin_hstream_ready) return;
    window.plugin_hstream_ready = true;

    var BASE = 'https://hstream.moe';

    Lampa.Manifest.plugins = {
        type: 'video',
        version: '1.2.0',
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

    function text(node) {
        return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
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

    function seriesSlug(slug) {
        return slug.replace(/-\d+$/, '');
    }

    // ---------- разбор страниц ----------
    function parseSearch(str) {
        var doc = parseHtml(str);
        var items = [];

        doc.querySelectorAll('[wire\\:key^="episode-"]').forEach(function (node) {
            var a = node.querySelector('a[href*="/hentai/"]');
            if (!a) return;
            var img = node.querySelector('img');
            var badge = node.querySelector('.rounded-full');
            var slug = a.getAttribute('href').split('/hentai/').pop();
            items.push({
                slug: slug,
                series: seriesSlug(slug),
                title: text(node.querySelector('h3')) || (img && img.getAttribute('alt')) || slug,
                image: abs(img && img.getAttribute('src')),
                badge: text(badge)
            });
        });

        var pages = 1;
        (str.match(/gotoPage\((\d+)\)/g) || []).forEach(function (m) {
            pages = Math.max(pages, parseInt(m.replace(/\D/g, ''), 10));
        });

        var tags = [];
        doc.querySelectorAll('input[name="tags[]"]').forEach(function (input) {
            var label = doc.querySelector('label[for="' + input.id + '"]');
            tags.push({ value: input.value, title: text(label) || input.value });
        });

        return { items: items, pages: pages, tags: tags };
    }

    // Страница тайтла: /hentai/<series>
    function parseSeries(str, series) {
        var doc = parseHtml(str);
        var h1 = doc.querySelector('h1');
        var head = h1 && h1.parentElement;

        var description = '';
        doc.querySelectorAll('h2').forEach(function (h2) {
            if (!description && text(h2) === 'Description') {
                description = h2.parentElement.textContent.replace(/^\s*Description\s*/, '')
                    .split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join('\n');
            }
        });

        function pill(icon) {
            var i = doc.querySelector('i.' + icon);
            return i ? text(i.parentElement) : '';
        }

        var tags = [];
        doc.querySelectorAll('a[href*="tags%5B0%5D="]').forEach(function (a) {
            var t = text(a);
            if (t && tags.indexOf(t) < 0) tags.push(t);
        });

        var episodes = [];
        var seen = {};
        var re = new RegExp('/hentai/' + series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$');
        doc.querySelectorAll('a[href*="/hentai/"]').forEach(function (a) {
            var href = a.getAttribute('href');
            var m = href.match(re);
            if (!m || seen[href]) return;
            seen[href] = true;
            var img = a.querySelector('img');
            episodes.push({
                slug: href.split('/hentai/').pop(),
                url: abs(href),
                number: parseInt(m[1], 10),
                image: abs(img && img.getAttribute('src')),
                badge: text(a.querySelector('.rounded-full'))
            });
        });
        episodes.sort(function (a, b) { return a.number - b.number; });

        var cover = doc.querySelector('img[src*="/cover-"]');
        var og = doc.querySelector('meta[property="og:image"]');

        return {
            title: text(h1),
            original: head ? text(head.querySelector('p')) : '',
            released: pill('fa-calendar'),
            uploaded: pill('fa-upload'),
            studio: text(doc.querySelector('a[href*="studios%5B0%5D="]')),
            tags: tags,
            description: description,
            cover: abs(cover && cover.getAttribute('src')),
            background: og ? og.getAttribute('content') : '',
            episodes: episodes
        };
    }

    // ---------- качество ----------
    var QUALITY_ORDER = ['2160', '1080i', '1080', '720'];
    var QUALITY_NAMES = {
        '720': 'H.264 720p',
        '1080': 'AV1 1080p',
        '1080i': 'AV1 1080p 48fps',
        '2160': 'AV1 4K'
    };

    function preferredQuality() {
        var q = String(Lampa.Storage.get('hstream_quality', '720'));
        return QUALITY_NAMES[q] ? q : '720';
    }

    // Берём выбранное качество, а если его у серии нет — ближайшее ниже
    function pickVariant(variants, want) {
        var start = QUALITY_ORDER.indexOf(want);
        if (start < 0) start = QUALITY_ORDER.length - 1;
        for (var i = start; i < QUALITY_ORDER.length; i++) {
            if (variants[QUALITY_ORDER[i]]) return variants[QUALITY_ORDER[i]];
        }
        return variants['720'];
    }

    // Страница серии → /player/api → объект для плеера Lampa
    function resolveEpisode(url, want, ok, fail) {
        request(url, {}, function (str) {
            var eid = str.match(/id="e_id"\s+type="hidden"\s+value="(\d+)"/);
            var csrf = str.match(/data-csrf="([^"]+)"/) || str.match(/name="csrf-token"\s+content="([^"]+)"/);
            if (!eid || !csrf) return fail('no episode id');

            request(BASE + '/player/api', {
                post: JSON.stringify({ episode_id: eid[1] }),
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': csrf[1],
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': url
                }
            }, function (body) {
                var d;
                try { d = typeof body === 'string' ? JSON.parse(body) : body; } catch (e) { return fail('bad api json'); }
                if (!d || !d.stream_url || !d.stream_domains || !d.stream_domains.length) return fail('no stream');

                var domain = d.stream_domains[Math.floor(Math.random() * d.stream_domains.length)];
                var base = domain + '/' + d.stream_url;

                // 720p есть только в H.264 (mp4) — самый совместимый вариант.
                // 1080p / 1080p 48fps / 4K — только AV1 DASH: картинка лучше, но не всякий ТВ его тянет.
                var variants = { '720': base + '/x264.720p.mp4', '1080': base + '/1080/manifest.mpd' };
                if (d.interpolated) variants['1080i'] = base + '/1080i/manifest.mpd';
                if (/tags%5B0%5D=4k"/.test(str)) variants['2160'] = base + '/2160/manifest.mpd';

                // Ключи не начинаются с цифры: Lampa подменяет ссылку на качество, у которого
                // parseInt(ключ) совпадает с её «качеством по умолчанию», и перебила бы выбор плагина.
                var quality = {};
                QUALITY_ORDER.forEach(function (q) {
                    if (variants[q]) quality[QUALITY_NAMES[q]] = variants[q];
                });

                ok({
                    title: d.title || '',
                    url: pickVariant(variants, want),
                    quality: quality,
                    subtitles: [{ label: 'English', url: base + '/eng.vtt' }]
                });
            }, fail);
        }, fail);
    }

    function timelineHash(slug) {
        return Lampa.Utils.hash('hstream:' + slug);
    }

    function playEpisode(ep, want, onStart) {
        var cancelled = false;
        Lampa.Loading.start(function () {
            cancelled = true;
            Lampa.Loading.stop();
        });

        resolveEpisode(ep.url, want || preferredQuality(), function (video) {
            if (cancelled) return;
            Lampa.Loading.stop();

            video.timeline = Lampa.Timeline.view(timelineHash(ep.slug));
            if (onStart) onStart();

            Lampa.Player.play(video);
            Lampa.Player.playlist([video]);
        }, function () {
            Lampa.Loading.stop();
            if (!cancelled) Lampa.Noty.show('HStream: не удалось получить ссылку на видео');
        });
    }

    function chooseQuality(onSelect) {
        var enabled = Lampa.Controller.enabled().name;
        Lampa.Select.show({
            title: 'Качество',
            items: QUALITY_ORDER.map(function (q) { return { title: QUALITY_NAMES[q], value: q }; }),
            onSelect: function (a) {
                Lampa.Controller.toggle(enabled);
                onSelect(a.value);
            },
            onBack: function () { Lampa.Controller.toggle(enabled); }
        });
    }

    function controller(scroll, getLast) {
        Lampa.Controller.add('content', {
            toggle: function () {
                Lampa.Controller.collectionSet(scroll.render());
                Lampa.Controller.collectionFocus(getLast() || false, scroll.render());
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
    }

    // ---------- каталог (поиск сайта) ----------
    function Catalog(object) {
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

        // Шапка: поиск и теги
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
            card.on('hover:enter', function () {
                Lampa.Activity.push({
                    url: '',
                    title: item.title.replace(/\s*-\s*\d+$/, ''),
                    component: 'hstream_title',
                    series: item.series,
                    episode: item.slug,
                    page: 1
                });
            });

            grid.append(card);
        };

        this.start = function () {
            if (Lampa.Activity.active().activity !== this.activity) return;
            controller(scroll, function () { return last; });
        };

        this.render = function () { return scroll.render(); };
        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            scroll.destroy();
            html.remove();
        };
    }

    // ---------- карточка тайтла: описание и все серии ----------
    function Title(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var html = $('<div class="hstream-title"></div>');
        var last;
        var info;

        scroll.minus();

        this.create = function () {
            this.activity.loader(true);

            request(BASE + '/hentai/' + object.series, {}, function (str) {
                self.activity.loader(false);
                info = parseSeries(str, object.series);
                if (!info.title && !info.episodes.length) return self.empty();
                self.draw();
            }, function () {
                self.activity.loader(false);
                self.empty();
            });

            return this.render();
        };

        this.empty = function () {
            html.empty().append('<div class="hstream__empty">Не удалось загрузить страницу тайтла</div>');
            scroll.append(html);
            this.start();
        };

        this.draw = function () {
            html.empty();

            var top = $('<div class="hstream-title__top">' +
                '<div class="hstream-title__cover"><img alt=""></div>' +
                '<div class="hstream-title__info">' +
                '<div class="hstream-title__name"></div>' +
                '<div class="hstream-title__original"></div>' +
                '<div class="hstream-title__meta"></div>' +
                '<div class="hstream-title__tags"></div>' +
                '</div></div>');

            if (info.cover) top.find('img').attr('src', info.cover);
            else top.find('.hstream-title__cover').remove();
            top.find('.hstream-title__name').text(info.title);
            top.find('.hstream-title__original').text(info.original);

            var meta = [];
            if (info.released) meta.push('Выход: ' + info.released);
            if (info.studio) meta.push(info.studio);
            meta.push('Серий: ' + info.episodes.length);
            top.find('.hstream-title__meta').text(meta.join('  ●  '));
            top.find('.hstream-title__tags').text(info.tags.join(', '));

            // Шапка — selector, чтобы по ней можно было «доскроллить» вверх к описанию
            top.addClass('selector');
            top.on('hover:focus', function () {
                last = top[0];
                scroll.update(top, true);
            });
            html.append(top);

            if (info.description) {
                var descr = $('<div class="hstream-title__descr selector"></div>').text(info.description);
                descr.on('hover:focus', function () {
                    last = descr[0];
                    scroll.update(descr, true);
                });
                html.append(descr);
            }

            html.append('<div class="hstream-title__head">Серии</div>');

            var list = $('<div class="hstream__grid"></div>');
            info.episodes.forEach(function (ep) {
                var card = $('<div class="hstream__card selector">' +
                    '<div class="hstream__img"><img alt=""></div>' +
                    '<div class="hstream__title"></div>' +
                    '<div class="hstream__timeline"></div>' +
                    '</div>');

                card.find('img').attr('src', ep.image).on('load', function () {
                    card.find('.hstream__img').addClass('hstream__img--loaded');
                });
                card.find('.hstream__title').text('Серия ' + ep.number);
                if (ep.badge) card.find('.hstream__img').append($('<div class="hstream__badge"></div>').text(ep.badge));
                card.find('.hstream__timeline').append(Lampa.Timeline.render(Lampa.Timeline.view(timelineHash(ep.slug))));

                card.on('hover:focus', function () {
                    last = card[0];
                    scroll.update(card, true);
                });
                card.on('hover:enter', function () { playEpisode(ep); });
                card.on('hover:long', function () {
                    chooseQuality(function (q) { playEpisode(ep, q); });
                });

                list.append(card);
                if (ep.slug === object.episode) last = card[0];
            });
            html.append(list);

            scroll.append(html);
            if (last) scroll.update($(last), true);
            if (info.background) Lampa.Background.immediately(info.background);
            this.start();
        };

        this.start = function () {
            if (Lampa.Activity.active().activity !== this.activity) return;
            if (info && info.background) Lampa.Background.immediately(info.background);
            controller(scroll, function () { return last; });
        };

        this.render = function () { return scroll.render(); };
        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            scroll.destroy();
            html.remove();
        };
    }

    Lampa.Component.add('hstream', Catalog);
    Lampa.Component.add('hstream_title', Title);

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

    // ---------- настройки ----------
    if (Lampa.SettingsApi) {
        Lampa.SettingsApi.addComponent({
            component: 'hstream',
            name: 'HStream',
            icon: '<svg viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="16" rx="3" stroke="currentColor" stroke-width="2"/><path d="M10 9v6l5-3z" fill="currentColor"/></svg>'
        });
        Lampa.SettingsApi.addParam({
            component: 'hstream',
            param: {
                name: 'hstream_quality',
                type: 'select',
                values: {
                    '720': 'H.264 720p — работает везде',
                    '1080': 'AV1 1080p',
                    '1080i': 'AV1 1080p 48fps',
                    '2160': 'AV1 4K'
                },
                'default': '720'
            },
            field: {
                name: 'Качество по умолчанию',
                description: 'Выше 720p на сайте только AV1: нужен ТВ или плеер с поддержкой AV1. Разово выбрать качество — долгое нажатие на серию.'
            }
        });
    }

    $('<style>' +
        '.hstream,.hstream-title{padding:0 1.5em 2em}' +
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
        '.hstream-title__top{display:flex;gap:2em;padding:1.5em 0 1em;border-radius:.6em}' +
        '.hstream-title__cover{width:11em;flex-shrink:0}' +
        '.hstream-title__cover img{width:100%;border-radius:.6em;display:block}' +
        '.hstream-title__info{min-width:0}' +
        '.hstream-title__name{font-size:2.4em;font-weight:700;line-height:1.2}' +
        '.hstream-title__original{opacity:.6;margin-top:.3em;font-size:1.2em}' +
        '.hstream-title__meta{margin-top:1em;font-size:1.2em}' +
        '.hstream-title__tags{margin-top:.8em;opacity:.7;line-height:1.5}' +
        '.hstream-title__descr{white-space:pre-line;line-height:1.5;font-size:1.15em;opacity:.85;padding:.8em 1em;border-radius:.6em;max-width:60em}' +
        '.hstream-title__top.focus,.hstream-title__descr.focus{background:rgba(255,255,255,.08)}' +
        '.hstream-title__head{font-size:1.6em;font-weight:600;margin:1.2em 0 .4em}' +
        '@media screen and (max-width:900px){.hstream__card{width:33.33%}}' +
        '@media screen and (max-width:580px){.hstream__card{width:50%}.hstream-title__top{flex-direction:column}}' +
        '</style>').appendTo('head');

    if (window.appready) addMenu();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type == 'ready') addMenu();
    });
})();
