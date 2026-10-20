(() => {
  const MAX_MARKERS = 20;
  const DEFAULT_CENTER = [37.5665, 126.9780]; // 서울시청
  const DEFAULT_ZOOM = 17;
  const MIN_SEARCH_ZOOM = 13; // 너무 넓으면 결과가 의미 없으므로 확대를 요청
  const $ = (id) => document.getElementById(id);

  const markers = new Map(); // 식당 id -> L.Marker
  const known = new Map();   // 식당 id -> 식당 정보
  let visible = [];
  let selectedId = null;
  let quiet = false;         // 코드로 지도를 움직였을 때 재검색 버튼을 띄우지 않음
  let searchOnMove = false;  // 내 위치 이동 뒤에는 바로 검색

  const tier = (avg) => (avg == null ? "none" : avg <= 20 ? "low" : avg <= 45 ? "mid" : "high");
  const pinText = (s) => (s.error ? "-" : s.average != null ? `${s.average}분` : s.count === 1 ? "참여 중" : "수집 중");
  const ago = (t) => {
    const m = Math.floor((Date.now() - t) / 60000);
    return m < 1 ? "방금 전" : `${m}분 전`;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- 지도 (Leaflet + OpenStreetMap, 키 불필요) ----------
  const map = L.map("map").setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자'
  }).addTo(map);

  // ---------- 식당 조회 (OpenStreetMap Nominatim) ----------
  const CUISINE = {
    korean: "한식", chinese: "중식", japanese: "일식", sushi: "초밥", italian: "이탈리안", pizza: "피자",
    burger: "버거", chicken: "치킨", fried_chicken: "치킨", noodle: "면요리", ramen: "라멘", seafood: "해산물",
    steak_house: "스테이크", barbecue: "고기구이", bbq: "고기구이", pasta: "파스타", thai: "태국 음식",
    vietnamese: "베트남 음식", indian: "인도 음식", american: "양식", french: "프랑스 음식", sandwich: "샌드위치",
    regional: "향토음식", asian: "아시아 음식", international: "세계 음식", western: "양식", dumpling: "만두"
  };
  const menuText = (tags) => {
    const c = tags && tags.cuisine;
    if (!c) return "메뉴 정보 없음";
    return c.split(";").slice(0, 2).map((x) => CUISINE[x.trim()] || x.trim()).join(", ");
  };

  // 조회 범위: 현재 화면과 "중심 주변 약 1.5km" 중 작은 쪽.
  // Nominatim은 한 번에 최대 40곳만 주고 거리순이 아니므로, 범위를 중심 가까이로 좁혀야 가까운 식당이 잡힌다.
  function searchBox() {
    const b = map.getBounds();
    const c = map.getCenter();
    return {
      s: Math.max(b.getSouth(), c.lat - 0.0135), n: Math.min(b.getNorth(), c.lat + 0.0135),
      w: Math.max(b.getWest(), c.lng - 0.017), e: Math.min(b.getEast(), c.lng + 0.017)
    };
  }

  async function fetchRestaurants() {
    const c = map.getCenter();
    const b = map.getBounds();
    const { s, n, w, e } = searchBox();
    const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
      q: "restaurant",
      viewbox: `${w},${n},${e},${s}`,
      bounded: "1",
      format: "jsonv2",
      limit: "40",
      extratags: "1",
      "accept-language": "ko"
    });

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    let rows;
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      rows = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const seen = new Set();
    const list = rows
      .filter((x) => x.name && x.lat && x.lon)
      .map(toRestaurant)
      .filter((r) => b.contains([r.lat, r.lng]) && !seen.has(r.id) && seen.add(r.id))
      .sort((x, y) => c.distanceTo([x.lat, x.lng]) - c.distanceTo([y.lat, y.lng]));
    // 이름 검색으로 고른 식당은 주변 검색 결과에 없더라도 화면 안에 있으면 맨 앞에 넣는다
    if (pinned && b.contains([pinned.lat, pinned.lng]) && !seen.has(pinned.id)) list.unshift(pinned);
    return list.slice(0, MAX_MARKERS).map((r) => { known.set(r.id, r); return r; });
  }

  // Nominatim 결과 한 건 -> 식당. OSM 고유 id로 같은 식당의 중복 마커를 막는다
  function toRestaurant(x) {
    return {
      id: `osm-${x.osm_type}-${x.osm_id}`,
      name: x.name,
      menu: menuText(x.extratags),
      address: shortAddress(x.display_name),
      lat: Number(x.lat),
      lng: Number(x.lon)
    };
  }

  // "명동교자, 29, 명동10길, 명동, 중구, 서울, 04536, 대한민국" -> "서울 중구 명동 명동10길"
  function shortAddress(full) {
    return String(full || "").split(",").slice(1).map((s) => s.trim())
      .filter((s) => s && !/^\d{5}$/.test(s) && s !== "대한민국")
      .reverse().slice(0, 4).join(" ");
  }

  // ---------- 식당 이름 검색 ----------
  // 음식점으로 볼 OSM 분류. 같은 이름의 지하철역·건물 등은 결과에서 뺀다
  const FOOD_TYPES = new Set(["restaurant", "fast_food", "cafe", "food_court", "pub", "bar", "ice_cream", "biergarten"]);
  const MAX_RESULTS = 15;
  let pinned = null;     // 이름 검색에서 고른 식당
  let results = null;    // 이름 검색 결과 목록(null이면 주변 식당 목록을 보여 줌)
  let resultMsg = "";

  async function searchByName(q) {
    const c = map.getCenter();
    const b = map.getBounds();
    // 전국 검색. 지금 보는 지도 영역을 우선 참고(viewbox, bounded=0)해 가까운 지점이 앞에 오게 한다
    const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
      q,
      countrycodes: "kr",
      viewbox: `${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`,
      bounded: "0",
      format: "jsonv2",
      limit: "40",
      extratags: "1",
      "accept-language": "ko"
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rows = await res.json();
      const seen = new Set();
      return rows
        .filter((x) => x.name && x.lat && x.lon && x.category === "amenity" && FOOD_TYPES.has(x.type))
        .map(toRestaurant)
        .filter((r) => !seen.has(r.id) && seen.add(r.id))
        .map((r) => ({ ...r, dist: c.distanceTo([r.lat, r.lng]) }))
        .sort((x, y) => x.dist - y.dist) // 같은 이름의 지점이 여럿이면 가까운 곳부터
        .slice(0, MAX_RESULTS);
    } finally {
      clearTimeout(timer);
    }
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

  // 검색 결과에서 식당을 고르면 그 위치로 이동하고, 주변 식당과 함께 다시 불러온 뒤 상세를 연다
  function goToResult(r) {
    const { dist, ...place } = r;
    pinned = place;
    known.set(place.id, place);
    selectedId = place.id;
    quiet = true; // 애니메이션 없는 setView는 moveend를 바로 발생시키므로 재검색 버튼이 뜨지 않는다
    map.setView([place.lat, place.lng], Math.max(map.getZoom(), DEFAULT_ZOOM), { animate: false });
    quiet = false;
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
    if (map.getZoom() < MIN_SEARCH_ZOOM) {
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
  function pinIcon(r, s) {
    const sel = r.id === selectedId ? " sel" : "";
    return L.divIcon({
      className: "",
      iconSize: [0, 0],
      html: `<div class="pin ${tier(s.average)}${sel}"><b class="pin-name">${esc(r.name)}</b><span>${pinText(s)}</span></div>`
    });
  }

  function renderMarkers() {
    const ids = new Set(visible.map((r) => r.id));
    for (const [id, m] of markers) {
      if (!ids.has(id)) { map.removeLayer(m); markers.delete(id); }
    }
    for (const r of visible) {
      const icon = pinIcon(r, WaitStore.summary(r.id));
      let m = markers.get(r.id);
      if (!m) {
        m = L.marker([r.lat, r.lng], { icon, title: r.name }).addTo(map);
        m.on("click", () => select(r.id));
        markers.set(r.id, m);
      } else {
        m.setIcon(icon);
      }
      m.setZIndexOffset(r.id === selectedId ? 1000 : 0); // 선택한 식당을 맨 위로
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
    if (r) { quiet = true; map.panTo([r.lat, r.lng]); }
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
      (p) => { searchOnMove = true; map.setView([p.coords.latitude, p.coords.longitude], DEFAULT_ZOOM); },
      () => alert("위치 권한을 허용하면 내 주변 식당을 볼 수 있습니다.")
    );
  };

  // 사용자가 지도를 움직이면 재검색 버튼을 띄운다
  map.on("moveend", () => {
    if (searchOnMove) { searchOnMove = false; search(); return; }
    if (quiet) { quiet = false; return; }
    $("btn-search").hidden = false;
  });

  // 지도 영역 크기가 바뀌면(화면 회전, 창 크기 변경) Leaflet에 알려 마커 위치를 맞춘다
  new ResizeObserver(() => map.invalidateSize()).observe($("map"));

  // 레이아웃이 확정된 뒤의 화면 영역으로 첫 검색
  window.addEventListener("load", () => { map.invalidateSize(); search(); });
  // 다른 사람의 입력과 30분 만료를 반영하도록 15초마다 집계를 다시 받는다(탭이 보일 때만)
  setInterval(async () => {
    if (document.hidden || !visible.length) return;
    await WaitStore.load(visible.map((r) => r.id));
    refresh();
  }, 15000);
})();
