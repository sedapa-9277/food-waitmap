/* 퍼블리싱용 가상 데이터
   - 지도를 일정 크기의 격자(약 450m × 450m)로 나누고, 칸마다 좌표로 정해지는 난수로 가상 식당을 만듭니다.
   - 같은 위치에는 언제나 같은 식당이 나오므로, 지도를 옮겼다가 돌아와도 식당이 바뀌지 않습니다.
   - 개발 시 이 파일은 실제 식당 조회 API(예: Google Places)로 교체합니다. */
const DummyData = (() => {
  const CELL_LAT = 0.004;
  const CELL_LNG = 0.005;

  const PREFIX = ["할매", "소담", "미도", "골목", "청춘", "한옥", "온기", "바다", "옛날", "원조", "명가", "시골",
    "우리", "고향", "토박이", "산골", "장터", "이모네", "삼촌네", "달빛", "봄날", "한결", "다온", "정성"];

  // type: 가게 이름에 붙는 말 / menu: 대표 메뉴 / base: 대기시간 기준(분)
  const FOODS = [
    { type: "국밥", menu: "돼지국밥", base: 20 }, { type: "칼국수", menu: "바지락 칼국수", base: 15 },
    { type: "식당", menu: "제육볶음", base: 10 }, { type: "돈카츠", menu: "등심 돈카츠", base: 40 },
    { type: "떡볶이", menu: "즉석 떡볶이", base: 15 }, { type: "라멘", menu: "돈코츠 라멘", base: 35 },
    { type: "횟집", menu: "모둠회", base: 30 }, { type: "갈비", menu: "양념 갈비", base: 50 },
    { type: "순두부", menu: "해물 순두부", base: 15 }, { type: "족발", menu: "냉채족발", base: 25 },
    { type: "브런치", menu: "에그 베네딕트", base: 40 }, { type: "냉면", menu: "물냉면", base: 30 },
    { type: "스시", menu: "오마카세", base: 60 }, { type: "쌀국수", menu: "소고기 쌀국수", base: 15 },
    { type: "부대찌개", menu: "부대찌개", base: 15 }, { type: "곱창", menu: "소곱창", base: 40 },
    { type: "감자탕", menu: "감자탕", base: 15 }, { type: "파스타", menu: "봉골레", base: 25 },
    { type: "닭갈비", menu: "철판 닭갈비", base: 25 }, { type: "만두", menu: "고기만두", base: 10 },
    { type: "포차", menu: "해물파전", base: 20 }, { type: "설렁탕", menu: "설렁탕", base: 10 },
    { type: "중화반점", menu: "짜장면", base: 15 }, { type: "삼겹살", menu: "숙성 삼겹살", base: 35 }
  ];

  // 지역 검색(시안용): 입력한 이름과 맞으면 그 위치로 이동
  const REGIONS = [
    { name: "서울시청", lat: 37.5665, lng: 126.9780 }, { name: "강남역", lat: 37.4979, lng: 127.0276 },
    { name: "홍대입구역", lat: 37.5572, lng: 126.9245 }, { name: "성수역", lat: 37.5446, lng: 127.0557 },
    { name: "잠실역", lat: 37.5133, lng: 127.1001 }, { name: "여의도", lat: 37.5219, lng: 126.9245 },
    { name: "종로", lat: 37.5704, lng: 126.9921 }, { name: "인천", lat: 37.4563, lng: 126.7052 },
    { name: "수원", lat: 37.2636, lng: 127.0286 }, { name: "대전", lat: 36.3504, lng: 127.3845 },
    { name: "대구 동성로", lat: 35.8700, lng: 128.5946 }, { name: "광주", lat: 35.1595, lng: 126.8526 },
    { name: "부산 서면", lat: 35.1579, lng: 129.0599 }, { name: "부산 해운대", lat: 35.1631, lng: 129.1636 },
    { name: "전주 한옥마을", lat: 35.8153, lng: 127.1530 }, { name: "강릉", lat: 37.7519, lng: 128.8761 },
    { name: "속초", lat: 38.2070, lng: 128.5918 }, { name: "제주시", lat: 33.4996, lng: 126.5312 },
    { name: "서귀포", lat: 33.2541, lng: 126.5601 }
  ];

  // 시드가 같으면 같은 수열을 주는 난수(mulberry32)
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const seedOf = (ix, iy) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) >>> 0;

  function cell(ix, iy) {
    const r = rng(seedOf(ix, iy));
    const n = 1 + Math.floor(r() * 4); // 칸마다 1~4곳
    const list = [];
    for (let k = 0; k < n; k++) {
      const food = FOODS[Math.floor(r() * FOODS.length)];
      const prefix = PREFIX[Math.floor(r() * PREFIX.length)];
      // 입력 수: 0~5명. ago(몇 분 전 입력)가 30 이상이면 만료로 처리되어 집계에서 빠짐
      const entries = [];
      const m = Math.floor(r() * 6);
      for (let j = 0; j < m; j++) {
        const min = Math.max(0, Math.round((food.base + (r() - 0.5) * food.base) / 5) * 5);
        entries.push({ min, ago: Math.floor(r() * 40) });
      }
      list.push({
        id: `d${ix}_${iy}_${k}`,
        name: prefix + food.type,
        menu: food.menu,
        lat: (iy + 0.1 + r() * 0.8) * CELL_LAT,
        lng: (ix + 0.1 + r() * 0.8) * CELL_LNG,
        entries
      });
    }
    return list;
  }

  // 영역 안의 가상 식당 전체
  function inBounds(s, w, n, e) {
    const out = [];
    for (let iy = Math.floor(s / CELL_LAT); iy <= Math.floor(n / CELL_LAT); iy++) {
      for (let ix = Math.floor(w / CELL_LNG); ix <= Math.floor(e / CELL_LNG); ix++) {
        for (const r of cell(ix, iy)) {
          if (r.lat >= s && r.lat <= n && r.lng >= w && r.lng <= e) out.push(r);
        }
      }
    }
    return out;
  }

  return { inBounds, REGIONS };
})();
