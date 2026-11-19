/*
 * HLS Boost — плагин для Lampa (desktop / web / Tizen / webOS / Android TV)
 *
 * Что делает (только когда видео играет через программный плеер hls.js):
 *  1. Убирает 10-секундный обрыв загрузки сегментов видео. В Lampa таймаут для плейлиста
 *     по ошибке ставится на ВСЕ запросы, из-за этого медленный сегмент обрывается ->
 *     "fragLoadError" -> качается заново -> видео встаёт.
 *  2. Увеличивает буфер вперёд (по умолчанию 90с на ПК, 60с на ТВ; было 30с).
 *  3. Больше повторов при сетевых сбоях сегментов.
 *  4. Автовосстановление после фатальных ошибок сети/декодера вместо "шума" на экране.
 *  5. Прячет с экрана нефатальные ошибки (fragLoadError fatal [false] и т.п.) — они всё равно в журнале.
 *  6. Журнал в Меню -> Консоль -> вкладка "HLS": скорость каждого сегмента, остановки, ошибки.
 *
 * Настройки: Настройки -> HLS Boost.
 * Код в ES5, чтобы работал на старых телевизорах.
 */
(function () {
  'use strict';

  if (window.__hls_boost_loaded) return;
  window.__hls_boost_loaded = true;

  var VERSION = '1.0.0';

  // ---------------------------------------------------------------- настройки
  function storageField(name, def) {
    try {
      var v = window.Lampa && Lampa.Storage ? Lampa.Storage.field(name) : undefined;
      if (v === undefined || v === null || v === '') return def;
      return v;
    } catch (e) {
      return def;
    }
  }
  function isOn(name) {
    var v = storageField(name, true);
    return !(v === false || v === 'false');
  }
  function isTv() {
    try {
      var p = Lampa.Platform;
      return p.is('tizen') || p.is('webos') || p.is('orsay') || p.is('android') || p.is('netcast');
    } catch (e) {
      return false;
    }
  }
  function bufferSeconds() {
    var def = isTv() ? 60 : 90;
    var v = parseInt(storageField('hls_boost_buffer', 'auto'), 10);
    return v > 0 ? v : def;
  }

  // ---------------------------------------------------------------- журнал
  function log(msg) {
    if (!isOn('hls_boost_log')) return;
    try {
      console.log('HLS', msg);
    } catch (e) {}
  }
  function shortUrl(url) {
    try {
      var a = document.createElement('a');
      a.href = url;
      var path = a.pathname.length > 50 ? '...' + a.pathname.slice(-50) : a.pathname;
      return a.host + path;
    } catch (e) {
      return String(url).slice(0, 80);
    }
  }
  function bufferAhead(video) {
    try {
      var t = video.currentTime, b = video.buffered;
      for (var i = 0; i < b.length; i++) {
        if (t >= b.start(i) - 0.2 && t <= b.end(i)) return +(b.end(i) - t).toFixed(1);
      }
    } catch (e) {}
    return 0;
  }
  function mbit(bps) {
    return bps ? +(bps / 1000000).toFixed(2) : 0;
  }
  function isPlaylist(url) {
    return /\.m3u8?(\?|#|$)/i.test(String(url || ''));
  }

  // ---------------------------------------------------------------- конфиг hls.js
  function boostConfig(config) {
    var c = {};
    var k;
    if (config) for (k in config) if (Object.prototype.hasOwnProperty.call(config, k)) c[k] = config[k];
    if (!isOn('hls_boost_enabled')) return c;

    // 1. таймаут только для плейлистов, сегменты не обрываем
    var origSetup = c.xhrSetup;
    c.xhrSetup = function (xhr, url) {
      var r;
      if (origSetup) r = origSetup.call(this, xhr, url);
      if (!isPlaylist(url)) {
        try {
          xhr.timeout = 0;
        } catch (e) {}
        xhr.ontimeout = null;
      }
      return r;
    };

    // 2. буфер
    var buf = bufferSeconds();
    c.maxBufferLength = buf;
    c.maxMaxBufferLength = buf;
    c.maxBufferSize = Math.round(buf * 1.6 * 1000 * 1000); // ~12.8 Мбит/с на секунду буфера
    c.backBufferLength = isTv() ? 20 : 30; // просмотренное держим недолго, освобождаем память
    c.startFragPrefetch = true;

    // 3. повторы загрузки сегментов
    c.fragLoadPolicy = {
      "default": {
        maxTimeToFirstByteMs: 15000,
        maxLoadTimeMs: 120000,
        timeoutRetry: { maxNumRetry: 6, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 8, retryDelayMs: 1000, maxRetryDelayMs: 8000 }
      }
    };
    return c;
  }

  // ---------------------------------------------------------------- экземпляр
  function setupInstance(Orig, hls) {
    var E = Orig.Events;
    var ET = Orig.ErrorTypes || {};
    var recover_log = [];

    // 4. автовосстановление (наш обработчик регистрируется раньше, чем обработчик Lampa)
    hls.on(E.ERROR, function (event, d) {
      if (!d || !d.fatal || !isOn('hls_boost_enabled') || !isOn('hls_boost_recover')) return;
      if (!hls.media) return; // парсер манифеста, не плеер
      if (!hls.levels || !hls.levels.length) return; // манифест не загрузился — пусть Lampa переключит на резерв

      var now = Date.now();
      recover_log = recover_log.filter(function (r) {
        return now - r.t < 120000;
      });
      var same = recover_log.filter(function (r) {
        return r.type === d.type;
      }).length;

      if (d.type === ET.NETWORK_ERROR && same < 6) {
        recover_log.push({ t: now, type: d.type });
        d.fatal = false;
        d.boost_recovered = true;
        var delay = 1000 * (same + 1);
        log('RECOVER network #' + (same + 1) + ' (' + d.details + '), restart loading in ' + delay + 'ms');
        setTimeout(function () {
          try {
            if (hls.media) hls.startLoad();
          } catch (e) {}
        }, delay);
      } else if (d.type === ET.MEDIA_ERROR && same < 3) {
        recover_log.push({ t: now, type: d.type });
        d.fatal = false;
        d.boost_recovered = true;
        var media = hls.media;
        var pos = media.currentTime;
        var was_playing = !media.paused;
        log('RECOVER media #' + (same + 1) + ' (' + d.details + ') at t=' + pos.toFixed(1));
        try {
          if (same === 1 && hls.swapAudioCodec) hls.swapAudioCodec();
          hls.recoverMediaError();
        } catch (e) {}
        // после пересоздания MediaSource видео стоит на паузе и может сбросить позицию — возвращаем
        var restore = function () {
          hls.off(E.FRAG_BUFFERED, restore);
          try {
            if (Math.abs(media.currentTime - pos) > 1) media.currentTime = pos;
            if (was_playing && media.paused) {
              var p = media.play();
              if (p && p.catch) p.catch(function () {});
            }
          } catch (e) {}
        };
        (hls.__boost_on || hls.on).call(hls, E.FRAG_BUFFERED, restore);
      } else {
        log('RECOVER gave up: ' + d.type + '/' + d.details + ' (attempts in 2 min: ' + same + ')');
      }
    });

    // 5. прячем нефатальные ошибки от обработчика Lampa (иначе текст висит на экране)
    var origOn = hls.on;
    hls.__boost_on = origOn; // для собственных обработчиков плагина (их не фильтруем)
    hls.on = function (ev, fn, ctx) {
      if (ev === E.ERROR && typeof fn === 'function') {
        var wrapped = function (event, d) {
          if (d && !d.fatal && hls.media && isOn('hls_boost_enabled') && isOn('hls_boost_hide')) return;
          return fn.apply(this, arguments);
        };
        return origOn.call(this, ev, wrapped, ctx);
      }
      return origOn.apply(this, arguments);
    };

    // 6. журнал — начинаем, когда плеер привязан к видео
    var origAttach = hls.attachMedia;
    hls.attachMedia = function (media) {
      var r = origAttach.apply(this, arguments);
      if (hls.__boost_diag) return r; // повторная привязка после recoverMediaError — журнал уже идёт
      hls.__boost_diag = true;
      try {
        diagnostics(Orig, hls, media);
      } catch (e) {
        log('diag error ' + e.message);
      }
      return r;
    };
  }

    // 2. буфер
    var buf = bufferSeconds();
    c.maxBufferLength = buf;
    c.maxMaxBufferLength = buf;
    c.maxBufferSize = Math.round(buf * 1.6 * 1000 * 1000); // ~12.8 Мбит/с на секунду буфера
    c.backBufferLength = isTv() ? 20 : 30; // просмотренное держим недолго, освобождаем память
    c.startFragPrefetch = true;

    // 3. повторы загрузки сегментов
    c.fragLoadPolicy = {
      "default": {
        maxTimeToFirstByteMs: 15000,
        maxLoadTimeMs: 120000,
        timeoutRetry: { maxNumRetry: 6, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 8, retryDelayMs: 1000, maxRetryDelayMs: 8000 }
      }
    };
    return c;
  }

  // ---------------------------------------------------------------- экземпляр
  function setupInstance(Orig, hls) {
    var E = Orig.Events;
    var ET = Orig.ErrorTypes || {};
    var recover_log = [];

    // 4. автовосстановление (наш обработчик регистрируется раньше, чем обработчик Lampa)
    hls.on(E.ERROR, function (event, d) {
      if (!d || !d.fatal || !isOn('hls_boost_enabled') || !isOn('hls_boost_recover')) return;
      if (!hls.media) return; // парсер манифеста, не плеер
      if (!hls.levels || !hls.levels.length) return; // манифест не загрузился — пусть Lampa переключит на резерв

      var now = Date.now();
      recover_log = recover_log.filter(function (r) {
        return now - r.t < 120000;
      });
      var same = recover_log.filter(function (r) {
        return r.type === d.type;
      }).length;

      if (d.type === ET.NETWORK_ERROR && same < 6) {
        recover_log.push({ t: now, type: d.type });
        d.fatal = false;
        d.boost_recovered = true;
        var delay = 1000 * (same + 1);
        log('RECOVER network #' + (same + 1) + ' (' + d.details + '), restart loading in ' + delay + 'ms');
        setTimeout(function () {
          try {
            if (hls.media) hls.startLoad();
          } catch (e) {}
        }, delay);
      } else if (d.type === ET.MEDIA_ERROR && same < 3) {
        recover_log.push({ t: now, type: d.type });
        d.fatal = false;
        d.boost_recovered = true;
        var media = hls.media;
        var pos = media.currentTime;
        var was_playing = !media.paused;
        log('RECOVER media #' + (same + 1) + ' (' + d.details + ') at t=' + pos.toFixed(1));
        try {
          if (same === 1 && hls.swapAudioCodec) hls.swapAudioCodec();
          hls.recoverMediaError();
        } catch (e) {}
        // после пересоздания MediaSource видео стоит на паузе и может сбросить позицию — возвращаем
        var restore = function () {
          hls.off(E.FRAG_BUFFERED, restore);
          try {
            if (Math.abs(media.currentTime - pos) > 1) media.currentTime = pos;
            if (was_playing && media.paused) {
              var p = media.play();
              if (p && p.catch) p.catch(function () {});
            }
          } catch (e) {}
        };
        (hls.__boost_on || hls.on).call(hls, E.FRAG_BUFFERED, restore);
      } else {
        log('RECOVER gave up: ' + d.type + '/' + d.details + ' (attempts in 2 min: ' + same + ')');
      }
    });

    // 5. прячем нефатальные ошибки от обработчика Lampa (иначе текст висит на экране)
    var origOn = hls.on;
    hls.__boost_on = origOn; // для собственных обработчиков плагина (их не фильтруем)
    hls.on = function (ev, fn, ctx) {
      if (ev === E.ERROR && typeof fn === 'function') {
        var wrapped = function (event, d) {
          if (d && !d.fatal && hls.media && isOn('hls_boost_enabled') && isOn('hls_boost_hide')) return;
          return fn.apply(this, arguments);
        };
        return origOn.call(this, ev, wrapped, ctx);
      }
      return origOn.apply(this, arguments);
    };

    // 6. журнал — начинаем, когда плеер привязан к видео
    var origAttach = hls.attachMedia;
    hls.attachMedia = function (media) {
      var r = origAttach.apply(this, arguments);
      if (hls.__boost_diag) return r; // повторная привязка после recoverMediaError — журнал уже идёт
      hls.__boost_diag = true;
      try {
        diagnostics(Orig, hls, media);
      } catch (e) {
        log('diag error ' + e.message);
      }
      return r;
    };
  }


  function diagnostics(Orig, hls, video) {
    var E = Orig.Events;
    var on = function (ev, fn) {
      (hls.__boost_on || hls.on).call(hls, ev, fn);
    };
    var started = Date.now();
    var stalls = 0, frag_errors = 0, stall_start = 0;
    var last_frag = null;

    var levelInfo = function (idx) {
      var l = hls.levels && hls.levels[idx];
      return l ? l.width + 'x' + l.height + '@' + mbit(l.bitrate) + 'Mb' : String(idx);
    };
    var state = function () {
      return 'buf=' + bufferAhead(video) + 's t=' + (video.currentTime || 0).toFixed(1) +
        ' bwEst=' + mbit(hls.bandwidthEstimate) + 'Mb lvl=' + levelInfo(hls.currentLevel);
    };

    log('==== START hls.js ' + Orig.version + ', plugin ' + VERSION + ', enabled=' + isOn('hls_boost_enabled') +
      ', maxBuffer=' + hls.config.maxBufferLength + 's backBuffer=' + hls.config.backBufferLength + 's ====');

    on(E.MANIFEST_PARSED, function (e, d) {
      log('MANIFEST ' + shortUrl(hls.url) + ' levels=' + d.levels.length + ' [' + d.levels.map(function (l, i) {
        return i + ':' + l.width + 'x' + l.height + '@' + mbit(l.bitrate) + 'Mb';
      }).join(', ') + ']');
    });
    on(E.FRAG_LOADING, function (e, d) {
      last_frag = d.frag;
    });
    on(E.FRAG_LOADED, function (e, d) {
      var f = d.frag, st = f.stats;
      if (!st || !st.loading) return;
      var ttfb = Math.round(st.loading.first - st.loading.start);
      var total = Math.round(st.loading.end - st.loading.start);
      var speed = total > 0 ? st.loaded * 8 / total / 1000 : 0;
      var dur = f.duration || 0;
      var ratio = dur ? total / 1000 / dur : 0;
      var flag = ratio > 1 ? ' !!SLOW' : ratio > 0.7 ? ' !slowish' : '';
      log('FRAG sn=' + f.sn + ' ' + (st.loaded / 1048576).toFixed(2) + 'MB dur=' + dur.toFixed(1) + 's ttfb=' + ttfb +
        'ms load=' + total + 'ms speed=' + speed.toFixed(2) + 'Mb ratio=' + ratio.toFixed(2) +
        (st.retry ? ' retry=' + st.retry : '') + flag + ' | ' + state());
    });
    on(E.ERROR, function (e, d) {
      if (d.details && d.details.indexOf('frag') === 0) frag_errors++;
      var p = ['ERROR ' + d.type + '/' + d.details + ' fatal=' + (d.boost_recovered ? 'true (recovering)' : d.fatal)];
      if (d.reason) p.push('reason=' + d.reason);
      if (d.error && d.error.message) p.push('msg=' + d.error.message);
      if (d.response) p.push('http=' + d.response.code);
      var f = d.frag || last_frag;
      if (f) {
        p.push('frag sn=' + f.sn);
        var st = d.stats || f.stats;
        if (st && st.loading) {
          p.push('loaded=' + (st.loaded / 1048576).toFixed(2) + 'MB elapsed=' +
            Math.round((st.loading.end || performance.now()) - st.loading.start) + 'ms retry=' + (st.retry || 0));
        }
      }
      p.push(state());
      log(p.join(' | '));
    });

    var onWaiting = function () {
      stall_start = Date.now();
      stalls++;
      log('STALL #' + stalls + ' ' + state() + (last_frag ? ' loadingFrag sn=' + last_frag.sn : ''));
    };
    var onPlaying = function () {
      if (stall_start) {
        log('RESUMED after ' + (Date.now() - stall_start) + 'ms | ' + state());
        stall_start = 0;
      }
    };
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);

    var timer = setInterval(function () {
      try {
        var q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        if (q && q.totalVideoFrames) {
          log('QUALITY dropped=' + q.droppedVideoFrames + '/' + q.totalVideoFrames + ' | ' + state());
        }
      } catch (e) {}
    }, 30000);

    on(E.DESTROYING, function () {
      clearInterval(timer);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      log('==== STOP after ' + Math.round((Date.now() - started) / 1000) + 's, stalls=' + stalls + ', fragErrors=' + frag_errors + ' ====');
    });
  }
