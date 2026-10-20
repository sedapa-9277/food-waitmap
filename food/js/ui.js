/* 맛집 대기지도 - 퍼블리싱용 UI 스크립트
   - 지도: Leaflet + OpenStreetMap(무료, 키 불필요). 전국 어디로든 이동
   - 식당·대기시간: js/data.js가 지도 위치로 만드는 가상 데이터. 서버 연동 없음
   - 상태 확인용: index.html?state=empty (식당 없음), ?state=error (조회 실패) */
(() => {
  const MAX = 20;          // 지도에 표시할 최대 식당 수
  const TTL = 30;          // 입력 유효 시간(분)
  const MIN = 0, LIMIT = 300, STEP = 5;
  const MIN_ZOOM = 14;     // 이보다 넓게 보면 재검색 대신 확대 안내
  const START = { lat: 37.5665, lng: 126.9780, zoom: 16 }; // 서울시청

  const $ = (id) => document.getElementById(id);
  const sheet = $("sheet");
  const state = new URLSearchParams(location.search).get("state"); // empty | error

  let visible = [];
  let selectedId = null;
  const known = new Map(); // 식당 id -> 식당
  const mine = {};         // 내가 입력한 값 { 식당id: 분 }
  const markers = new Map();
  let quiet = false;       // 코드로 지도를 옮길 때는 재검색 버튼을 띄우지 않음
  let searchOnMove = false;

  // ---------- 지도 ----------
  const map = L.map("map-canvas", { zoomControl: false, minZoom: 7, maxZoom: 19 })
    .setView([START.lat, START.lng], START.zoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  new ResizeObserver(() => map.invalidateSize()).observe($("map-canvas"));

  function moveTo(lat, lng, zoom) {
    searchOnMove = true;
    map.setView([lat, lng], zoom ?? map.getZoom());
  }

  map.on("moveend", () => {
    if (searchOnMove) { searchOnMove = false; search(); return; }
    if (quiet) { quiet = false; return; }
    $("btn-research").hidden = false;
  });

  // ---------- 집계 (화면 표시용) ----------
  function summary(r) {
    const list = r.entries.filter((e) => e.ago < TTL).map((e) => ({ ...e }));
    if (mine[r.id] != null) list.push({ min: mine[r.id], ago: 0 });
    const count = list.length;
    const avg = count >= 2 ? Math.round(list.reduce((s, e) => s + e.min, 0) / count) : null;
    const updated = count ? Math.min(...list.map((e) => e.ago)) : null;
    return { count, avg, updated };
  }
  const level = (s) => (s.avg == null ? "none" : s.avg <= 20 ? "low" : s.avg <= 45 ? "mid" : "high");
  const label = (s) => (s.avg != null ? `${s.avg}분` : s.count === 1 ? "참여 중" : "수집 중");
  const ago = (m) => (m < 1 ? "방금 전" : `${m}분 전`);
  const fmt = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}` : `${m}분`);

  // ---------- 조회 (가상) ----------
  // 화면 안의 식당을 지도 중심에서 가까운 순으로 최대 20개
  function search() {
    $("btn-research").hidden = true;
    if (state === "error") return renderError();
    if (state === "empty") { visible = []; return render(); }
    if (map.getZoom() < MIN_ZOOM) { visible = []; render(); return renderZoomHint(); }

    const b = map.getBounds();
    const c = map.getCenter();
    visible = DummyData.inBounds(b.getSouth(), b.getWest(), b.getNorth(), b.getEast())
      .map((r) => ({ r, d: c.distanceTo([r.lat, r.lng]) }))
      .sort((a, z) => a.d - z.d)
      .slice(0, MAX)
      .map(({ r }) => {
        if (!known.has(r.id)) known.set(r.id, r); // 같은 식당은 같은 객체(입력 유지)
        return known.get(r.id);
      });
    render();
  }

  // ---------- 그리기 ----------
  function markerIcon(r) {
    const s = summary(r);
    return L.divIcon({
      className: "marker-wrap",
      iconSize: [0, 0],
      html: `<button type="button" class="marker is-${level(s)}${r.id === selectedId ? " is-active" : ""}" aria-label="${r.name} ${label(s)}">
        <span class="marker__name">${r.name}</span><span class="marker__wait">${label(s)}</span>
      </button>`
    });
  }

  function renderMarkers() {
    const ids = new Set(visible.map((r) => r.id));
    for (const [id, m] of markers) {
      if (!ids.has(id)) { map.removeLayer(m); markers.delete(id); }
    }
    for (const r of visible) {
      let m = markers.get(r.id);
      if (!m) {
        m = L.marker([r.lat, r.lng], { icon: markerIcon(r), keyboard: false }).addTo(map);
        m.on("click", () => select(r.id));
        markers.set(r.id, m);
      } else {
        m.setIcon(markerIcon(r));
      }
      m.setZIndexOffset(r.id === selectedId ? 1000 : 0);
    }
  }

  function renderList() {
    $("count").textContent = visible.length;
    if (!visible.length) {
      $("list").innerHTML = `<li class="state">
        <div class="state__icon">🍽️</div>
        <p class="state__title">이 지역에 식당이 없어요</p>
        <p>지도를 움직인 뒤 재검색해 보세요.</p>
      </li>`;
      return;
    }
    $("list").innerHTML = visible.map((r, i) => {
      const s = summary(r);
      const sub = s.avg != null ? `${r.menu} · ${s.count}명 참여` : r.menu;
      return `<li class="list__item"><button type="button" class="list__btn" data-id="${r.id}">
        <span class="list__rank">${i + 1}</span>
        <span class="list__body"><span class="list__name">${r.name}</span><span class="list__sub">${sub}</span></span>
        <span class="badge is-${level(s)}">${label(s)}</span>
      </button></li>`;
    }).join("");
  }

  function renderZoomHint() {
    $("list").innerHTML = `<li class="state">
      <div class="state__icon">🔍</div>
      <p class="state__title">지도를 더 확대해 주세요</p>
      <p>넓은 지역에서는 식당을 표시하지 않아요.</p>
    </li>`;
  }

  function renderError() {
    visible = [];
    renderMarkers();
    $("count").textContent = 0;
    $("list").innerHTML = `<li class="state">
      <div class="state__icon">⚠️</div>
      <p class="state__title">정보를 불러올 수 없음</p>
      <p>잠시 후 다시 시도해 주세요.</p>
      <button type="button" class="btn-line" id="btn-retry">다시 시도</button>
    </li>`;
  }

  function renderDetail() {
    const r = known.get(selectedId);
    $("list-view").hidden = !!r;
    $("detail").hidden = !r;
    sheet.classList.toggle("is-detail", !!r);
    if (!r) return;

    const s = summary(r);
    $("d-name").textContent = r.name;
    $("d-menu").textContent = r.menu;

    const card = $("d-card");
    const v = $("d-wait"), meta = $("d-meta");
    card.className = "wait-card";
    if (s.avg != null) {
      card.classList.add(`is-${level(s)}`);
      v.innerHTML = s.avg >= 60
        ? `${Math.floor(s.avg / 60)}<small>시간</small> ${s.avg % 60 ? `${s.avg % 60}<small>분</small>` : ""}`
        : `${s.avg}<small>분</small>`;
      meta.textContent = `${s.count}명 참여 · 최종 업데이트 ${ago(s.updated)}`;
    } else if (s.count === 1) {
      card.classList.add("is-one");
      v.textContent = "입력 참여 중";
      meta.textContent = `1명 참여 · 1명 더 입력하면 평균이 표시돼요 · ${ago(s.updated)}`;
    } else {
      card.classList.add("is-none");
      v.textContent = "정보 수집 중";
      meta.textContent = "첫 번째로 대기시간을 알려주세요";
    }

    const my = mine[r.id];
    $("entry-title").textContent = my != null ? `내가 입력한 대기시간: ${fmt(my)}` : "현재 예상 대기시간은?";
    $("btn-submit").textContent = my != null ? "입력 수정하기" : "대기시간 입력";
    setValue(my != null ? my : 30);
    $("entry-error").textContent = "";
  }

  function render() {
    renderMarkers();
    renderList();
    renderDetail();
  }

  function select(id) {
    selectedId = id;
    const r = known.get(id);
    if (r) { quiet = true; map.panTo([r.lat, r.lng]); }
    render();
    sheet.scrollTop = 0;
  }

  // ---------- 입력 ----------
  const input = $("in-min");

  function setValue(v) {
    input.value = v;
    input.classList.remove("is-invalid");
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-selected", Number(c.dataset.min) === Number(v)));
  }

  function validate(v) {
    if (input.value.trim() === "" || !Number.isInteger(v)) return "숫자로 입력해 주세요.";
    if (v < MIN || v > LIMIT) return `${MIN}분부터 ${LIMIT}분까지 입력할 수 있어요.`;
    if (v % STEP !== 0) return `${STEP}분 단위로 입력해 주세요.`;
    return "";
  }

  document.querySelectorAll(".stepper__btn").forEach((b) => {
    b.addEventListener("click", () => {
      const cur = Number(input.value) || 0;
      setValue(Math.min(LIMIT, Math.max(MIN, Math.round(cur / STEP) * STEP + Number(b.dataset.step))));
      $("entry-error").textContent = "";
    });
  });
  $("chips").addEventListener("click", (e) => {
    const c = e.target.closest(".chip");
    if (!c) return;
    setValue(Number(c.dataset.min));
    $("entry-error").textContent = "";
  });
  input.addEventListener("input", () => {
    input.classList.toggle("is-invalid", !!validate(Number(input.value)));
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-selected", Number(c.dataset.min) === Number(input.value)));
  });

  $("entry-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = Number(input.value);
    const err = validate(v);
    if (err) {
      $("entry-error").textContent = err;
      input.classList.add("is-invalid");
      input.focus();
      return;
    }
    const edited = mine[selectedId] != null;
    mine[selectedId] = v;
    render();
    toast(edited ? "입력한 대기시간을 수정했어요." : "대기시간을 공유했어요. 고마워요!");
  });

  // ---------- 지역 검색 (시안용: 미리 정한 지역 목록) ----------
  const searchInput = $("search-input");
  $("region-list").innerHTML = DummyData.REGIONS.map((r) => `<option value="${r.name}"></option>`).join("");

  function goRegion(q) {
    const key = q.replace(/\s/g, "");
    if (!key) return;
    const hit = DummyData.REGIONS.find((r) => r.name.replace(/\s/g, "").includes(key) || key.includes(r.name.replace(/\s/g, "")));
    if (!hit) { toast("시안에서는 목록에 있는 지역만 이동할 수 있어요."); return; }
    selectedId = null;
    moveTo(hit.lat, hit.lng, START.zoom);
    searchInput.blur();
    toast(`${hit.name}(으)로 이동했어요.`);
  }
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); goRegion(searchInput.value); }
  });
  searchInput.addEventListener("change", () => goRegion(searchInput.value)); // 자동완성 목록에서 선택

  // ---------- 기타 UI ----------
  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("is-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("is-show"), 2200);
  }

  $("list").addEventListener("click", (e) => {
    const b = e.target.closest(".list__btn");
    if (b) return select(b.dataset.id);
    if (e.target.closest("#btn-retry")) toast("다시 불러오는 중이에요.");
  });
  $("btn-back").addEventListener("click", () => { selectedId = null; render(); });
  $("btn-research").addEventListener("click", search);
  $("btn-zoom-in").addEventListener("click", () => map.zoomIn());
  $("btn-zoom-out").addEventListener("click", () => map.zoomOut());
  $("btn-locate").addEventListener("click", () => {
    if (!navigator.geolocation) return moveTo(START.lat, START.lng, START.zoom);
    navigator.geolocation.getCurrentPosition(
      (p) => { moveTo(p.coords.latitude, p.coords.longitude, START.zoom); toast("현재 위치로 이동했어요."); },
      () => { moveTo(START.lat, START.lng, START.zoom); toast("위치 권한이 없어 기본 위치로 이동했어요."); },
      { timeout: 5000 }
    );
  });

  // ---------- 시작 ----------
  window.addEventListener("load", () => { map.invalidateSize(); search(); });
})();
