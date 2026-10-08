// Газрын зургийн хуудас: Leaflet + OpenStreetMap (API түлхүүр шаардахгүй).
// ⚠️ Хуудасны JS-д backtick болон "${" ХЭРЭГЛЭХГҮЙ (энэ файл template literal).
// Бүх динамик текст (нэр, хаяг) esc()-ээр цэвэрлэгдэж innerHTML/popup-д орно (XSS-ээс сэргийлнэ).
export const TRACKING_PAGE_HTML = `<!DOCTYPE html>
<html lang="mn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="referrer" content="origin">
<title>Хүргэлтийн байршил</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
  html, body { height: 100%; margin: 0; font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; }
  #map { position: absolute; inset: 0; }
  #banner { display: none; position: absolute; top: 0; left: 0; right: 0; z-index: 1100; padding: 8px 12px; font-size: 13px; font-weight: 600; text-align: center; }
  #banner.err { background: #dc2626; color: #fff; }
  #banner.warn { background: #f59e0b; color: #fff; }
  #banner.ok { background: #16a34a; color: #fff; }
  #panel { position: absolute; left: 0; right: 0; bottom: 0; max-height: 42%; overflow: auto; background: #fff; border-radius: 14px 14px 0 0; box-shadow: 0 -2px 10px rgba(0,0,0,.25); padding: 10px 14px; z-index: 1000; font-size: 13px; }
  .c { border-bottom: 1px solid #eee; padding: 6px 0; }
  .ch { display: flex; justify-content: space-between; align-items: center; }
  .d { margin: 4px 0 0 8px; }
  .addr { color: #6b7280; font-size: 12px; }
  .age { font-size: 11px; padding: 1px 8px; border-radius: 10px; color: #fff; }
  .age.ok { background: #16a34a; } .age.warn { background: #f59e0b; } .age.bad { background: #dc2626; }
  .empty { color: #6b7280; text-align: center; padding: 8px; }
  .mk { width: 34px; height: 34px; border-radius: 17px; background: #fff; border: 3px solid #6b7280; display: flex; align-items: center; justify-content: center; font-size: 18px; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
  .mk.ok { border-color: #16a34a; } .mk.warn { border-color: #f59e0b; } .mk.bad { border-color: #dc2626; }
</style>
</head>
<body>
<div id="map"></div>
<div id="banner"></div>
<div id="panel"><div id="list">Ачаалж байна...</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
(function () {
  var token = new URLSearchParams(location.search).get('t');
  var STATUS = { ASSIGNED: 'Авахаар явж байна', PICKED_UP: 'Бараатай замд яваа', GIVEN: 'Өгсөн', RETURN_PICKED_UP: 'Буцаж яваа' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ageText(sec) {
    if (sec == null) return 'байршил ирээгүй';
    if (sec < 60) return sec + ' сек өмнө';
    return Math.round(sec / 60) + ' мин өмнө';
  }
  function ageClass(sec) {
    if (sec == null || sec >= 300) return 'bad';
    if (sec >= 120) return 'warn';
    return 'ok';
  }
  function meta(c) {
    var parts = [];
    if (c.vehiclePlate) parts.push('🚗 ' + c.vehiclePlate);
    parts.push(c.ratingCount > 0 ? '⭐ ' + c.ratingAverage + ' (' + c.ratingCount + ')' : '⭐ шинэ');
    if (c.completedDeliveries > 0) parts.push('✅ ' + c.completedDeliveries + ' хүргэлт');
    return parts.join(' · ');
  }
  function point(lat, lng) {
    return (typeof lat === 'number' && typeof lng === 'number') ? [lat, lng] : null;
  }
  function icon(emoji, cls) {
    return L.divIcon({ html: '<div class="mk ' + (cls || '') + '">' + emoji + '</div>', className: '', iconSize: [34, 34], iconAnchor: [17, 17] });
  }
  function setBanner(text, cls) {
    var b = document.getElementById('banner');
    if (!text) { b.style.display = 'none'; return; }
    b.className = cls || '';
    b.textContent = text;
    b.style.display = 'block';
  }

  var map = L.map('map').setView([47.9187, 106.9170], 12);
  var tileLayer = null;
  var layers = L.layerGroup().addTo(map);
  var fitted = false;
  var timer = null;

  function render(data) {
    if (!tileLayer && data.tiles) {
      tileLayer = L.tileLayer(data.tiles.urlTemplate, { maxZoom: data.tiles.maxZoom || 19, attribution: esc(data.tiles.attribution) }).addTo(map);
    }
    layers.clearLayers();
    var bounds = [];
    var shopPoint = data.shop ? point(data.shop.latitude, data.shop.longitude) : null;
    if (shopPoint) {
      L.marker(shopPoint, { icon: icon('🏪') }).bindPopup('<b>Дэлгүүр</b><br>' + esc(data.shop.address || '')).addTo(layers);
      bounds.push(shopPoint);
    }
    var html = '';
    (data.couriers || []).forEach(function (c) {
      var cp = point(c.latitude, c.longitude);
      var cls = ageClass(c.ageSeconds);
      if (cp) {
        L.marker(cp, { icon: icon('🚚', cls) }).bindPopup('<b>' + esc(c.displayName || c.name) + '</b><br>' + esc(meta(c)) + '<br>' + esc(ageText(c.ageSeconds))).addTo(layers);
        bounds.push(cp);
      }
      html += '<div class="c"><div class="ch"><b>🚚 ' + esc(c.displayName || c.name) + '</b><span class="age ' + cls + '">' + esc(ageText(c.ageSeconds)) + '</span></div><div class="addr">' + esc(meta(c)) + '</div>';
      (c.deliveries || []).forEach(function (d) {
        var pk = point(d.pickup.latitude, d.pickup.longitude);
        var ds = point(d.destination.latitude, d.destination.longitude);
        if (pk && d.isErrand) {
          L.marker(pk, { icon: icon('📦') }).bindPopup('<b>' + esc(d.pickup.label) + '</b><br>' + esc(d.pickup.address || '')).addTo(layers);
          bounds.push(pk);
        }
        if (ds) {
          L.marker(ds, { icon: icon('🏠') }).bindPopup('<b>#' + esc(d.orderNumber) + ' — хүргэх хаяг</b><br>' + esc(d.destination.address || '')).addTo(layers);
          bounds.push(ds);
        }
        var target = d.status === 'ASSIGNED' ? pk : ds;
        if (cp && target) L.polyline([cp, target], { color: '#2563eb', weight: 3, dashArray: '6 8' }).addTo(layers);
        html += '<div class="d">#' + esc(d.orderNumber) + (d.isErrand ? ' 📦' : '') + ' · ' + esc(STATUS[d.status] || d.status) +
          '<br><span class="addr">' + esc(d.pickup.label) + ' → ' + esc(d.destination.address || '—') + '</span></div>';
      });
      html += '</div>';
    });
    if (!data.couriers || data.couriers.length === 0) {
      html = '<div class="empty">' + (data.finished ? '✅ Хүргэлт дууссан' : 'Одоогоор замд яваа курьер алга') + '</div>';
    }
    document.getElementById('list').innerHTML = html;
    if (!fitted && bounds.length > 0) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
      fitted = true;
    }
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function refresh() {
    fetch('/api/track/data?t=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
      .then(function (res) {
        if (!res.ok) {
          setBanner(res.body.error || 'Алдаа гарлаа', 'err');
          if (res.status === 401 || res.status === 403 || res.status === 404) stop();
          return;
        }
        setBanner(res.body.finished ? '✅ Хүргэлт дууссан' : '', 'ok');
        render(res.body);
        if (res.body.finished) stop();
      })
      .catch(function () { setBanner('Сүлжээний алдаа — дахин оролдож байна...', 'warn'); });
  }

  if (!token) {
    setBanner('Холбоос буруу байна', 'err');
  } else {
    refresh();
    timer = setInterval(refresh, 5000);
  }
})();
</script>
</body>
</html>`;
