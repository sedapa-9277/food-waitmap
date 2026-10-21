(async () => {
  const MAX_MARKERS = 20;
  const DEFAULT_CENTER = { lat: 37.5665, lng: 126.9780 }; // 서울시청
  const DEFAULT_LEVEL = 3;    // 카카오 지도 확대 레벨(숫자가 작을수록 확대, 1~14)
  const MAX_SEARCH_LEVEL = 7; // 이보다 넓게 보면 결과가 의미 없으므로 확대를 요청
  const $ = (id) => document.getElementById(id);

  const markers = new Map(); // 식당 id -> kakao.maps.CustomOverlay
  const known = new Map();   // 식당 id -> 식당 정보
  let visible = [];
  let selectedId = null;

  const tier = (avg) => (avg == null ? "none" : avg <= 20 ? "low" : avg <= 45 ? "mid" : "high");
  const pinText = (s) => (s.error ? "-" : s.average != null ? `${s.average}분` : s.count === 1 ? "참여 중" : "수집 중");
  const ago = (t) => {
    const m = Math.floor((Date.now() - t) / 60000);
    return m < 1 ? "방금 전" : `${m}분 전`;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 두 좌표 사이 거리(m)
  function distance(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const inBounds = (r, b) => r.lat >= b.s && r.lat <= b.n && r.lng >= b.w && r.lng <= b.e;

  // ---------- 지도 (카카오 지도) ----------
  let kakao;
  try {
    kakao = await Places.sdk();
  } catch (err) {
    console.error(err);
    $("map").innerHTML = '<p class="map-error">지도를 불러올 수 없습니다.<br>잠시 후 새로고침해 주세요.</p>';
    $("count-label").textContent = "정보를 불러올 수 없음";
    return;
  }
  const LatLng = (p) => new kakao.maps.LatLng(p.lat, p.lng);
  const map = new kakao.maps.Map($("map"), { center: LatLng(DEFAULT_CENTER), level: DEFAULT_LEVEL });
  map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);

  const view = () => {
    const b = map.getBounds(), sw = b.getSouthWest(), ne = b.getNorthEast(), c = map.getCenter();
    return {
      center: { lat: c.getLat(), lng: c.getLng() },
      bounds: { s: sw.getLat(), w: sw.getLng(), n: ne.getLat(), e: ne.getLng() }
    };
  };

  // 하단 출처 문구: 마지막 조회에 실제로 쓴 식당 정보 출처를 표시
  const showSource = () => {
    $("notice").textContent = (Places.source === "kakao"
      ? "※ 지도·식당 정보: 카카오."
      : "※ 지도: 카카오 · 식당 정보: OpenStreetMap 기여자.") + " 대기시간은 모든 사용자가 공유하며 입력 후 30분간 반영됩니다.";
  };

  // ---------- 식당 조회 (js/places.js: 카카오 또는 OpenStreetMap) ----------
  async function fetchRestaurants() {
    const { center, bounds } = view();
    const rows = await Places.nearby(center, bounds, MAX_MARKERS);
    showSource();
    const seen = new Set();
    const list = rows
      .filter((r) => inBounds(r, bounds) && !seen.has(r.id) && seen.add(r.id))
      .sort((x, y) => distance(center, x) - distance(center, y));
    // 이름 검색으로 고른 식당은 주변 검색 결과에 없더라도 화면 안에 있으면 맨 앞에 넣는다
    if (pinned && inBounds(pinned, bounds) && !seen.has(pinned.id)) list.unshift(pinned);
    return list.slice(0, MAX_MARKERS).map((r) => { known.set(r.id, r); return r; });
  }

  // ---------- 식당 이름 검색 ----------
  const MAX_RESULTS = 15;
  let pinned = null;     // 이름 검색에서 고른 식당
  let results = null;    // 이름 검색 결과 목록(null이면 주변 식당 목록을 보여 줌)
  let resultMsg = "";

  async function searchByName(q) {
    const { center, bounds } = view();
    const rows = await Places.byName(q, center, bounds);
    showSource();
    const seen = new Set();
    const list = rows
      .filter((r) => !seen.has(r.id) && seen.add(r.id))
      .map((r) => ({ ...r, dist: distance(center, r) }));
    // 카카오는 정확도순(이름이 잘 맞는 곳 먼저)이 더 낫다. OSM은 순서가 의미 없으므로 가까운 곳부터
    if (Places.source !== "kakao") list.sort((x, y) => x.dist - y.dist);
    return list.slice(0, MAX_RESULTS);
  }

  const distText = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`);

  let nameSeq = 0;
  $("name-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("name-input");
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    const seq = ++nameSeq;
    input.blur(); // 모바일 키보드 닫기
    selectedId = null;
    results = [];
    resultMsg = `"${q}" 검색 중…`;
    refresh();
    try {
      const found = await searchByName(q);
      if (seq !== nameSeq) return;
      results = found;
      resultMsg = found.length ? `"${q}" 검색 결과 ${found.length}곳` : `"${q}"와(과) 일치하는 식당이 없습니다`;
    } catch (err) {
      if (seq !== nameSeq) return;
      console.error(err);
      results = [];
      resultMsg = "검색하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
    refresh();
  });

  // 코드로 지도를 옮긴다. 이때 생기는 확대 변경은 사용자 조작으로 보지 않는다(재검색 버튼을 띄우지 않음)
  let movedByCode = 0;
  function moveMap(p, level) {
    movedByCode = Date.now();
    if (level != null && map.getLevel() !== level) map.setLevel(level);
    map.setCenter(LatLng(p));
  }

  // 검색 결과에서 식당을 고르면 그 위치로 이동하고, 주변 식당과 함께 다시 불러온 뒤 상세를 연다
  function goToResult(r) {
    const { dist, ...place } = r;
    pinned = place;
    known.set(place.id, place);
    selectedId = place.id;
    moveMap(place, Math.min(map.getLevel(), DEFAULT_LEVEL));
    search();
  }

  $("result-list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-rid]");
    if (!b || !results) return;
    const r = results.find((x) => x.id === b.dataset.rid);
    if (r) goToResult(r);
  });
  $("btn-result-close").onclick = () => { results = null; refresh(); };

  let searchSeq = 0;
  async function search() {
    const seq = ++searchSeq;
    $("btn-search").hidden = true;
    if (map.getLevel() > MAX_SEARCH_LEVEL) {
      visible = [];
      refresh();
      $("count-label").textContent = "지도를 더 확대해 주세요";
      return;
    }
    $("count-label").textContent = "식당 검색 중…";
    try {
      const next = await fetchRestaurants();
      if (seq !== searchSeq) return; // 더 최근 검색 결과만 반영
      visible = next;
      refresh(); // 식당을 먼저 그리고
      await WaitStore.load(visible.map((r) => r.id)); // 대기시간 집계를 서버에서 받아 다시 그림
      if (seq !== searchSeq) return;
      refresh();
    } catch (err) {
      if (seq !== searchSeq) return;
      console.error(err);
      visible = [];
      refresh();
      $("count-label").textContent = "정보를 불러올 수 없음";
    }
  }

  // ---------- 그리기 ----------
  // 마커: [식당 이름 | 대기시간] 말풍선. 아래쪽 가운데가 식당 좌표에 오도록 yAnchor 1
  function pinHtml(r, s) {
    const sel = r.id === selectedId ? " sel" : "";
    return `<div class="pin ${tier(s.average)}${sel}"><b class="pin-name">${esc(r.name)}</b><span>${pinText(s)}</span></div>`;
  }

  function renderMarkers() {
    const ids = new Set(visible.map((r) => r.id));
    for (const [id, m] of markers) {
      if (!ids.has(id)) { m.setMap(null); markers.delete(id); }
    }
    for (const r of visible) {
      const html = pinHtml(r, WaitStore.summary(r.id));
      const z = r.id === selectedId ? 1000 : 1; // 선택한 식당을 맨 위로
      let m = markers.get(r.id);
      if (!m) {
        const el = document.createElement("div");
        el.className = "pin-wrap";
        el.title = r.name;
        el.addEventListener("click", () => select(r.id));
        el.addEventListener("mouseenter", () => markers.get(r.id)?.setZIndex(2000));
        el.addEventListener("mouseleave", () => markers.get(r.id)?.setZIndex(r.id === selectedId ? 1000 : 1));
        m = new kakao.maps.CustomOverlay({ position: LatLng(r), content: el, xAnchor: 0.5, yAnchor: 1, clickable: true });
        m.setMap(map);
        markers.set(r.id, m);
      }
      const el = m.getContent();
      if (el.innerHTML !== html) el.innerHTML = html;
      m.setZIndex(z);
    }
  }

  function renderList() {
    $("count-label").textContent = `식당 ${visible.length}곳`;
    const ul = $("list");
    if (!visible.length) {
      ul.innerHTML = '<li class="empty">이 지역에서 식당을 찾지 못했습니다. 지도를 움직이고 재검색해 보세요.</li>';
      return;
    }
    ul.innerHTML = visible.map((r) => {
      const s = WaitStore.summary(r.id);
      return `<li><button type="button" data-id="${esc(r.id)}">
        <span><span class="rname">${esc(r.name)}</span><br><span class="rmenu">${esc(r.menu)}</span></span>
        <span class="wait small ${tier(s.average)}">${pinText(s)}</span>
      </button></li>`;
    }).join("");
  }

  function renderResults() {
    if (results == null) return;
    $("result-label").textContent = resultMsg;
    $("result-list").innerHTML = results.map((r) => `<li><button type="button" data-rid="${esc(r.id)}">
        <span><span class="rname">${esc(r.name)}</span><br><span class="raddr">${esc(r.address || r.menu)}</span></span>
        <span class="hint">${distText(r.dist)}</span>
      </button></li>`).join("");
  }

  // 패널: 상세(식당 선택) > 이름 검색 결과 > 주변 식당 목록 순으로 하나만 보인다
  function renderDetail() {
    const r = known.get(selectedId);
    $("list-view").hidden = !!r || results != null;
    $("result-view").hidden = !!r || results == null;
    $("detail-view").hidden = !r;
    if (!r) return;
    const s = WaitStore.summary(r.id);
    $("d-name").textContent = r.name;
    $("d-menu").textContent = r.menu;

    const w = $("d-wait");
    w.className = `wait ${tier(s.average)}`;
    if (s.error) {
      w.textContent = "정보를 불러올 수 없음";
      $("d-meta").textContent = "잠시 후 다시 시도해 주세요.";
      return;
    }
    if (s.average != null) {
      w.innerHTML = `${s.average}분<small>${s.count}명 참여</small>`;
    } else if (s.count === 1) {
      w.innerHTML = "입력 참여 중<small>1명 참여 · 2명 이상이면 평균을 표시합니다</small>";
    } else {
      w.textContent = "정보 수집 중";
    }
    $("d-meta").textContent = s.updatedAt
      ? `최종 업데이트 ${ago(s.updatedAt)} · 입력은 30분간 유효`
      : "아직 유효한 입력이 없습니다.";
  }

  // 현재 목록만 다시 그린다. 식당 목록은 재검색할 때만 바뀐다.
  function refresh() {
    renderMarkers();
    renderList();
    renderResults();
    renderDetail();
  }

  function select(id) {
    selectedId = id;
    const r = known.get(id);
    if (r) map.panTo(LatLng(r)); // panTo는 드래그·확대가 아니므로 재검색 버튼이 뜨지 않는다
    $("msg").textContent = "";
    $("msg").className = "msg";
    refresh();
  }

  // ---------- 입력 UI ----------
  const input = $("in-min");
  const clamp = (v) => Math.min(WaitStore.MAX, Math.max(WaitStore.MIN, v));
  $("btn-minus").onclick = () => { input.value = clamp((Number(input.value) || 0) - WaitStore.STEP); };
  $("btn-plus").onclick = () => { input.value = clamp((Number(input.value) || 0) + WaitStore.STEP); };
  $("quick").innerHTML = [0, 10, 15, 30, 45, 60, 90, 120]
    .map((m) => `<button type="button" data-m="${m}">${m}분</button>`).join("");
  $("quick").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-m]");
    if (b) input.value = b.dataset.m;
  });

  $("entry-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const msg = $("msg");
    btn.disabled = true;
    msg.textContent = "입력하는 중…";
    msg.className = "msg";
    const res = await WaitStore.submit(selectedId, input.value);
    btn.disabled = false;
    if (!res.ok) {
      msg.textContent = res.error;
      msg.className = "msg err";
      return;
    }
    msg.textContent = "입력되었습니다. 같은 식당에 다시 입력하면 기존 값이 갱신됩니다.";
    msg.className = "msg ok";
    refresh();
  });

  $("list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) select(b.dataset.id);
  });
  $("btn-back").onclick = () => { selectedId = null; refresh(); };
  $("btn-search").onclick = search;

  $("btn-locate").onclick = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => { moveMap({ lat: p.coords.latitude, lng: p.coords.longitude }, DEFAULT_LEVEL); search(); },
      () => alert("위치 권한을 허용하면 내 주변 식당을 볼 수 있습니다.")
    );
  };

  // 사용자가 지도를 끌거나 확대·축소하면 재검색 버튼을 띄운다
  const offerSearch = () => { $("btn-search").hidden = false; };
  kakao.maps.event.addListener(map, "dragend", offerSearch);
  kakao.maps.event.addListener(map, "zoom_changed", () => {
    if (Date.now() - movedByCode > 800) offerSearch();
  });

  // 지도 영역 크기가 바뀌면(화면 회전, 창 크기 변경) 카카오 지도에 알려 다시 그린다
  new ResizeObserver(() => map.relayout()).observe($("map"));

  // 레이아웃이 확정된 뒤의 화면 영역으로 첫 검색
  const start = () => { map.relayout(); map.setCenter(LatLng(DEFAULT_CENTER)); search(); };
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
  // 다른 사람의 입력과 30분 만료를 반영하도록 15초마다 집계를 다시 받는다(탭이 보일 때만)
  setInterval(async () => {
    if (document.hidden || !visible.length) return;
    await WaitStore.load(visible.map((r) => r.id));
    refresh();
  }, 15000);
})();
