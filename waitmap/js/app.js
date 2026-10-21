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

  // 카카오맵 상세 페이지(메뉴·사진). 외부 데이터의 URL을 그대로 쓰지 않고 숫자 id로만 만든다.
  // OSM 식당은 카카오 id가 없으므로 카카오맵에서 이름으로 검색한다
  const placeUrl = (r) => {
    const m = /^kakao-(\d+)$/.exec(r.id);
    return m ? `https://place.map.kakao.com/${m[1]}` : `https://map.kakao.com/?q=${encodeURIComponent(r.name)}`;
  };

  // ---------- 내 위치와 길찾기 ----------
  // 내 위치는 사용자가 "내 위치"를 눌렀거나 이미 위치 권한을 허용한 경우에만 쓴다(식당을 고를 때 갑자기 묻지 않음)
  let myPos = null; // { lat, lng }
  const WALK_M_PER_MIN = 67; // 걸음 약 4km/h
  const DETOUR = 1.3;        // 직선거리 → 실제 걷는 거리 대략 보정

  // 카카오맵 길찾기 URL(https://apis.map.kakao.com/web/guide/#routeurl). 이름의 ,와 /는 경로 구분자라 공백으로 바꾼다
  const linkName = (s) => encodeURIComponent(String(s).replace(/[,/]/g, " ").trim() || "목적지");
  const pt = (name, p) => `${linkName(name)},${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const WALK_MAX_M = 3000;   // 이보다 멀면 도보 대신 카카오맵 기본 길찾기(이동수단은 카카오맵에서 선택)
  // 도착지는 장소 id 대신 이름+좌표로 지정한다(id로 넘기면 상위 장소, 예: "서울특별시청"으로 잡히는 경우가 있음)
  function routeUrl(r) {
    const to = pt(r.name, r);
    if (!myPos) return `https://map.kakao.com/link/to/${to}`; // 출발지는 카카오맵이 정함
    const from = pt("내 위치", myPos);
    return distance(myPos, r) <= WALK_MAX_M
      ? `https://map.kakao.com/link/by/walk/${from}/${to}` // 도보 길찾기
      : `https://map.kakao.com/link/from/${from}/to/${to}`;
  }
  function distInfo(r) {
    if (!myPos) return "";
    const d = distance(myPos, r);
    if (d > WALK_MAX_M) return `내 위치에서 직선거리 ${distText(d)}`;
    const mins = Math.max(1, Math.round((d * DETOUR) / WALK_M_PER_MIN));
    return `내 위치에서 ${distText(d)} · 걸어서 약 ${mins}분 (직선거리 기준)`;
  }

  let meMarker = null;
  function setMyPos(p) {
    myPos = p;
    if (!meMarker) {
      const el = document.createElement("div");
      el.className = "me-dot";
      el.title = "내 위치";
      meMarker = new kakao.maps.CustomOverlay({ position: LatLng(p), content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: 5 });
      meMarker.setMap(map);
    } else {
      meMarker.setPosition(LatLng(p));
    }
    renderDetail();
  }
  const fromCoords = (c) => ({ lat: c.latitude, lng: c.longitude });

  // 이미 위치 권한을 허용한 브라우저면 조용히 내 위치를 받아 둔다(권한 창을 띄우지 않음)
  if (navigator.geolocation && navigator.permissions) {
    navigator.permissions.query({ name: "geolocation" }).then((st) => {
      if (st.state === "granted") {
        navigator.geolocation.getCurrentPosition((p) => setMyPos(fromCoords(p.coords)), () => {}, { maximumAge: 60000, timeout: 10000 });
      }
    }).catch(() => {});
  }

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

  // ---------- 카테고리 메뉴 (전체, 한식, 중식 …) ----------
  // 마지막 선택은 이 브라우저에만 기억한다(저장이 막힌 환경에서도 동작)
  const K_CAT = "waitmap_category";
  let category = "all";
  try {
    const saved = localStorage.getItem(K_CAT);
    if (Places.categories.some((c) => c.key === saved)) category = saved;
  } catch { /* 저장소 사용 불가 */ }
  const catLabel = () => Places.categories.find((c) => c.key === category).label;

  function renderCats() {
    $("cats").innerHTML = Places.categories.map((c) =>
      `<button type="button" role="radio" data-cat="${c.key}" aria-checked="${c.key === category}">${esc(c.label)}</button>`).join("");
  }
  renderCats();
  $("cats").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cat]");
    if (!b || b.dataset.cat === category) return;
    category = b.dataset.cat;
    try { localStorage.setItem(K_CAT, category); } catch { /* ignore */ }
    renderCats();
    b.scrollIntoView({ block: "nearest", inline: "nearest" });
    results = null;    // 검색 결과를 보고 있었다면 주변 식당 목록으로
    selectedId = null;
    search();
  });

  // ---------- 식당 조회 (js/places.js: 카카오 또는 OpenStreetMap) ----------
  async function fetchRestaurants() {
    const { center, bounds } = view();
    const rows = await Places.nearby(center, bounds, MAX_MARKERS, category);
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
  let resultsHere = false; // results가 이름 검색이 아니라 "이 위치의 식당"(겹친 마커 묶음) 목록인지
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
    resultsHere = false;
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
    if (r) resultsHere ? select(r.id) : goToResult(r); // 묶음 목록의 식당은 이미 지도에 있으므로 바로 선택
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
  // more: 겹쳐서 숨긴 마커 수("+N" 표시)
  function pinHtml(r, s, more = 0) {
    const sel = r.id === selectedId ? " sel" : "";
    const badge = more ? `<em class="pin-more" title="겹친 식당 ${more}곳 더 보기">+${more}</em>` : "";
    return `<div class="pin ${tier(s.average)}${sel}"><b class="pin-name">${esc(r.name)}</b><span>${pinText(s)}</span>${badge}</div>`;
  }

  // 대표 마커 우선순위: 선택한 식당 > 평균 있음 > 1명 참여 > 수집 중 (같으면 가까운 순 = visible 순서)
  const rank = (r) => {
    if (r.id === selectedId) return 0;
    const s = WaitStore.summary(r.id);
    return s.average != null ? 1 : s.count === 1 ? 2 : 3;
  };
  const Z = [1000, 30, 20, 10];

  function renderMarkers() {
    const ids = new Set(visible.map((r) => r.id));
    for (const [id, m] of markers) {
      if (!ids.has(id)) { m.setMap(null); markers.delete(id); }
    }
    for (const r of visible) {
      if (markers.has(r.id)) continue;
      const el = document.createElement("div");
      el.className = "pin-wrap";
      el.title = r.name;
      el.addEventListener("click", (e) => (e.target.closest(".pin-more") ? openGroup(r.id) : select(r.id)));
      el.addEventListener("mouseenter", () => markers.get(r.id)?.setZIndex(2000));
      el.addEventListener("mouseleave", () => markers.get(r.id)?.setZIndex(Z[rank(r)]));
      // 기준점은 좌상단(0,0), 가운데·아래 맞춤은 CSS(.pin transform)로 한다. "+N"으로 폭이 바뀌어도 위치가 어긋나지 않게
      const m = new kakao.maps.CustomOverlay({ position: LatLng(r), content: el, xAnchor: 0, yAnchor: 0, clickable: true });
      m.setMap(map);
      markers.set(r.id, m);
    }
    layoutMarkers();
  }

  // ---------- 마커 겹침 정리 ----------
  // 화면 픽셀 기준으로 말풍선이 겹치면 우선순위가 높은 마커 하나만 남기고 "+N"을 붙인다.
  // 확대·축소하면 화면상 거리가 바뀌므로 지도가 멈출 때(idle)마다 다시 계산한다.
  const groups = new Map(); // 대표 식당 id -> 묶인 식당 id 목록(대표 포함)
  const GAP = 2;            // 말풍선 사이 최소 여백(px)

  function layoutMarkers() {
    const proj = map.getProjection();
    // 1) 모두 기본 모양으로 그린 뒤 크기와 화면 좌표를 잰다
    const items = visible.map((r, i) => {
      const m = markers.get(r.id), el = m.getContent(), s = WaitStore.summary(r.id);
      const html = pinHtml(r, s);
      if (el.innerHTML !== html) el.innerHTML = html;
      el.style.display = "";
      const pin = el.firstElementChild;
      const p = proj.containerPointFromCoords(LatLng(r));
      return { r, s, m, el, i, rank: rank(r), x: p.x, y: p.y, w: pin.offsetWidth, h: pin.offsetHeight + 6 }; // 6 = 말풍선을 좌표 위로 띄운 거리(.pin transform)
    });
    const boxOf = (it, w) => ({ l: it.x - w / 2, r: it.x + w / 2, t: it.y - it.h, b: it.y });
    const hit = (a, b) => a.l < b.r + GAP && b.l < a.r + GAP && a.t < b.b + GAP && b.t < a.b + GAP;
    const order = [...items].sort((a, b) => a.rank - b.rank || a.i - b.i);

    // 2) 우선순위 순으로 자리를 잡고, 이미 잡힌 말풍선과 겹치면 그 묶음에 넣는다.
    //    "+N"이 붙으면 말풍선이 넓어지므로, 붙인 뒤의 폭으로 다시 계산한다(대개 1~2번이면 안정)
    const wide = new Map(); // 식당 id -> "+N"을 붙인 폭
    let leaders;
    for (let pass = 0; pass < 4; pass++) {
      leaders = [];
      groups.clear();
      for (const it of order) {
        const box = boxOf(it, wide.get(it.r.id) || it.w);
        const lead = leaders.find((L) => hit(L.box, box));
        if (lead) groups.get(lead.it.r.id).push(it.r.id);
        else { leaders.push({ it, box }); groups.set(it.r.id, [it.r.id]); }
      }
      let changed = false;
      for (const { it } of leaders) {
        const more = groups.get(it.r.id).length - 1;
        it.el.innerHTML = pinHtml(it.r, it.s, more);
        const w = it.el.firstElementChild.offsetWidth;
        if (more && w > (wide.get(it.r.id) || it.w)) { wide.set(it.r.id, w); changed = true; }
      }
      if (!changed) break;
    }

    // 3) 묶인 마커는 숨기고, 정보가 있는 마커가 위로 오게 한다
    const shown = new Set(leaders.map(({ it }) => it.r.id));
    for (const it of items) {
      it.el.style.display = shown.has(it.r.id) ? "" : "none";
      if (shown.has(it.r.id)) it.m.setZIndex(Z[it.rank]);
    }
  }

  // "+N"을 누르면: 흩어져 있으면 그 지점으로 확대해 펼치고, 같은 건물처럼 거의 같은 자리면 목록으로 보여 준다
  function openGroup(id) {
    const list = (groups.get(id) || []).map((x) => known.get(x)).filter(Boolean);
    if (list.length < 2) return select(id);
    const c = { lat: list.reduce((a, r) => a + r.lat, 0) / list.length, lng: list.reduce((a, r) => a + r.lng, 0) / list.length };
    const spread = Math.max(...list.map((r) => distance(c, r)));
    if (spread > 15 && map.getLevel() > 1) {
      movedByCode = Date.now();
      map.setLevel(map.getLevel() - 1, { anchor: LatLng(c) });
      return;
    }
    const { center } = view();
    results = list.map((r) => ({ ...r, dist: distance(center, r) }));
    resultsHere = true;
    resultMsg = `이 위치의 식당 ${list.length}곳`;
    selectedId = null;
    refresh();
  }

  function renderList() {
    $("count-label").textContent = `${category === "all" ? "식당" : catLabel()} ${visible.length}곳`;
    const ul = $("list");
    if (!visible.length) {
      ul.innerHTML = `<li class="empty">이 지역에서 ${category === "all" ? "식당" : esc(catLabel())}을(를) 찾지 못했습니다. 지도를 움직이거나 다른 종류를 골라 보세요.</li>`;
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
    $("d-place").href = placeUrl(r);
    $("d-place").textContent = r.id.startsWith("kakao-") ? "카카오맵에서 메뉴·사진 보기 ↗" : "카카오맵에서 이 식당 찾아보기 ↗";
    $("d-route").href = routeUrl(r);
    $("d-route").title = myPos ? "내 위치에서 걸어가는 길찾기" : "카카오맵에서 길찾기(출발지는 카카오맵에서 지정)";
    const di = distInfo(r);
    $("d-dist").hidden = !di;
    $("d-dist").textContent = di;

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
      (p) => { const me = fromCoords(p.coords); setMyPos(me); moveMap(me, DEFAULT_LEVEL); search(); },
      () => alert("위치 권한을 허용하면 내 주변 식당을 볼 수 있습니다.")
    );
  };

  // 사용자가 지도를 끌거나 확대·축소하면 재검색 버튼을 띄운다
  const offerSearch = () => { $("btn-search").hidden = false; };
  kakao.maps.event.addListener(map, "dragend", offerSearch);
  kakao.maps.event.addListener(map, "idle", () => { if (visible.length) layoutMarkers(); });
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
