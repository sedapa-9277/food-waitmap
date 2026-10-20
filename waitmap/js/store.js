// 대기시간 저장소 (Supabase RPC)
// 정책은 서버(DB 함수)에서 지킵니다: 입력별 30분 만료(서버 시각), 익명 ID당 식당별 1개 입력,
// 2명 이상일 때만 평균(1분 단위 반올림), 0~300분·5분 단위 검증, 익명 ID·IP 기준 요청 제한.
// 화면은 서버가 돌려준 집계를 캐시해 두고 그립니다.
const WaitStore = (() => {
  const MIN = 0, MAX = 300, STEP = 5;
  const K_UID = "waitmap_uid";
  const { SUPABASE_URL, SUPABASE_KEY } = WAITMAP_CONFIG;
  const EMPTY = { average: null, count: 0, updatedAt: null };

  const cache = new Map(); // 식당 id -> { average, count, updatedAt }
  let failed = false;      // 마지막 조회가 실패했는지

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const newUuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  // 브라우저별 익명 ID (개인 정보 없음)
  let memoryUid = null;
  const uid = () => {
    let id = null;
    try { id = localStorage.getItem(K_UID); } catch { /* 저장 불가 환경 */ }
    if (!id || !UUID_RE.test(id)) {
      id = memoryUid || newUuid();
      memoryUid = id;
      try { localStorage.setItem(K_UID, id); } catch { /* ignore */ }
    }
    return id;
  };

  async function rpc(name, body) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.message) || `HTTP ${res.status}`);
      err.code = data && data.message;
      throw err;
    }
    return data;
  }

  const put = (rows) => {
    for (const r of rows || []) {
      cache.set(r.place_id, {
        average: r.average_minutes,
        count: r.participant_count,
        updatedAt: r.updated_at ? Date.parse(r.updated_at) : null
      });
    }
  };

  // 화면에 있는 식당들의 집계를 한 번에 가져온다(최대 50곳)
  async function load(ids) {
    if (!ids.length) return;
    try {
      const rows = await rpc("get_wait_summaries", { p_place_ids: ids.slice(0, 50) });
      ids.forEach((id) => cache.set(id, EMPTY)); // 응답에 없는 식당 = 유효 입력 0개
      put(rows);
      failed = false;
    } catch (err) {
      console.error(err);
      failed = true;
    }
  }

  const summary = (id) => (failed && !cache.has(id) ? { ...EMPTY, error: true } : cache.get(id) || EMPTY);
  const hasError = () => failed;

  const MESSAGES = {
    invalid_minutes: `${MIN}~${MAX}분 사이, ${STEP}분 단위로 입력해 주세요.`,
    invalid_place: "식당 정보가 올바르지 않습니다.",
    invalid_user: "잠시 후 다시 시도해 주세요.",
    rate_limited: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."
  };

  // 반환: { ok, error? }
  async function submit(id, minutes) {
    const m = Number(minutes);
    if (!Number.isInteger(m) || m < MIN || m > MAX || m % STEP !== 0) {
      return { ok: false, error: MESSAGES.invalid_minutes }; // 빠른 안내용. 최종 검증은 서버
    }
    try {
      const rows = await rpc("submit_wait", { p_place_id: id, p_anon_id: uid(), p_minutes: m });
      put(rows);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: MESSAGES[err.code] || "입력하지 못했습니다. 네트워크를 확인해 주세요." };
    }
  }

  return { MIN, MAX, STEP, load, summary, submit, hasError };
})();
