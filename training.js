/* ============================================================
   TRAINING TAB  ·  "Project Absolute Unit" progression engine
   Depends on: training-data.js (tables), and from index.html:
   $, KEYS, save-independent localStorage, schedulePush(), fanfare(), todayKey()
   State lives in its own localStorage key (pp2_training) and is
   carried by the existing Supabase blob sync automatically.
   ============================================================ */

/* ---------------- state ---------------- */
let T = null;

function defaultTraining() {
  const tracks = {};
  for (const k of Object.keys(TRACKS)) tracks[k] = { level: 1, cleanClears: 0, failStreak: 0, dropInfo: null };
  return {
    stage: 0,                    // 0 = conditioning (2 sessions/week), 1 = full (4/week)
    ritual: {
      level: 1,                  // 1..25
      sinceDate: null,           // easy-streak only counts days AFTER this date (set on level-up)
      history: {},               // { "YYYY-MM-DD": "easy"|"solid"|"grind"|"mvd"|"failed" }
    },
    tracks,
    week: freshWeek(tWeekKey(tToday())),
    weeksSinceDeload: 0,
    lastReconciledDate: null,
    log: [],                     // [{date, session, clears|failed, deload}]
  };
}
function freshWeek(key) {
  return { key, sessionsDone: [], sessionsFailed: [], levelUpsThisWeek: 0, deload: false };
}

function loadT() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEYS.training)); } catch (e) { raw = null; }
  const d = defaultTraining();
  if (raw) {
    T = Object.assign(d, raw);
    T.ritual = Object.assign(d.ritual, raw.ritual || {});
    T.week = Object.assign(freshWeek(d.week.key), raw.week || {});
    const tr = {};
    for (const k of Object.keys(TRACKS)) tr[k] = Object.assign({ level: 1, cleanClears: 0, failStreak: 0, dropInfo: null }, (raw.tracks || {})[k] || {});
    T.tracks = tr;
  } else {
    T = d;
  }
}
function saveT() {
  localStorage.setItem(KEYS.training, JSON.stringify(T));
  if (typeof schedulePush === "function") schedulePush();
}

/* ---------------- date helpers (UTC, consistent with todayKey()) ---------------- */
function tToday() { return todayKey(); }
function tParse(k) { return new Date(k + "T00:00:00Z"); }
function tStr(d) { return d.toISOString().slice(0, 10); }
function tAddDays(k, n) { const d = tParse(k); d.setUTCDate(d.getUTCDate() + n); return tStr(d); }
function tNextDay(k) { return tAddDays(k, 1); }
function tWeekKey(k) {  // Monday of that week, as a stable string key
  const d = tParse(k);
  const back = (d.getUTCDay() + 6) % 7;   // Mon=0 ... Sun=6
  d.setUTCDate(d.getUTCDate() - back);
  return tStr(d);
}
function tWeekDates(weekKey) { const out = []; for (let i = 0; i < 7; i++) out.push(tAddDays(weekKey, i)); return out; }

function weekQuota() { return T.stage === 0 ? WEEK_PLAN_STAGE0.length : WEEK_PLAN_STAGE1.length; }
function weekPlan() { return T.stage === 0 ? WEEK_PLAN_STAGE0 : WEEK_PLAN_STAGE1; }

/* ---------------- reconciliation (the "auto-fail at midnight") ----------------
   The app usually is not running at 00:00, so on every load (and once per
   minute) we walk all fully elapsed days since the last check:
   - ritual day without an entry  -> "failed"
   - Monday crossing              -> close the previous week
   Idempotent: running it twice changes nothing. Must run AFTER a sync pull. */
function reconcileT() {
  const today = tToday();
  if (!T.lastReconciledDate) {
    T.lastReconciledDate = today;
    if (T.week.key !== tWeekKey(today)) T.week = freshWeek(tWeekKey(today));
    saveT();
    return;
  }
  let d = T.lastReconciledDate;
  let changed = false;
  while (d < today) {
    if (!T.ritual.history[d]) { T.ritual.history[d] = "failed"; changed = true; }
    const nd = tNextDay(d);
    if (tWeekKey(nd) !== tWeekKey(d)) { closeWeek(tWeekKey(nd)); changed = true; }
    d = nd;
  }
  if (T.week.key !== tWeekKey(today)) { closeWeek(tWeekKey(today)); changed = true; }  // safety net
  if (T.lastReconciledDate !== today) { T.lastReconciledDate = today; changed = true; }
  pruneHistory();
  if (changed) saveT();
}

function closeWeek(newKey) {
  const done = T.week.sessionsDone.length;
  const quota = weekQuota();
  T.log.push({ week: T.week.key, done, quota, passed: done >= quota, deload: T.week.deload });
  if (T.log.length > 60) T.log = T.log.slice(-60);
  T.weeksSinceDeload = T.week.deload ? 0 : T.weeksSinceDeload + 1;
  T.week = freshWeek(newKey);
}

function pruneHistory() {
  const cutoff = tAddDays(tToday(), -60);
  for (const k of Object.keys(T.ritual.history)) if (k < cutoff) delete T.ritual.history[k];
}

/* ---------------- ritual logic ---------------- */
/* Easy-streak is recomputed from history every time (no drift):
   walk back from the most recent logged day, count consecutive "easy",
   but never past ritual.sinceDate (the last level-up). */
function easyStreak() {
  let d = tToday();
  if (!T.ritual.history[d]) d = tAddDays(d, -1);   // today not logged yet -> start yesterday
  let n = 0;
  while (T.ritual.history[d] === "easy") {
    if (T.ritual.sinceDate && d <= T.ritual.sinceDate) break;
    n++; d = tAddDays(d, -1);
  }
  return n;
}

function markRitual(result) {  // "easy"|"solid"|"grind"|"mvd"|"failed"
  const today = tToday();
  T.ritual.history[today] = result;
  if (result === "easy" && T.ritual.level < 25 && easyStreak() >= 7) {
    T.ritual.level++;
    T.ritual.sinceDate = today;    // streak restarts after a level-up
    if (typeof fanfare === "function") fanfare();
  }
  saveT();
  renderTraining();
}
function clearRitualToday() {
  delete T.ritual.history[tToday()];
  saveT();
  renderTraining();
}

/* ---------------- session logic ---------------- */
let uiSession = null;        // currently expanded session key
let uiClears = {};           // { trackKey: true|false } chosen in the confirm strip

function startSession(key) { uiSession = key; uiClears = {}; renderTraining(); }
function cancelSession() { uiSession = null; uiClears = {}; renderTraining(); }
function setClear(trackKey, val) { uiClears[trackKey] = val; renderTraining(); }

function completeSession() {
  const key = uiSession;
  if (!key) return;
  const s = SESSIONS[key];
  for (const tk of s.tracks) {
    const t = T.tracks[tk];
    if (uiClears[tk]) {
      t.failStreak = 0;
      t.cleanClears = Math.min(2, t.cleanClears + 1);   // 2 = eligible; stays until you click Level up
    } else {
      t.failStreak++;
      if (t.failStreak >= 3) dropLevel(tk);
    }
  }
  if (s.quota) T.week.sessionsDone.push(key);
  T.log.push({ date: tToday(), session: key, clears: Object.assign({}, uiClears), deload: T.week.deload });
  if (T.log.length > 60) T.log = T.log.slice(-60);
  uiSession = null; uiClears = {};
  saveT();
  renderTraining();
}

function failSession() {
  const key = uiSession;
  if (!key) return;
  const s = SESSIONS[key];
  for (const tk of s.tracks) {
    const t = T.tracks[tk];
    t.failStreak++;
    if (t.failStreak >= 3) dropLevel(tk);
  }
  if (s.quota) T.week.sessionsFailed.push(key);
  T.log.push({ date: tToday(), session: key, failed: true });
  if (T.log.length > 60) T.log = T.log.slice(-60);
  uiSession = null; uiClears = {};
  saveT();
  renderTraining();
}

function dropLevel(tk) {
  const t = T.tracks[tk];
  t.level = Math.max(1, t.level - 1);
  t.failStreak = 0;
  t.cleanClears = 0;
  t.dropInfo = { droppedOn: tToday(), reattemptFrom: tAddDays(tToday(), 14) };
}

/* Level-up: only via user click (D6). Eligible = 2 clean clears.
   Hard cap: max 2 level-ups per week; eligibility persists into next week. */
function trackEligible(tk) {
  const t = T.tracks[tk];
  return t.cleanClears >= 2 && t.level < TRACKS[tk].levels.length;
}
function levelUp(tk) {
  if (!trackEligible(tk) || T.week.levelUpsThisWeek >= 2) return;
  const t = T.tracks[tk];
  t.level++;
  t.cleanClears = 0;
  t.dropInfo = null;
  T.week.levelUpsThisWeek++;
  if (typeof fanfare === "function") fanfare();
  saveT();
  renderTraining();
}

function startDeload() {
  T.week.deload = true;
  saveT();
  renderTraining();
}
function toggleStage() {
  T.stage = T.stage === 0 ? 1 : 0;
  saveT();
  renderTraining();
}

/* ---------------- rendering ---------------- */
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function renderTraining() {
  const root = $("trainingRoot");
  if (!root || !T) return;
  const today = tToday();
  const rit = T.ritual;
  const todayResult = rit.history[today] || null;
  const streak = easyStreak();
  const yesterdayFailed = rit.history[tAddDays(today, -1)] === "failed";

  let html = "";

  /* --- Two-Day-Rule warning --- */
  if (yesterdayFailed && !todayResult) {
    html += `<div class="twarn">Yesterday was missed. Never miss two days in a row \u2014 the MVD takes 40 seconds.</div>`;
  }

  /* --- Deload banner --- */
  if (T.weeksSinceDeload >= 8 && !T.week.deload) {
    html += `<div class="tbanner">Week ${T.weeksSinceDeload} since last deload. Time to deload: same exercises, half the sets.
      <button class="ghost tsm" onclick="startDeload()">Start deload week</button></div>`;
  }
  if (T.week.deload) {
    html += `<div class="tbanner tdeload">Deload week \u2014 all sets halved.</div>`;
  }

  /* --- Ritual card --- */
  const lv = RITUAL_LEVELS[rit.level - 1];
  html += `<div class="tcard">
    <div class="thead">
      <div><span class="ttitle">Daily Ritual</span> <span class="tlv">LV ${rit.level}${rit.level >= 25 ? " \u00b7 Maintenance \u2014 permanent" : ""}</span></div>
      ${rit.level < 25 ? `<div class="tstreak">easy-streak ${streak}/7</div>` : ""}
    </div>
    <ul class="tlist">
      ${RITUAL_SLOT_ORDER.map(k => `<li><span class="tslot">${RITUAL_SLOT_NAMES[k]}</span>${esc(lv[k])}</li>`).join("")}
    </ul>`;
  if (!todayResult) {
    html += `<div class="tactions">
      <button class="primary tsm" onclick="markRitual('easy')">Done \u2014 Easy</button>
      <button class="ghost tsm" onclick="markRitual('solid')">Done \u2014 Solid</button>
      <button class="ghost tsm" onclick="markRitual('grind')">Done \u2014 Grind</button>
      <button class="ghost tsm" title="${esc(RITUAL_MVD)}" onclick="markRitual('mvd')">MVD</button>
      <button class="danger tsm" onclick="markRitual('failed')">Failed</button>
    </div>`;
  } else {
    const labels = { easy: "Done \u2014 Easy", solid: "Done \u2014 Solid", grind: "Done \u2014 Grind", mvd: "MVD", failed: "Failed" };
    html += `<div class="tdone-note">Today: <b>${labels[todayResult]}</b> <a href="#" onclick="clearRitualToday();return false;">change</a></div>`;
  }
  html += `</div>`;

  /* --- Week strip --- */
  const dates = tWeekDates(T.week.key);
  const dayNames = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  html += `<div class="tweekstrip">` + dates.map((d, i) => {
    const r = rit.history[d];
    let cls = "tdot-future";
    if (d <= today) {
      if (r === "failed") cls = "tdot-fail";
      else if (r) cls = "tdot-ok";
      else cls = "tdot-open";
    }
    return `<span class="tday${d === today ? " tday-today" : ""}"><span class="tdayname">${dayNames[i]}</span><span class="tdot ${cls}"></span></span>`;
  }).join("") + `</div>`;

  /* --- Main sessions card --- */
  const doneN = T.week.sessionsDone.length;
  const quota = weekQuota();
  const remaining = weekPlan().filter(k => !T.week.sessionsDone.includes(k) && !T.week.sessionsFailed.includes(k));
  const suggested = remaining[0] || null;
  html += `<div class="tcard">
    <div class="thead">
      <div><span class="ttitle">Main Sessions</span> <span class="tlv">${doneN}/${quota} this week</span></div>
      ${suggested ? `<div class="tstreak">Suggested next: ${SESSIONS[suggested].name}</div>` : `<div class="tstreak">Weekly quota done</div>`}
    </div>
    <div class="tchips">`;
  for (const [key, s] of Object.entries(SESSIONS)) {
    if (T.stage === 0 && !weekPlan().includes(key) && s.quota) { /* still selectable in stage 0 */ }
    const done = T.week.sessionsDone.includes(key);
    const failed = T.week.sessionsFailed.includes(key);
    const cls = done ? "tchip-done" : failed ? "tchip-failed" : (key === suggested ? "tchip-next" : "");
    html += `<button class="tchip ${cls}" onclick="startSession('${key}')">${s.name}${done ? " \u2713" : failed ? " \u2717" : ""}${s.quota ? "" : ""}</button>`;
  }
  html += `</div>`;

  /* --- expanded session detail --- */
  if (uiSession) {
    const s = SESSIONS[uiSession];
    const allChosen = s.tracks.every(tk => uiClears[tk] === true || uiClears[tk] === false);
    html += `<div class="tsession">
      <div class="tsession-title">${s.name}${T.week.deload ? " \u00b7 deload: half sets" : ""}</div>`;
    for (const tk of s.tracks) {
      const t = T.tracks[tk];
      const row = TRACKS[tk].levels[t.level - 1];
      const drop = t.dropInfo ? (today >= t.dropInfo.reattemptFrom
        ? `<span class="tbadge tbadge-ok">re-attempt window open</span>`
        : `<span class="tbadge">dropped \u00b7 re-attempt from ${t.dropInfo.reattemptFrom}</span>`) : "";
      const clearState = uiClears[tk];
      html += `<div class="trackrow">
        <div class="trackinfo">
          <span class="trackname">${TRACKS[tk].short} <span class="tlv">LV ${t.level}/${TRACKS[tk].levels.length}</span></span>
          <span class="trackex">${esc(row.ex)} \u2014 <b>${esc(row.target)}</b></span>
          ${t.cleanClears === 1 ? `<span class="tbadge">1/2 clean clears</span>` : ""}${drop}
        </div>
        <div class="tclear">
          <span class="tclear-q">Clean clear?</span>
          <button class="tyn ${clearState === true ? "tyn-yes" : ""}" onclick="setClear('${tk}', true)">Yes</button>
          <button class="tyn ${clearState === false ? "tyn-no" : ""}" onclick="setClear('${tk}', false)">No</button>
        </div>
      </div>`;
    }
    html += `<div class="tactions">
      <button class="primary tsm" ${allChosen ? "" : "disabled"} onclick="completeSession()">Finish session</button>
      <button class="danger tsm" onclick="failSession()">Session failed</button>
      <button class="ghost tsm" onclick="cancelSession()">Cancel</button>
    </div>
    <div class="thint">Clean clear = every set hit, clean form, \u2265 2 reps/seconds left in the tank. 2 clean clears in separate sessions unlock the level-up.</div>
    </div>`;
  }
  html += `</div>`;

  /* --- Tracks overview + level-up buttons --- */
  const capReached = T.week.levelUpsThisWeek >= 2;
  html += `<div class="tcard">
    <div class="thead">
      <div><span class="ttitle">Tracks</span> <span class="tlv">level-ups this week ${T.week.levelUpsThisWeek}/2</span></div>
    </div>
    <div class="tgrid">`;
  for (const [tk, def] of Object.entries(TRACKS)) {
    const t = T.tracks[tk];
    const max = def.levels.length;
    const pct = Math.round((t.level / max) * 100);
    const eligible = trackEligible(tk);
    html += `<div class="tgrid-item">
      <div class="tgrid-name">${def.short}</div>
      <div class="tgrid-lv">LV ${t.level}/${max}</div>
      <div class="tgrid-bar"><div style="width:${pct}%"></div></div>
      ${eligible ? (capReached
        ? `<button class="ghost tsm" disabled title="Max 2 level-ups per week \u2014 available next week">Level up (cap)</button>`
        : `<button class="primary tsm tglow" onclick="levelUp('${tk}')">Level up \u2191</button>`) : ""}
    </div>`;
  }
  html += `</div></div>`;

  /* --- status row --- */
  html += `<div class="tstatus">
    <span>Stage ${T.stage} \u00b7 <a href="#" onclick="toggleStage();return false;">switch to Stage ${T.stage === 0 ? 1 : 0}</a></span>
    <span>Deload counter: week ${T.weeksSinceDeload}/8</span>
  </div>`;

  root.innerHTML = html;
}

/* ---------------- tab switching ---------------- */
function switchTab(name) {
  const pomo = $("tab-pomodoro"), train = $("tab-training");
  const bp = $("tabBtnPomodoro"), bt = $("tabBtnTraining");
  if (!pomo || !train) return;
  const showTraining = name === "training";
  pomo.hidden = showTraining;
  train.hidden = !showTraining;
  bp.classList.toggle("tab-active", !showTraining);
  bt.classList.toggle("tab-active", showTraining);
  try { localStorage.setItem("pp2_tab", name); } catch (e) {}
  if (showTraining) renderTraining();
}

/* ---------------- boot & integration ---------------- */
function trainingBoot() {
  loadT();
  reconcileT();
  renderTraining();
}

/* Re-load training data after a sync pull refreshed localStorage. */
(function integrate() {
  if (typeof refreshUIFromStorage === "function") {
    const orig = refreshUIFromStorage;
    refreshUIFromStorage = function () {
      orig();
      loadT();
      reconcileT();
      renderTraining();
    };
  }
  if (typeof init === "function") {
    const origInit = init;
    init = function () {
      origInit();
      trainingBoot();
    };
  }
})();

/* If init() already ran before this script loaded (no-sync fast path),
   boot on the next tick; the init-wrap above covers the post-pull path.
   trainingBoot is idempotent enough: double boot just re-reads storage. */
setTimeout(() => { if (!T) trainingBoot(); }, 0);

/* Day change while the app stays open: check once a minute. */
setInterval(() => {
  if (T && T.lastReconciledDate !== tToday()) { reconcileT(); renderTraining(); }
}, 60000);

/* Restore last tab */
(function () {
  let last = null;
  try { last = localStorage.getItem("pp2_tab"); } catch (e) {}
  if (last === "training") setTimeout(() => switchTab("training"), 0);
})();
