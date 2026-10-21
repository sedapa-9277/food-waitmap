// 식당 정보 조회
// - config.js에 KAKAO_JS_KEY가 있으면 카카오 장소 검색(음식점 카테고리 FD6), 없으면 OpenStreetMap Nominatim
// - 지도 그리기(Leaflet)와는 별개이며, 어느 쪽이든 같은 모양의 식당 객체를 돌려준다
//   { id, name, menu, address, lat, lng }
// - 카카오 JavaScript 키는 카카오 개발자 콘솔에 등록한 도메인에서만 동작하므로 브라우저 코드에 두어도 된다
const Places = (() => {
  const KAKAO_KEY = (WAITMAP_CONFIG.KAKAO_JS_KEY || "").trim();
  const TIMEOUT = 10000;

  const withTimeout = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT))
  ]);

  // ---------- 카카오 ----------
  let kakaoReady = null;
  function loadKakao() {
    if (!kakaoReady) {
      kakaoReady = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(KAKAO_KEY)}&libraries=services&autoload=false`;
        s.onload = () => kakao.maps.load(() => resolve(new kakao.maps.services.Places()));
        s.onerror = () => reject(new Error("카카오 SDK를 불러오지 못했습니다"));
        document.head.appendChild(s);
      }).catch((err) => { kakaoReady = null; throw err; }); // 실패하면 다음 호출 때 다시 시도
    }
    return kakaoReady;
  }

  // 카카오 검색 한 페이지(최대 15곳). 결과 없음은 빈 배열, 오류는 예외
  function kakaoPage(places, method, args, options) {
    return withTimeout(new Promise((resolve, reject) => {
      places[method](...args, (data, status, pagination) => {
        const S = kakao.maps.services.Status;
        if (status === S.OK) resolve({ data, hasNext: pagination.hasNextPage });
        else if (status === S.ZERO_RESULT) resolve({ data: [], hasNext: false });
        else reject(new Error("카카오 장소 검색 실패"));
      }, options);
    }));
  }

  // "음식점 > 한식 > 국밥" -> "한식 · 국밥"
  const kakaoMenu = (category) => {
    const parts = String(category || "").split(">").map((s) => s.trim()).filter(Boolean).slice(1);
    return parts.length ? parts.slice(-2).join(" · ") : "메뉴 정보 없음";
  };

  const fromKakao = (p) => ({
    id: `kakao-${p.id}`,
    name: p.place_name,
    menu: kakaoMenu(p.category_name),
    address: p.road_address_name || p.address_name || "",
    lat: Number(p.y),
    lng: Number(p.x)
  });

  // 중심에서 가까운 순으로 음식점을 가져온다. 화면 모서리까지 닿는 반경(최대 20km)으로, 화면 안 식당이 need개 모이거나 3페이지(45곳)까지
  async function kakaoNearby(center, bounds, need) {
    const places = await loadKakao();
    const radius = Math.min(20000, Math.ceil(distance(center, { lat: bounds.n, lng: bounds.e })));
    const options = {
      location: new kakao.maps.LatLng(center.lat, center.lng),
      radius,
      sort: kakao.maps.services.SortBy.DISTANCE
    };
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const { data, hasNext } = await kakaoPage(places, "categorySearch", ["FD6"], { ...options, page });
      out.push(...data.map(fromKakao));
      if (out.filter((r) => inBounds(r, bounds)).length >= need || !hasNext) break;
    }
    return out;
  }

  // 전국에서 이름으로 음식점 검색(정확도순 15곳). 지도 중심을 기준점으로 넘겨 가까운 지점이 앞에 오게 한다
  async function kakaoByName(q, center) {
    const places = await loadKakao();
    const { data } = await kakaoPage(places, "keywordSearch", [q], {
      category_group_code: "FD6",
      location: new kakao.maps.LatLng(center.lat, center.lng),
      sort: kakao.maps.services.SortBy.ACCURACY
    });
    return data.map(fromKakao);
  }

  // ---------- OpenStreetMap Nominatim (카카오 키가 없을 때) ----------
  const CUISINE = {
    korean: "한식", chinese: "중식", japanese: "일식", sushi: "초밥", italian: "이탈리안", pizza: "피자",
    burger: "버거", chicken: "치킨", fried_chicken: "치킨", noodle: "면요리", ramen: "라멘", seafood: "해산물",
    steak_house: "스테이크", barbecue: "고기구이", bbq: "고기구이", pasta: "파스타", thai: "태국 음식",
    vietnamese: "베트남 음식", indian: "인도 음식", american: "양식", french: "프랑스 음식", sandwich: "샌드위치",
    regional: "향토음식", asian: "아시아 음식", international: "세계 음식", western: "양식", dumpling: "만두"
  };
  const osmMenu = (tags) => {
    const c = tags && tags.cuisine;
    if (!c) return "메뉴 정보 없음";
    return c.split(";").slice(0, 2).map((x) => CUISINE[x.trim()] || x.trim()).join(", ");
  };

  // "명동교자, 29, 명동10길, 명동, 중구, 서울, 04536, 대한민국" -> "서울 중구 명동 명동10길"
  const osmAddress = (full) => String(full || "").split(",").slice(1).map((s) => s.trim())
    .filter((s) => s && !/^\d{5}$/.test(s) && s !== "대한민국")
    .reverse().slice(0, 4).join(" ");

  // OSM 고유 id로 같은 식당의 중복 마커를 막는다
  const fromOsm = (x) => ({
    id: `osm-${x.osm_type}-${x.osm_id}`,
    name: x.name,
    menu: osmMenu(x.extratags),
    address: osmAddress(x.display_name),
    lat: Number(x.lat),
    lng: Number(x.lon)
  });

  // 음식점으로 볼 OSM 분류. 같은 이름의 지하철역·건물 등은 이름 검색 결과에서 뺀다
  const FOOD_TYPES = new Set(["restaurant", "fast_food", "cafe", "food_court", "pub", "bar", "ice_cream", "biergarten"]);

  async function nominatim(params) {
    const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
      format: "jsonv2", limit: "40", extratags: "1", "accept-language": "ko", ...params
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return (await res.json()).filter((x) => x.name && x.lat && x.lon);
    } finally {
      clearTimeout(timer);
    }
  }

  // Nominatim은 한 번에 최대 40곳만 주고 거리순이 아니므로, 범위를 중심 주변 약 1.5km로 좁혀야 가까운 식당이 잡힌다
  async function osmNearby(center, bounds) {
    const s = Math.max(bounds.s, center.lat - 0.0135), n = Math.min(bounds.n, center.lat + 0.0135);
    const w = Math.max(bounds.w, center.lng - 0.017), e = Math.min(bounds.e, center.lng + 0.017);
    const rows = await nominatim({ q: "restaurant", viewbox: `${w},${n},${e},${s}`, bounded: "1" });
    return rows.map(fromOsm);
  }

  // 전국 검색. 지금 보는 지도 영역을 우선 참고(viewbox, bounded=0)해 가까운 지점이 앞에 오게 한다
  async function osmByName(q, center, bounds) {
    const rows = await nominatim({
      q, countrycodes: "kr", bounded: "0", viewbox: `${bounds.w},${bounds.n},${bounds.e},${bounds.s}`
    });
    return rows.filter((x) => x.category === "amenity" && FOOD_TYPES.has(x.type)).map(fromOsm);
  }

  // ---------- 공용 ----------
  function distance(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const inBounds = (r, b) => r.lat >= b.s && r.lat <= b.n && r.lng >= b.w && r.lng <= b.e;

  // 카카오를 쓰다가 실패하면(키·도메인 미등록, SDK 차단, 카카오 오류) 그 요청은 OpenStreetMap으로 대신한다
  let source = KAKAO_KEY ? "kakao" : "osm";
  async function pick(kakaoFn, osmFn) {
    if (KAKAO_KEY) {
      try {
        const rows = await kakaoFn();
        source = "kakao";
        return rows;
      } catch (err) {
        console.warn("카카오 장소 검색 실패, OpenStreetMap으로 대신합니다:", err);
      }
    }
    source = "osm";
    return osmFn();
  }

  return {
    // 마지막 조회에 실제로 쓴 출처: "kakao" | "osm"
    get source() { return source; },
    // 화면 안 후보 식당(정렬·개수 제한은 호출하는 쪽에서)
    nearby: (center, bounds, need) => pick(() => kakaoNearby(center, bounds, need), () => osmNearby(center, bounds)),
    // 이름으로 찾은 음식점
    byName: (q, center, bounds) => pick(() => kakaoByName(q, center), () => osmByName(q, center, bounds))
  };
})();
