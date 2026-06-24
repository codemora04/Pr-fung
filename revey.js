import { supabase } from "./supabase.js";
import { getCurrentAuditPeriod, getAuditPeriodStartDate, compressImage, showLoading, hideLoading, handleSupabaseError, showToast, showConfirm } from "./utils.js";
import {
  isNonSatisfactory,
  requiresCA,
  loadCorrectiveActionsForSession,
  createCAFormRow,
} from "./corrective-actions.js";

function parseImageUrls(val) {
  if (!val) return [];
  if (typeof val === "string" && val.startsWith("[")) {
    try { return JSON.parse(val); } catch {}
  }
  return typeof val === "string" ? [val] : [];
}

/* ===================== NAVIGATION PROTECTION ===================== */
window.addEventListener("beforeunload", (e) => {
  const zone = document.getElementById("zone")?.value;
  if (zone) {
    e.preventDefault();
    e.returnValue = "";
  }
});

const btnRetour = document.querySelector(".btn-retour-rouge");
if (btnRetour) {
  btnRetour.addEventListener("click", (e) => {
    const zone = document.getElementById("zone")?.value;
    if (zone && !confirm("Un audit est en cours. Voulez-vous vraiment quitter ? Votre progression locale sera conservée mais l'audit ne sera pas finalisé.")) {
      e.preventDefault();
    }
  });
}

/* ===================== SESSION CHECK ===================== */
const { data: sessionWrap } = await supabase.auth.getSession();
if (!sessionWrap?.session) window.location.href = "login.html";

/* ===================== LOAD DICT FROM SUPABASE ===================== */
async function loadDict(name) {
  const { data, error } = await supabase
    .from("app_data")
    .select("data")
    .eq("name", name)
    .single();

  if (error) {
    console.error("Cannot load", name, error.message);
    alert("Erreur: impossible de charger les données depuis Supabase.");
    return null;
  }
  return data?.data ?? null;
}

const DICT_REVEY = await loadDict("DICT_REVEY");
console.log("DICT_REVEY:", DICT_REVEY);
if (!DICT_REVEY) throw new Error("DICT_REVEY not loaded");


/* ===================== DOM ===================== */
const atelierSelect = document.getElementById("atelier");

const auditContainer = document.getElementById("audit-container");
const auditSelect = document.getElementById("audit");

const zoneContainer = document.getElementById("zone-container");
const zoneSelect = document.getElementById("zone");

const souszoneContainer = document.getElementById("souszone-container");
const souszoneSelect = document.getElementById("souszone");

const rubriqueContainer = document.getElementById("rubrique-container");
const rubriquesList = document.getElementById("rubriques-list");

const downloadBtn = document.getElementById("downloadPdf");
const downloadScoreBtn = document.getElementById("downloadScoreBtn");
const filterIncompleteBtn = document.getElementById("filterIncompleteBtn");

const userId = (await supabase.auth.getUser()).data.user?.id;

let filterActive = false;

function applyFilter() {
  const headers = rubriquesList.querySelectorAll(".rubrique-header");
  headers.forEach(header => {
    const wrapper = header.nextElementSibling;
    if (!wrapper) return;

    // Always keep "Autres" (textarea) section visible
    if (wrapper.querySelector("textarea")) {
      header.style.display = "";
      wrapper.style.display = "";
      return;
    }

    const rows = Array.from(wrapper.querySelectorAll("tbody tr"));
    const questionRows = rows.filter(tr => !tr.querySelector("td[colspan]"));
    const incompleteRows = questionRows.filter(tr => !tr.classList.contains("row-complete"));

    rows.forEach(tr => {
      const isSubheader = !!tr.querySelector("td[colspan]");
      if (filterActive && !isSubheader && tr.classList.contains("row-complete")) {
        tr.style.display = "none";
      } else {
        tr.style.display = "";
      }
    });

    if (filterActive) {
      if (incompleteRows.length === 0) {
        header.style.display = "none";
        wrapper.style.display = "none";
      } else {
        header.style.display = "";
        wrapper.style.display = "";
        wrapper.classList.remove("hidden");
      }
    } else {
      header.style.display = "";
      wrapper.style.display = "";
    }
  });
}

filterIncompleteBtn?.addEventListener("click", () => {
  filterActive = !filterActive;
  filterIncompleteBtn.textContent = filterActive ? "Afficher tout" : "Afficher non complétées";
  filterIncompleteBtn.classList.toggle("active", filterActive);
  applyFilter();
});
const username = localStorage.getItem("username") || "";

/* ===================== DEVICE DETECTION ===================== */
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

/* ===================== DB STATE ===================== */
let currentSessionId = null;

/* ===================== PAGE STATE (persist across refresh) ===================== */
const STATE_KEY = `revey_state_${username}`;

function saveState() {
  const audit = auditSelect.value;
  const period = audit ? getCurrentAuditPeriod(audit) : "";
  const state = {
    atelier: atelierSelect.value,
    audit: audit,
    zone: zoneSelect.value,
    souszone: souszoneSelect.value,
    sessionId: currentSessionId,
    period: period,
  };
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function clearState() {
  localStorage.removeItem(STATE_KEY);
}

async function restoreState() {
  const raw = localStorage.getItem(STATE_KEY);
  if (!raw) return;

  let state;
  try { state = JSON.parse(raw); } catch { return; }

  const { atelier, audit, zone, souszone, period } = state;
  if (!atelier) return;

  // Vérifier que la période sauvegardée est toujours la période courante
  if (audit && period) {
    const currentPeriod = getCurrentAuditPeriod(audit);
    if (period !== currentPeriod) {
      clearState();
      return;
    }
  }

  // Restore atelier
  atelierSelect.value = atelier;
  if (!atelierSelect.value) return;

  // Rebuild audits
  const auditsObj = DICT_REVEY?.[atelier] || {};
  resetSelect(auditSelect);
  Object.keys(auditsObj).forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    auditSelect.appendChild(opt);
  });
  auditContainer?.classList.remove("hidden");

  if (!audit) return;
  auditSelect.value = audit;
  if (!auditSelect.value) return;

  // Rebuild zones
  const zonesObj = DICT_REVEY?.[atelier]?.[audit] || {};
  resetSelect(zoneSelect);
  Object.keys(zonesObj).forEach((z) => {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = z;
    zoneSelect.appendChild(opt);
  });
  zoneContainer?.classList.remove("hidden");
  refreshSelectsProgress();

  if (!zone) return;
  zoneSelect.value = zone;
  if (!zoneSelect.value) return;

  const zoneData = DICT_REVEY?.[atelier]?.[audit]?.[zone];
  if (!zoneData) return;

  const values = Object.values(Array.isArray(zoneData) ? {} : zoneData);
  const zoneIsDirectQuestions = Array.isArray(zoneData);
  const zoneIsDirectRubriques = values.length > 0 && values.every((v) => Array.isArray(v));

  if (zoneIsDirectQuestions || zoneIsDirectRubriques) {
    showLoading("Chargement...");
    try {
      await getOrCreateAuditSession(atelier, audit, zone, null);
      const [existing, existingCAs] = await Promise.all([getExistingAnswers(currentSessionId), loadCorrectiveActionsForSession(currentSessionId)]);
      showRubriques(zoneData, existing, existingCAs);
    } catch (e) { console.error(e); }
    finally { hideLoading(); }
    refreshSelectsProgress();
    return;
  }

  // Zone has sous-zones: rebuild dropdown
  const souszones = Object.keys(zoneData);
  resetSelect(souszoneSelect);
  souszones.forEach((sz) => {
    const opt = document.createElement("option");
    opt.value = sz;
    opt.textContent = sz;
    souszoneSelect.appendChild(opt);
  });
  souszoneContainer.classList.remove("hidden");
  refreshSelectsProgress();

  if (!souszone) return;
  souszoneSelect.value = souszone;
  if (!souszoneSelect.value) return;

  const rubriquesObj = DICT_REVEY[atelier]?.[audit]?.[zone]?.[souszone];
  if (!rubriquesObj) return;

  showLoading("Chargement...");
  try {
    await getOrCreateAuditSession(atelier, audit, zone, souszone);
    const [existing, existingCAs] = await Promise.all([getExistingAnswers(currentSessionId), loadCorrectiveActionsForSession(currentSessionId)]);
    showRubriques(rubriquesObj, existing, existingCAs);
  } catch (e) { console.error(e); }
  finally { hideLoading(); }

  refreshSelectsProgress();
}

/* ===================== HELPERS ===================== */
function resetSelect(selectEl) {
  if (!selectEl) return;
  selectEl.innerHTML = `<option value="">--Choisir--</option>`;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function hideAllBelowAtelier() {
  auditContainer?.classList.add("hidden");
  zoneContainer?.classList.add("hidden");
  souszoneContainer?.classList.add("hidden");
  rubriqueContainer?.classList.add("hidden");
  downloadBtn?.classList.add("hidden");
  downloadScoreBtn?.classList.add("hidden");
  filterActive = false;
  filterIncompleteBtn?.classList.add("hidden");
  filterIncompleteBtn?.classList.remove("active");
  resetSelect(souszoneSelect);

  resetSelect(auditSelect);
  resetSelect(zoneSelect);
  if (rubriquesList) rubriquesList.innerHTML = "";
  document.getElementById("progress-root")?.classList.add("hidden");
  document.getElementById("summary-section")?.classList.add("hidden");
}

/* ===================== ROW COMPLETION + COLOR ===================== */
function isRowComplete(tr) {
  const statusEl = tr.querySelector("select");
  const commentEl = tr.querySelector('input[type="text"]');
  const fileEl = tr.querySelector('input[type="file"]');

  const status = statusEl?.value || "";
  const comment = commentEl?.value?.trim() || "";
  const hasFile = (fileEl?.files && fileEl.files.length > 0) || tr.dataset.hasImages === "1";

  if (status === "") return false;
  if (comment === "") return false;

  // Image mandatory ONLY on mobile for: Acceptable(2), Unsatisfactory(3), Non(non)
  if (isMobile) {
    const imageMandatory = ["2", "3", "non"].includes(status);
    if (imageMandatory && !hasFile) return false;
  }

  return true;
}

function updateRowColor(tr) {
  if (!tr) return;
  if (isRowComplete(tr)) tr.classList.add("row-complete");
  else tr.classList.remove("row-complete");
}

/* ===================== PROGRESSION TRACKING ===================== */
function getProgressKey(atelier, audit, zone, souszone) {
  const period = getCurrentAuditPeriod(audit);
  const id = `prog_${username}_${period}_${atelier}_${audit}_${zone}`;
  return souszone ? `${id}_${souszone}` : id;
}

function updateProgressState(atelier, audit, zone, souszone, completedObj) {
  if (!atelier || !audit || !zone) return;
  const key = getProgressKey(atelier, audit, zone, souszone);
  localStorage.setItem(key, JSON.stringify(completedObj));
}

function getProgressState(atelier, audit, zone, souszone) {
  if (!atelier || !audit || !zone) return null;
  const key = getProgressKey(atelier, audit, zone, souszone);
  const data = localStorage.getItem(key);
  return data ? JSON.parse(data) : null;
}

function checkSouszonesCompletion(atelier, audit, zone, souszonesList) {
  for (const sz of souszonesList) {
    const state = getProgressState(atelier, audit, zone, sz);
    if (!state || state.completed < state.total || state.total === 0) return false;
  }
  return true;
}

function refreshSelectsProgress() {
  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  if (!atelier || !audit) return;

  const zonesObj = DICT_REVEY?.[atelier]?.[audit] || {};
  const zoneOptions = zoneSelect.options;
  for (let i = 1; i < zoneOptions.length; i++) {
    const opt = zoneOptions[i];
    const zName = opt.value;
    const zoneData = zonesObj[zName];
    let isComplete = false;

    if (!zoneData) {
      opt.textContent = zName;
      continue;
    }

    const vals = Object.values(Array.isArray(zoneData) ? {} : zoneData);
    const isDirect = Array.isArray(zoneData) || (vals.length > 0 && vals.every(v => Array.isArray(v)));

    if (isDirect) {
      const state = getProgressState(atelier, audit, zName, null);
      if (state && state.completed === state.total && state.total > 0) isComplete = true;
    } else {
      const souszonesList = Object.keys(zoneData);
      isComplete = checkSouszonesCompletion(atelier, audit, zName, souszonesList);
    }

    if (isComplete) {
      if (!opt.textContent.startsWith("✅ ")) opt.textContent = "✅ " + zName;
    } else {
      opt.textContent = zName;
    }
  }

  // Refresh sous-zones
  const zone = zoneSelect.value;
  if (!zone) return;
  const szOptions = souszoneSelect.options;
  for (let i = 1; i < szOptions.length; i++) {
    const opt = szOptions[i];
    const szName = opt.value;
    const state = getProgressState(atelier, audit, zone, szName);
    if (state && state.completed === state.total && state.total > 0) {
      if (!opt.textContent.startsWith("✅ ")) opt.textContent = "✅ " + szName;
    } else {
      opt.textContent = szName;
    }
  }
}

function computeViewProgress() {
  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  const zone = zoneSelect.value;
  const souszone = souszoneSelect.value;
  if (!atelier || !audit || !zone) return;

  const tables = rubriquesList.querySelectorAll("table.questions-table");
  let totalRows = 0;
  let completedRows = 0;

  tables.forEach(table => {
    const rows = table.querySelectorAll("tbody tr");
    totalRows += rows.length;
    rows.forEach(tr => {
      if (isRowComplete(tr)) completedRows++;
    });
  });
  console.log(completedRows, totalRows);

  updateProgressState(atelier, audit, zone, souszone || null, { total: totalRows, completed: completedRows });

  // Update Progress Bar
  const progressRoot = document.getElementById("progress-root");
  const progressFill = document.getElementById("progress-fill");
  const progressPercent = document.getElementById("progress-percent");

  if (progressRoot && totalRows > 0) {
    progressRoot.classList.remove("hidden");
    const percent = Math.round((completedRows / totalRows) * 100);
    progressFill.style.width = percent + "%";
    progressPercent.textContent = percent + "%";
  }

  // Update Summary if full
  if (totalRows > 0 && completedRows === totalRows) {
    showSummary();
  } else {
    document.getElementById("summary-section")?.classList.add("hidden");
  }

  refreshSelectsProgress();
  computeGlobalProgress();
}

let debounceTimerId = null;

async function computeGlobalProgress() {
  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  if (!atelier || !audit) return;

  const totalQuestions = getAuditTotalQuestions(atelier, audit);
  if (totalQuestions === 0) return;

  clearTimeout(debounceTimerId);
  debounceTimerId = setTimeout(async () => {
    try {
      const fullAuditName = `${atelier} — ${audit}`;
      const periodStartDate = getAuditPeriodStartDate(audit);
      const { data: sessions } = await supabase
        .from("audit_sessions")
        .select("id")
        .eq("user_id", userId)
        .eq("audit", fullAuditName)
        .gte("created_at", periodStartDate);

      let completedCount = 0;
      if (sessions && sessions.length > 0) {
        const sessionIds = sessions.map(s => s.id);
        const { count } = await supabase
          .from("audit_answers")
          .select("*", { count: 'exact', head: true })
          .in("session_id", sessionIds);
        completedCount = count || 0;
      }

      const progressRoot = document.getElementById("progress-root");
      const progressFill = document.getElementById("progress-fill");
      const progressPercent = document.getElementById("progress-percent");

      if (progressRoot) {
        progressRoot.classList.remove("hidden");
        const percent = Math.min(100, Math.round((completedCount / totalQuestions) * 100));
        progressFill.style.width = percent + "%";
        progressPercent.textContent = percent + "%";
      }
    } catch (e) {
      console.error("Global progress err:", e);
    }
  }, 1500);
}

function getAuditTotalQuestions(atelierName, auditName) {
  const auditData = DICT_REVEY[atelierName]?.[auditName];
  if (!auditData) return 0;
  let total = 0;

  for (const zone in auditData) {
    const zoneData = auditData[zone];
    if (Array.isArray(zoneData)) {
      total += zoneData.length;
      continue;
    }
    const values = Object.values(zoneData || {});
    const isDirectRubriques = values.length > 0 && values.every(v => Array.isArray(v));

    if (isDirectRubriques) {
      for (const rub in zoneData) total += (zoneData[rub] || []).length;
      continue;
    }

    for (const souszone in zoneData) {
      const rubriques = zoneData[souszone];
      if (Array.isArray(rubriques)) total += rubriques.length;
      else if (typeof rubriques === 'object') {
        for (const rub in rubriques) total += (rubriques[rub] || []).length;
      }
    }
  }
  return total;
}

function showSummary() {
  const summarySection = document.getElementById("summary-section");
  const summaryBody = document.getElementById("summary-body");
  if (!summarySection || !summaryBody) return;

  summaryBody.innerHTML = "";
  const rubriques = rubriquesList.querySelectorAll(".rubrique-header");
  let globalGood = 0;
  let globalTotal = 0;
  const safety = isSafetyAuditSelected();

  rubriques.forEach(header => {
    const title = header.textContent.replace(/[▶▼0-9]/g, "").trim();
    const wrapper = header.nextElementSibling;
    const rows = wrapper.querySelectorAll("tbody tr");
    let good = 0;
    let applicable = 0;

    rows.forEach(tr => {
      const val = tr.querySelector("select")?.value;
      if (!val) return; // Skip empty
      
      if (safety) {
        if (val === "na") return; // Ignorer "non applicable"
        applicable++;
        if (val === "oui") good++;
      } else {
        applicable++;
        if (val === "1" || val === "oui") good++;
      }
    });

    const score = applicable > 0 ? Math.round((good / applicable) * 100) : 0;
    globalGood += good;
    globalTotal += applicable;

    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${title}</td><td style="text-align:right; font-weight:bold;">${score}%</td>`;
    summaryBody.appendChild(tr);
  });

  if (globalTotal > 0) {
    const avg = Math.round((globalGood / globalTotal) * 100);
    const trFinal = document.createElement("tr");
    trFinal.innerHTML = `<td>TOTAL GLOBAL</td><td style="text-align:right; font-weight:bold;">${avg}%</td>`;
    summaryBody.appendChild(trFinal);
  } else {
    const trFinal = document.createElement("tr");
    trFinal.innerHTML = `<td>TOTAL GLOBAL</td><td style="text-align:right; font-weight:bold;">0%</td>`;
    summaryBody.appendChild(trFinal);
  }

  summarySection.classList.remove("hidden");
}

/* ===================== POPULATE ATELIERS ===================== */
resetSelect(atelierSelect);
Object.keys(DICT_REVEY || {}).forEach((atelier) => {
  const opt = document.createElement("option");
  opt.value = atelier;
  opt.textContent = atelier;
  atelierSelect.appendChild(opt);
});

atelierSelect.addEventListener("change", () => {
  hideAllBelowAtelier();
  clearState();

  const atelier = atelierSelect.value;
  if (!atelier) return;

  const auditsObj = DICT_REVEY?.[atelier] || {};
  const audits = Object.keys(auditsObj);

  resetSelect(auditSelect);
  audits.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    auditSelect.appendChild(opt);
  });

  auditContainer?.classList.remove("hidden");
  saveState();
});


auditSelect.addEventListener("change", async () => {
  zoneContainer?.classList.add("hidden");
  souszoneContainer?.classList.add("hidden");
  rubriqueContainer?.classList.add("hidden");
  downloadBtn?.classList.add("hidden");
  downloadScoreBtn?.classList.add("hidden");

  resetSelect(zoneSelect);
  resetSelect(souszoneSelect);
  if (rubriquesList) rubriquesList.innerHTML = "";

  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  if (!atelier || !audit) return;

  const zonesObj = DICT_REVEY?.[atelier]?.[audit] || {};
  const zones = Object.keys(zonesObj);

  zones.forEach((z) => {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = z;
    zoneSelect.appendChild(opt);
  });

  zoneContainer?.classList.remove("hidden");
  refreshSelectsProgress();
  saveState();

  currentSessionId = null; // Session logic moved to zones
});


zoneSelect.addEventListener("change", async () => {
  souszoneContainer?.classList.add("hidden");
  rubriqueContainer?.classList.add("hidden");
  downloadBtn?.classList.add("hidden");
  downloadScoreBtn?.classList.add("hidden");

  resetSelect(souszoneSelect);
  if (rubriquesList) rubriquesList.innerHTML = "";

  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  const zone = zoneSelect.value;
  if (!atelier || !audit || !zone) return;

  const zoneData = DICT_REVEY?.[atelier]?.[audit]?.[zone];
  if (!zoneData) return;

  const values = Object.values(Array.isArray(zoneData) ? {} : zoneData);
  const zoneIsDirectQuestions = Array.isArray(zoneData);
  const zoneIsDirectRubriques = values.length > 0 && values.every((v) => Array.isArray(v));

  if (zoneIsDirectQuestions || zoneIsDirectRubriques) {
    showLoading("Chargement...");
    try {
      await getOrCreateAuditSession(atelier, audit, zone, null);
      const [existing, existingCAs] = await Promise.all([getExistingAnswers(currentSessionId), loadCorrectiveActionsForSession(currentSessionId)]);
      showRubriques(zoneData, existing, existingCAs);
    } catch (e) { handleSupabaseError(e, "Erreur"); }
    finally { hideLoading(); }
    refreshSelectsProgress();
    saveState();
    return;
  }

  // Zone has sous-zones
  const souszones = Object.keys(zoneData);
  resetSelect(souszoneSelect);
  souszones.forEach((sz) => {
    const opt = document.createElement("option");
    opt.value = sz;
    opt.textContent = sz;
    souszoneSelect.appendChild(opt);
  });
  souszoneContainer.classList.remove("hidden");
  refreshSelectsProgress();
  saveState();
});

souszoneSelect.addEventListener("change", async () => {
  rubriqueContainer?.classList.add("hidden");
  if (downloadBtn) downloadBtn.classList.add("hidden");
  if (downloadScoreBtn) downloadScoreBtn.classList.add("hidden");
  if (rubriquesList) rubriquesList.innerHTML = "";

  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  const zone = zoneSelect.value;
  const souszone = souszoneSelect.value;
  if (!atelier || !audit || !zone || !souszone) return;

  const rubriquesObj = DICT_REVEY[atelier]?.[audit]?.[zone]?.[souszone];
  if (!rubriquesObj) return;

  showLoading("Chargement...");
  try {
    await getOrCreateAuditSession(atelier, audit, zone, souszone);
    const [existing, existingCAs] = await Promise.all([getExistingAnswers(currentSessionId), loadCorrectiveActionsForSession(currentSessionId)]);
    showRubriques(rubriquesObj, existing, existingCAs);
  } catch (e) { handleSupabaseError(e, "Erreur"); }
  finally { hideLoading(); }
  saveState();
});

await restoreState();

/* ===================== DB HELPERS ===================== */
function safeUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function getOrCreateAuditSession(atelier, audit, zone, souszone) {
  const fullAuditName = `${atelier} — ${audit}`;
  const periodStartDate = getAuditPeriodStartDate(audit);

  let query = supabase
    .from("audit_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("audit", fullAuditName)
    .gte("created_at", periodStartDate);

  if (zone) query = query.eq("zone", zone);
  else query = query.is("zone", null);

  if (souszone) query = query.eq("souszone", souszone);
  else query = query.is("souszone", null);

  const { data: existing, error: errFetch } = await query.limit(1);
  if (errFetch) throw errFetch;

  if (existing && existing.length > 0) {
    currentSessionId = existing[0].id;
    return currentSessionId;
  }

  const { data: newSession, error: errInsert } = await supabase
    .from("audit_sessions")
    .insert({
      user_id: userId,
      audit: fullAuditName,
      zone: zone || null,
      souszone: souszone || null,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (errInsert) throw errInsert;
  currentSessionId = newSession.id;
  return newSession.id;
}

async function getExistingAnswers(sessionId) {
  if (!sessionId) return [];
  const { data, error } = await supabase
    .from("audit_answers")
    .select("*")
    .eq("session_id", sessionId);

  if (error) {
    console.error("Erreur chargement réponses:", error);
    return [];
  }
  return data || [];
}

async function uploadImageToStorage(file) {
  if (!file) return "";
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const filePath = `image_url/${safeUUID()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from("audit-images")
    .upload(filePath, file, { upsert: true });

  if (upErr) throw upErr;

  const { data } = supabase.storage.from("audit-images").getPublicUrl(filePath);
  return data.publicUrl || "";
}

async function saveAnswer({ rubriqueTitle, question, statusLabel, comment, files, existingUrls }) {
  if (!currentSessionId) return;

  const urls = [...(existingUrls || [])];
  try {
    for (const f of (files || [])) {
      const compressed = await compressImage(f);
      const url = await uploadImageToStorage(compressed);
      if (url) urls.push(url);
    }
  } catch (e) {
    handleSupabaseError(e, "Erreur upload image");
    return;
  }

  const image_url = urls.length === 0 ? null
    : urls.length === 1 ? urls[0]
    : JSON.stringify(urls);

  const { error } = await supabase
    .from("audit_answers")
    .upsert(
      {
        session_id: currentSessionId,
        rubrique: rubriqueTitle,
        question: question,
        status: statusLabel,
        comment: comment,
        image_url: image_url,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id,rubrique,question" }
    );

  if (error) { handleSupabaseError(error, "Erreur sauvegarde réponse"); return null; }
  return image_url;
}
function isSafetyAuditSelected() {
  const val = auditSelect?.value?.toLowerCase() || "";
  return val.includes("safety") || val.includes("anomalie");
}

function statusValueToLabel(value) {
  if (isSafetyAuditSelected()) {
    if (value === "oui") return "Oui";
    if (value === "non") return "Non";
    if (value === "na") return "Non applicable";
    return "";
  } else {
    if (value === "1") return "Good";
    if (value === "2") return "Acceptable";
    if (value === "3") return "Unsatisfactory";
    return "";
  }
}

/* ===================== SHOW RUBRIQUES ===================== */
function showRubriques(rubriquesObj, existingAnswers = [], existingCAs = []) {
  const ansMap = {};
  existingAnswers.forEach(a => ansMap[`${a.rubrique}|${a.question}`] = a);

  const caMap = {};
  existingCAs.forEach(ca => { caMap[`${ca.rubrique}|${ca.question}`] = ca; });

  function mapStatusVal(statusLabel) {
    const isSafety = isSafetyAuditSelected();
    if (isSafety) {
      if (statusLabel === "Oui") return "oui";
      if (statusLabel === "Non") return "non";
      if (statusLabel === "Non applicable") return "na";
      return "";
    }
    if (statusLabel === "Good" || statusLabel === "Oui") return "1"; // "Oui" is for backward compat
    if (statusLabel === "Acceptable") return "2";
    if (statusLabel === "Unsatisfactory" || statusLabel === "Non") return "3"; // "Non" is for backward compat
    return "";
  }
  rubriquesList.innerHTML = "";

  // ✅ CAS 1 : directement un tableau de questions (pas de rubrique)
  if (Array.isArray(rubriquesObj)) {
    const header = document.createElement("div");
    header.className = "rubrique-header";
    header.innerHTML = "Questions";

    const tableWrapper = document.createElement("div");
    tableWrapper.className = "rubrique-table-wrapper";

    const table = document.createElement("table");
    table.className = "questions-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Question</th>
          <th>Status</th>
          <th>Commentaire</th>
          ${isMobile ? '<th>Image</th>' : ''}
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");

    rubriquesObj.forEach((q, qIndex) => {
      const tr = document.createElement("tr");

      let statusOptions = `<option value="">--</option>`;
      const auditSelect = document.getElementById("audit");
      const audit = auditSelect?.value || "";
      const isSafety = audit.toLowerCase().includes("safety") || audit.toLowerCase().includes("anomalie");

      if (isSafety) {
        statusOptions += `
          <option value="oui">Oui</option>
          <option value="non">Non</option>
          <option value="na">Non applicable</option>
        `;
      } else {
        statusOptions += `
          <option value="1">Good</option>
          <option value="2">Acceptable</option>
          <option value="3">Unsatisfactory</option>
        `;
      }

      tr.innerHTML = `
        <td>${q}</td>
        <td>
          <select name="status_0_${qIndex}">
            ${statusOptions}
          </select>
        </td>
        <td>
          <input type="text" name="comment_0_${qIndex}" placeholder="Commentaire..." />
        </td>
        ${isMobile ? `<td><input type="file" name="image_0_${qIndex}" accept="image/png, image/jpeg, image/jpg" multiple /></td>` : ''}
      `;

      tbody.appendChild(tr);

      const statusEl = tr.querySelector("select");
      const commentEl = tr.querySelector('input[type="text"]');
      const fileEl = tr.querySelector('input[type="file"]');

      const questionText = q;
      const ex = ansMap[`Questions|${questionText}`];
      let currentImageUrls = parseImageUrls(ex?.image_url);

      // CA form row (hidden until "Unsatisfactory"/"Non" selected)
      const caRow = createCAFormRow({
        colspan: isMobile ? 4 : 3,

        existingCA: caMap[`Questions|${questionText}`] || null,
        sessionInfo: {
          sessionId: currentSessionId,
          auditName: [atelierSelect.value, auditSelect.value].filter(Boolean).join(" — "),
          zone: zoneSelect.value,
          sousZone: souszoneSelect.value || null,
          rubrique: "Questions",
          question: questionText,
        },
        createdBy: username,
      });
      tbody.appendChild(caRow);

      if (ex) {
        statusEl.value = mapStatusVal(ex.status);
        commentEl.value = ex.comment || "";
        if (requiresCA(statusEl.value)) caRow.classList.remove("hidden");
        if (ex.image_url) {
          tr.dataset.hasImages = "1";
          refreshImageLinks();
        }
      }

      function refreshImageLinks() {
        tr.querySelectorAll(".qa-img-item").forEach(el => el.remove());
        currentImageUrls.forEach((u, i) => {
          const item = document.createElement("span");
          item.className = "qa-img-item";
          const link = document.createElement("a");
          link.href = u; link.target = "_blank";
          link.style.cssText = "font-size:1.3rem;text-decoration:none;margin-right:2px;";
          link.textContent = `🖼️${currentImageUrls.length > 1 ? i + 1 : ""}`;
          const delBtn = document.createElement("button");
          delBtn.type = "button"; delBtn.className = "qa-img-del";
          delBtn.title = "Supprimer cette image";
          delBtn.addEventListener("click", async () => {
            if (!confirm("Supprimer cette image ?")) return;
            currentImageUrls.splice(i, 1);
            const statusLabel = statusValueToLabel(statusEl?.value || "");
            const comment = commentEl?.value?.trim() || "";
            await saveAnswer({ rubriqueTitle: "Questions", question: questionText, statusLabel, comment, files: [], existingUrls: currentImageUrls });
            tr.dataset.hasImages = currentImageUrls.length > 0 ? "1" : "";
            refreshImageLinks();
          });
          item.appendChild(link);
          item.appendChild(delBtn);
          if (fileEl) fileEl.before(item); else commentEl.parentElement.appendChild(item);
        });
      }

      const metaSave = async () => {
        const statusLabel = statusValueToLabel(statusEl?.value || "");
        const comment = commentEl?.value?.trim() || "";
        await saveAnswer({ rubriqueTitle: "Questions", question: questionText, statusLabel, comment, files: [], existingUrls: currentImageUrls });
      };

      const debouncedSave = debounce(metaSave, 500);

      statusEl.addEventListener("change", () => {
        metaSave();
        updateRowColor(tr);
        computeViewProgress();
        if (requiresCA(statusEl.value)) {
          caRow.classList.remove("hidden");
        } else {
          caRow.classList.add("hidden");
        }
      });

      commentEl.addEventListener("input", () => {
        debouncedSave();
        updateRowColor(tr);
        computeViewProgress();
      });

      fileEl?.addEventListener("change", async () => {
        const newFiles = Array.from(fileEl?.files || []);
        if (!newFiles.length) return;
        const statusLabel = statusValueToLabel(statusEl?.value || "");
        const comment = commentEl?.value?.trim() || "";
        const saved = await saveAnswer({ rubriqueTitle: "Questions", question: questionText, statusLabel, comment, files: newFiles, existingUrls: currentImageUrls });
        if (saved !== null) {
          currentImageUrls = parseImageUrls(saved);
          tr.dataset.hasImages = currentImageUrls.length > 0 ? "1" : "";
          refreshImageLinks();
        }
        fileEl.value = "";
        updateRowColor(tr);
        computeViewProgress();
      });

      updateRowColor(tr);
    });

    tableWrapper.appendChild(table);
    rubriquesList.appendChild(header);
    rubriquesList.appendChild(tableWrapper);

    rubriqueContainer?.classList.remove("hidden");
    downloadBtn?.classList.remove("hidden");
    downloadScoreBtn?.classList.remove("hidden");
  } else {

  Object.entries(rubriquesObj || {}).forEach(([rubrique, questions], index) => {
    // Header (accordion)
    const header = document.createElement("div");
    header.className = "rubrique-header";
    header.innerHTML = `&#9654; ${rubrique}`;

    // Wrapper
    const tableWrapper = document.createElement("div");
    tableWrapper.className = "rubrique-table-wrapper hidden";

    // Table
    const table = document.createElement("table");
    table.className = "questions-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Question</th>
          <th>Status</th>
          <th>Commentaire</th>
          ${isMobile ? '<th>Image</th>' : ''}
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector("tbody");

    let extractedQuestions = [];
    if (Array.isArray(questions)) {
      extractedQuestions = questions.map(q => ({ qText: q, trueRubrique: rubrique }));
    } else if (typeof questions === "object" && questions !== null) {
      for (const [subRName, subQs] of Object.entries(questions)) {
        if (Array.isArray(subQs)) {
          extractedQuestions.push({ isSubHeader: true, title: subRName });
          subQs.forEach(q => extractedQuestions.push({ qText: q, trueRubrique: subRName }));
        } else if (typeof subQs === "object" && subQs !== null) {
          for (const [subSub, subSubQs] of Object.entries(subQs)) {
            if (Array.isArray(subSubQs)) {
              extractedQuestions.push({ isSubHeader: true, title: `${subRName} - ${subSub}` });
              subSubQs.forEach(q => extractedQuestions.push({ qText: q, trueRubrique: subSub }));
            }
          }
        }
      }
    }

    extractedQuestions.forEach((item, qIndex) => {
      const tr = document.createElement("tr");

      if (item.isSubHeader) {
        tr.innerHTML = `<td colspan="${isMobile ? 4 : 3}" style="background-color: #f1f5f9; font-weight: bold; color: #475569; padding-left: 15px; text-transform: uppercase; font-size: 13px;">${item.title}</td>`;
        tbody.appendChild(tr);
        return; // Passer à l'élément suivant
      }

      const q = item.qText;
      const trueRubriqueTitle = item.trueRubrique;
      const safety = isSafetyAuditSelected();

      let statusOptions = `<option value="">--</option>`;
      if (safety) {
        statusOptions += `
          <option value="oui">Oui</option>
          <option value="non">Non</option>
          <option value="na">Non applicable</option>
        `;
      } else {
        statusOptions += `
          <option value="1">Good</option>
          <option value="2">Acceptable</option>
          <option value="3">Unsatisfactory</option>
        `;
      }

      tr.innerHTML = `
        <td>${q}</td>
        <td>
          <select name="status_${index}_${qIndex}">
            ${statusOptions}
          </select>
        </td>
        <td>
          <input type="text" name="comment_${index}_${qIndex}" placeholder="Commentaire..." />
        </td>
        ${isMobile ? `<td><input type="file" name="image_${index}_${qIndex}" accept="image/png, image/jpeg, image/jpg" multiple /></td>` : ''}
      `;

      tbody.appendChild(tr);

      const statusEl = tr.querySelector("select");
      const commentEl = tr.querySelector('input[type="text"]');
      const fileEl = tr.querySelector('input[type="file"]');

      const rubriqueTitle = trueRubriqueTitle;
      const questionText = q;

      // On essaye de récupérer la réponse avec le vrai titre de la rubrique, ou l'ancien (nom de la sous-zone) par rétrocompatibilité
      const ex = ansMap[`${rubriqueTitle}|${questionText}`] || ansMap[`${rubrique}|${questionText}`];
      let currentImageUrls = parseImageUrls(ex?.image_url);

      // CA form row (hidden until "Unsatisfactory"/"Non" selected)
      const caRow = createCAFormRow({
        colspan: isMobile ? 4 : 3,

        existingCA: caMap[`${rubriqueTitle}|${questionText}`] || null,
        sessionInfo: {
          sessionId: currentSessionId,
          auditName: [atelierSelect.value, auditSelect.value].filter(Boolean).join(" — "),
          zone: zoneSelect.value,
          sousZone: souszoneSelect.value || null,
          rubrique: rubriqueTitle,
          question: questionText,
        },
        createdBy: username,
      });
      tbody.appendChild(caRow);

      if (ex) {
        statusEl.value = mapStatusVal(ex.status);
        commentEl.value = ex.comment || "";
        if (requiresCA(statusEl.value)) caRow.classList.remove("hidden");
        if (ex.image_url) {
          tr.dataset.hasImages = "1";
          refreshImageLinks();
        }
      }

      function refreshImageLinks() {
        tr.querySelectorAll(".qa-img-item").forEach(el => el.remove());
        currentImageUrls.forEach((u, i) => {
          const item = document.createElement("span");
          item.className = "qa-img-item";
          const link = document.createElement("a");
          link.href = u; link.target = "_blank";
          link.style.cssText = "font-size:1.3rem;text-decoration:none;margin-right:2px;";
          link.textContent = `🖼️${currentImageUrls.length > 1 ? i + 1 : ""}`;
          const delBtn = document.createElement("button");
          delBtn.type = "button"; delBtn.className = "qa-img-del";
          delBtn.title = "Supprimer cette image";
          delBtn.addEventListener("click", async () => {
            if (!confirm("Supprimer cette image ?")) return;
            currentImageUrls.splice(i, 1);
            const statusLabel = statusValueToLabel(statusEl?.value || "");
            const comment = commentEl?.value?.trim() || "";
            await saveAnswer({ rubriqueTitle, question: questionText, statusLabel, comment, files: [], existingUrls: currentImageUrls });
            tr.dataset.hasImages = currentImageUrls.length > 0 ? "1" : "";
            refreshImageLinks();
          });
          item.appendChild(link);
          item.appendChild(delBtn);
          if (fileEl) fileEl.before(item); else commentEl.parentElement.appendChild(item);
        });
      }

      const metaSave = async () => {
        const statusLabel = statusValueToLabel(statusEl?.value || "");
        const comment = commentEl?.value?.trim() || "";
        await saveAnswer({ rubriqueTitle, question: questionText, statusLabel, comment, files: [], existingUrls: currentImageUrls });
      };

      const debouncedSave = debounce(metaSave, 500);

      statusEl.addEventListener("change", () => {
        metaSave();
        updateRowColor(tr);
        computeViewProgress();
        if (requiresCA(statusEl.value)) {
          caRow.classList.remove("hidden");
        } else {
          caRow.classList.add("hidden");
        }
      });

      commentEl.addEventListener("input", () => {
        debouncedSave();
        updateRowColor(tr);
        computeViewProgress();
      });

      fileEl?.addEventListener("change", async () => {
        const newFiles = Array.from(fileEl?.files || []);
        if (!newFiles.length) return;
        const statusLabel = statusValueToLabel(statusEl?.value || "");
        const comment = commentEl?.value?.trim() || "";
        const saved = await saveAnswer({ rubriqueTitle, question: questionText, statusLabel, comment, files: newFiles, existingUrls: currentImageUrls });
        if (saved !== null) {
          currentImageUrls = parseImageUrls(saved);
          tr.dataset.hasImages = currentImageUrls.length > 0 ? "1" : "";
          refreshImageLinks();
        }
        fileEl.value = "";
        updateRowColor(tr);
        computeViewProgress();
      });

      updateRowColor(tr);
    });

    tableWrapper.appendChild(table);

    // Accordion toggle
    header.addEventListener("click", () => {
      tableWrapper.classList.toggle("hidden");
      header.innerHTML =
        (tableWrapper.classList.contains("hidden") ? "&#9654;" : "&#9660;") + " " + rubrique;
    });

    rubriquesList.appendChild(header);
    rubriquesList.appendChild(tableWrapper);
    });
  }

  // ✅ AJOUT RUBRIQUE "AUTRES"
  const headerAutres = document.createElement("div");
  headerAutres.className = "rubrique-header";
  headerAutres.innerHTML = `&#9654; Autres (Remarques générales)`;

  const wrapperAutres = document.createElement("div");
  wrapperAutres.className = "rubrique-table-wrapper hidden";
  wrapperAutres.style.padding = "15px";

  const textareaAutres = document.createElement("textarea");
  textareaAutres.placeholder = "Saisissez ici vos remarques qui n'appartiennent à aucune rubrique...";
  textareaAutres.style.width = "100%";
  textareaAutres.style.minHeight = "100px";
  textareaAutres.style.borderRadius = "8px";
  textareaAutres.style.border = "1px solid #cbd5e1";
  textareaAutres.style.padding = "10px";
  textareaAutres.style.fontSize = "14px";
  textareaAutres.style.fontFamily = "inherit";

  // Load existing
  const exAutres = ansMap["Autres|Remarques"];
  if (exAutres) {
    textareaAutres.value = exAutres.comment || "";
  }

  const saveAutres = async () => {
    await saveAnswer({
      rubriqueTitle: "Autres",
      question: "Remarques",
      statusLabel: "Information",
      comment: textareaAutres.value.trim(),
      files: [],
      existingUrls: [],
    });
  };

  textareaAutres.addEventListener("input", debounce(saveAutres, 1000));

  wrapperAutres.appendChild(textareaAutres);
  headerAutres.addEventListener("click", () => {
    wrapperAutres.classList.toggle("hidden");
    headerAutres.innerHTML = (wrapperAutres.classList.contains("hidden") ? "&#9654;" : "&#9660;") + " Autres (Remarques générales)";
  });

  rubriquesList.appendChild(headerAutres);
  rubriquesList.appendChild(wrapperAutres);

  rubriqueContainer?.classList.remove("hidden");
  downloadBtn?.classList.remove("hidden");
  downloadScoreBtn?.classList.remove("hidden");
  filterActive = false;
  if (filterIncompleteBtn) {
    filterIncompleteBtn.classList.remove("hidden", "active");
    filterIncompleteBtn.textContent = "Afficher non complétées";
  }
}

/* ===================== IMAGE COMPRESS ===================== */
async function readImageCompressed(file, maxW = 900, quality = 0.7) {
  if (!file || !file.type.startsWith("image/")) return "";

  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Image illisible"));
    im.src = dataUrl;
  });

  const ratio = Math.min(1, maxW / img.width);
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);

  return canvas.toDataURL("image/jpeg", quality);
}

/* ===================== PDF DOWNLOAD (FULL REPORT) ===================== */
downloadBtn?.addEventListener("click", async () => {
  const confirmed = await showConfirm("Voulez-vous télécharger le rapport d'audit ?");
  if (!confirmed) return;

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    const atelier = atelierSelect?.value || "";
    const audit = auditSelect?.value || "";
    const zone = zoneSelect?.value || "";
    const username = localStorage.getItem("username") || "Auditeur";
    const dateStr = new Date().toLocaleDateString("fr-FR");
    const timeStr = new Date().toLocaleTimeString("fr-FR");

    const colorSlate = [30, 41, 59];
    const colorEmerald = [16, 185, 129];

    const addPageDesign = (pageNum) => {
      // --- En-tête ---
      doc.setFillColor(...colorSlate);
      doc.rect(0, 0, pageWidth, 40, "F");

      try {
        doc.addImage("logo2.png", "PNG", 14, 8, 35, 15);
      } catch (e) {
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(16);
        doc.text("REVEY", 14, 18);
      }

      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18);
      doc.setFont(undefined, "bold");
      doc.text("RAPPORT D'AUDIT", pageWidth - 14, 18, { align: "right" });

      doc.setFontSize(10);
      doc.setFont(undefined, "normal");
      doc.text(`${atelier} — ${audit}`, pageWidth - 14, 25, { align: "right" });
      doc.text(`Page ${pageNum}`, pageWidth - 14, 32, { align: "right" });

      // --- Pied de page ---
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.1);
      doc.line(14, pageHeight - 15, pageWidth - 14, pageHeight - 15);

      doc.setFontSize(9);
      doc.setTextColor(51, 65, 85);
      doc.setFont(undefined, "normal");
      doc.text(`Généré le ${dateStr} à ${timeStr} par ${username}`, 14, pageHeight - 10);
      doc.text(`Page ${pageNum}`, pageWidth - 14, pageHeight - 10, { align: "right" });
    };

    const generatePDF = async () => {
      showLoading("Génération du rapport PDF consolidé...");
      try {
        const fullAuditName = `${atelier} — ${audit}`;
        const periodStartDate = getAuditPeriodStartDate(audit);

        const { data: sessions } = await supabase
          .from("audit_sessions")
          .select("id, zone")
          .eq("audit", fullAuditName)
          .eq("user_id", userId)
          .gte("created_at", periodStartDate);

        const answerMap = {};
        const preloadedImages = {};
        const imagePromises = [];

        if (sessions && sessions.length > 0) {
          const sessionIds = sessions.map(s => s.id);
          const sessionMap = {};
          sessions.forEach(s => { sessionMap[s.id] = { zone: s.zone }; });

          const { data: answers } = await supabase
            .from("audit_answers")
            .select("*")
            .in("session_id", sessionIds);

          if (answers) {
            answers.forEach(a => {
              const sess = sessionMap[a.session_id];
              if (!sess) return;
              const key = `${sess.zone}|${a.rubrique || "Questions"}|${a.question}`;
              answerMap[key] = a;

              if (a.image_url && !a.image_url.includes("undefined")) {
                parseImageUrls(a.image_url).forEach(url => {
                imagePromises.push(
                  fetch(url)
                    .then(r => r.blob())
                    .then(blob => {
                      const file = new File([blob], "img.jpg", { type: blob.type });
                      return readImageCompressed(file, 400, 0.7);
                    })
                    .then(img => {
                      if (!preloadedImages[a.id]) preloadedImages[a.id] = [];
                      preloadedImages[a.id].push(img);
                    })
                    .catch(() => {})
                );
                }); // end parseImageUrls forEach
              }
            });
          }
        }

        await Promise.all(imagePromises);

        const caMap = {};
        if (sessions && sessions.length > 0) {
          const sessionIds = sessions.map(s => s.id);
          const { data: caRows } = await supabase
            .from("corrective_actions")
            .select("zone, rubrique, question, responsable, action_required, due_date")
            .in("session_id", sessionIds);
          (caRows || []).forEach(ca => {
            if (!ca.zone) return;
            caMap[`${ca.zone}|${ca.rubrique || "Questions"}|${ca.question}`] = ca;
          });
        }

        const auditData = DICT_REVEY?.[atelier]?.[audit] || {};
        const tree = {};
        const zoneScores = {};
        let totalGood = 0, totalQ = 0;

        const safety = isSafetyAuditSelected();
        const filterZone = safety;

        for (const [zName, zoneData] of Object.entries(auditData)) {
          if (filterZone && zoneSelect.value && zName !== zoneSelect.value) continue;

          zoneScores[zName] = { good: 0, total: 0 };
          tree[zName] = {};

          const values = (typeof zoneData === "object" && zoneData !== null) ? Object.values(zoneData) : [];
          const isDirectQs = Array.isArray(zoneData);
          const isDirectRub = values.length > 0 && values.every(v => Array.isArray(v));

          if (isDirectQs || isDirectRub) {
            tree[zName]["Questions"] = {};
            const rubriquesObj = isDirectQs ? { "Questions": zoneData } : zoneData;

            for (const [rName, questions] of Object.entries(rubriquesObj)) {
              tree[zName]["Questions"][rName] = [];
              (Array.isArray(questions) ? questions : []).forEach(q => {
                const key = `${zName}|${rName}|${q}`;
                const ans = answerMap[key];
                const status = ans?.status || "";

                let isGood = false;
                let count = false;
                if (status !== "") {
                  if (safety) {
                    if (status !== "Non applicable") {
                      count = true;
                      if (status === "Oui") isGood = true;
                    }
                  } else {
                    count = true;
                    if (status === "Good" || status === "Oui" || status === "1") isGood = true;
                  }
                }

                if (count) {
                  totalQ++; zoneScores[zName].total++;
                  if (isGood) { totalGood++; zoneScores[zName].good++; }
                }

                tree[zName]["Questions"][rName].push({
                  id: ans?.id || null,
                  question: q,
                  status: ans?.status || "",
                  comment: ans?.comment || "",
                  image_url: ans?.image_url || null,
                  ca: caMap[`${zName}|${rName}|${q}`] || null,
                });
              });
            }
          } else {
            // Sous-zones
            for (const [szName, szData] of Object.entries(zoneData)) {
              tree[zName][szName] = {};
              const rubs = Array.isArray(szData) ? { "Questions": szData } : szData;

              for (const [rName, questions] of Object.entries(rubs)) {
                tree[zName][szName][rName] = [];
                (Array.isArray(questions) ? questions : []).forEach(q => {
                  const key = `${zName}|${rName}|${q}`;
                  const ans = answerMap[key];
                  const status = ans?.status || "";

                  let isGood = false;
                  let count = false;
                  if (status !== "") {
                    if (safety) {
                      if (status !== "Non applicable") {
                        count = true;
                        if (status === "Oui") isGood = true;
                      }
                    } else {
                      count = true;
                      if (status === "Good" || status === "Oui" || status === "1") isGood = true;
                    }
                  }

                  if (count) {
                    totalQ++; zoneScores[zName].total++;
                    if (isGood) { totalGood++; zoneScores[zName].good++; }
                  }

                  tree[zName][szName][rName].push({
                    id: ans?.id || null,
                    question: q,
                    status: ans?.status || "",
                    comment: ans?.comment || "",
                    image_url: ans?.image_url || null,
                    ca: caMap[`${zName}|${rName}|${q}`] || null,
                  });
                });
              }
            }
          }
        }

        // --- DRAW PDF ---
        const globalScore = totalQ > 0 ? Math.round((totalGood / totalQ) * 100) : 0;
        let currentPage = 1;
        addPageDesign(currentPage);

        let y = 50;
        doc.setTextColor(...colorSlate);
        doc.setFontSize(12);
        doc.setFont(undefined, "bold");
        doc.text("Informations générales consolidées", 14, y);
        y += 8;

        doc.setFontSize(10);
        doc.setFont(undefined, "normal");
        doc.text(`Atelier : ${atelier}`, 16, y);
        y += 6;
        doc.text(`Audit : ${audit}`, 16, y);
        y += 6;
        doc.text(`Auditeur : ${username}`, 16, y);
        y += 10;

        // Score Global Box — couleur dynamique selon le score
        const scoreBoxH = 24;
        const _scoreColor = globalScore >= 75 ? colorEmerald : globalScore >= 50 ? [234, 179, 8] : [239, 68, 68];
        const _scoreFill  = globalScore >= 75 ? [240, 253, 244] : globalScore >= 50 ? [254, 252, 232] : [254, 242, 242];
        doc.setFillColor(..._scoreFill);
        doc.setDrawColor(..._scoreColor);
        doc.setLineWidth(0.8);
        doc.roundedRect(14, y, pageWidth - 28, scoreBoxH, 3, 3, "FD");
        doc.setTextColor(..._scoreColor);
        doc.setFontSize(10);
        doc.setFont(undefined, "bold");
        doc.text("SCORE GLOBAL AUDIT", 22, y + scoreBoxH / 2 + 3);
        doc.setFontSize(20);
        doc.text(`${globalScore}%`, pageWidth - 18, y + scoreBoxH / 2 + 5, { align: "right" });
        doc.setFont(undefined, "normal");
        y += scoreBoxH + 8;

        // Tableau récapitulatif des scores par zone
        const zoneScoreRows = [];
        for (const [zn, sc] of Object.entries(zoneScores)) {
          const pct = sc.total > 0 ? Math.round((sc.good / sc.total) * 100) : 0;
          zoneScoreRows.push([zn, `${pct}%`]);
        }
        if (zoneScoreRows.length > 0) {
          doc.autoTable({
            startY: y,
            head: [["Zone", "Score"]],
            body: zoneScoreRows,
            margin: { left: 14, right: 14, top: 45, bottom: 20 },
            headStyles: { fillColor: colorSlate, textColor: 255, fontStyle: "bold", halign: "center" },
            styles: { fontSize: 9, cellPadding: 3, valign: "middle", lineWidth: 0.1, lineColor: [200, 200, 200] },
            alternateRowStyles: { fillColor: [248, 250, 252] },
            columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: 40, halign: "center", fontStyle: "bold" } },
            didParseCell: (data) => {
              if (data.section === "body" && data.column.index === 1) {
                const pct = parseInt(data.cell.raw);
                if (pct >= 75) { data.cell.styles.textColor = [5, 150, 105]; data.cell.styles.fillColor = [240, 253, 244]; }
                else if (pct >= 50) { data.cell.styles.textColor = [161, 98, 7]; data.cell.styles.fillColor = [254, 252, 232]; }
                else { data.cell.styles.textColor = [220, 38, 38]; data.cell.styles.fillColor = [254, 242, 242]; }
              }
            },
          });
          y = doc.lastAutoTable.finalY + 15;
        }

        // Detail Loop
        for (const [zName, souszones] of Object.entries(tree)) {
          if (y > pageHeight - 40) { doc.addPage(); currentPage++; addPageDesign(currentPage); y = 50; }

          // Zone header with score
          const zScore = zoneScores[zName];
          const zPct = zScore && zScore.total > 0 ? Math.round((zScore.good / zScore.total) * 100) : 0;

          // Zone header — bandeau pleine largeur
          doc.setFillColor(...colorEmerald);
          doc.roundedRect(10, y, pageWidth - 20, 12, 2, 2, "F");
          doc.setTextColor(255, 255, 255);
          doc.setFontSize(10);
          doc.setFont(undefined, "bold");
          doc.text(`Zone : ${zName}`, 14, y + 8);
          const _zBadgeFill = zPct >= 75 ? [240, 253, 244] : zPct >= 50 ? [254, 240, 138] : [254, 202, 202];
          const _zBadgeText = zPct >= 75 ? [5, 150, 105]   : zPct >= 50 ? [120, 80, 0]   : [185, 28, 28];
          doc.setFillColor(..._zBadgeFill);
          doc.roundedRect(pageWidth - 27, y + 2.5, 17, 7, 1.5, 1.5, "F");
          doc.setTextColor(..._zBadgeText);
          doc.setFontSize(8);
          doc.text(`${zPct}%`, pageWidth - 18.5, y + 7.5, { align: "center" });
          doc.setFont(undefined, "normal");
          y += 16;

          for (const [szName, rubriques] of Object.entries(souszones)) {
            if (szName !== "Questions" && szName !== "_direct") {
              if (y > pageHeight - 40) { doc.addPage(); currentPage++; addPageDesign(currentPage); y = 50; }
              doc.setFillColor(241, 245, 249);
              doc.setDrawColor(203, 213, 225);
              doc.setLineWidth(0.3);
              doc.roundedRect(10, y, pageWidth - 20, 9, 1.5, 1.5, "FD");
              doc.setTextColor(...colorSlate);
              doc.setFontSize(9);
              doc.setFont(undefined, "bold");
              doc.text(`Sous-zone : ${szName}`, 14, y + 6);
              doc.setFont(undefined, "normal");
              doc.setLineWidth(0.1);
              y += 13;
            }

            for (const [rName, rAnswers] of Object.entries(rubriques)) {
              if (y > pageHeight - 40) { doc.addPage(); currentPage++; addPageDesign(currentPage); y = 50; }
              // Rubrique — barre d'accent verte
              doc.setFillColor(...colorEmerald);
              doc.rect(10, y - 2, 2.5, 7, "F");
              doc.setTextColor(...colorSlate);
              doc.setFontSize(9);
              doc.setFont(undefined, "bold");
              doc.text(rName, 15, y + 3);
              doc.setFont(undefined, "normal");
              y += 9;

              const caByRow = {};
              rAnswers.forEach((ans, idx) => {
                if (ans.ca && (ans.status === "Unsatisfactory" || ans.status === "Non")) {
                  caByRow[idx] = ans.ca;
                }
              });

              const rows = [];
              const imagesMap = new Map();
              rAnswers.forEach((ans, rIdx) => {
                rows.push([ans.question, ans.status || "", ans.comment || "", ""]);
                if (preloadedImages[ans.id]?.length) {
                  imagesMap.set(rIdx, preloadedImages[ans.id]);
                }
              });

              const CA_BLOCK_H = 24;

              doc.autoTable({
                startY: y,
                head: [["Question", "Status", "Commentaire", "Image"]],
                body: rows,
                margin: { left: 10, right: 10, top: 30, bottom: 15 },
                didDrawPage: (data) => {
                  if (doc.internal.getNumberOfPages() > currentPage) {
                    currentPage++;
                    addPageDesign(currentPage);
                  }
                },
                headStyles: { fillColor: colorEmerald, textColor: 255, fontStyle: "bold", halign: "center" },
                styles: { fontSize: 8, cellPadding: 2, valign: "middle", lineWidth: 0.1, lineColor: [200, 200, 200] },
                bodyStyles: { minCellHeight: 20 },
                alternateRowStyles: { fillColor: [248, 250, 252] },
                columnStyles: { 0: { cellWidth: "auto" }, 1: { cellWidth: 20, halign: "center" }, 2: { cellWidth: 55 }, 3: { cellWidth: 25 } },
                didParseCell: (data) => {
                  if (data.section === "body") {
                    const ca = caByRow[data.row.index];
                    if (ca) {
                      const imgs = imagesMap.get(data.row.index);
                      const base = imgs?.length ? Math.max(20, imgs.length * 22) : 20;
                      data.cell.styles.minCellHeight = base + CA_BLOCK_H;
                      data.cell.styles.valign = "top";
                    } else if (data.column.index === 3) {
                      const imgs = imagesMap.get(data.row.index);
                      if (imgs?.length > 1) data.cell.styles.minCellHeight = imgs.length * 22;
                    }
                    if (data.column.index === 3) data.cell.text = [""];
                    if (data.column.index === 1) {
                      const val = data.cell.raw;
                      if (val === "Good" || val === "Oui") { data.cell.styles.textColor = [5, 150, 105]; data.cell.styles.fillColor = [240, 253, 244]; data.cell.styles.fontStyle = "bold"; }
                      if (val === "Unsatisfactory" || val === "Non") { data.cell.styles.textColor = [220, 38, 38]; data.cell.styles.fillColor = [254, 242, 242]; data.cell.styles.fontStyle = "bold"; }
                      if (val === "Non applicable") { data.cell.styles.textColor = [100, 116, 139]; data.cell.styles.fillColor = [248, 250, 252]; }
                    }
                  }
                },
                didDrawCell: (data) => {
                  if (data.section === "body" && data.column.index === 3) {
                    const imgs = imagesMap.get(data.row.index);
                    const ca = caByRow[data.row.index];
                    if (imgs?.length) {
                      const availH = data.cell.height - 4 - (ca ? CA_BLOCK_H : 0);
                      const imgW = data.cell.width - 4;
                      const imgH = Math.max(1, availH / imgs.length);
                      imgs.forEach((imgData, i) => {
                        doc.addImage(imgData, "JPEG", data.cell.x + 2, data.cell.y + 2 + i * imgH, imgW, imgH - 1);
                      });
                    }
                    if (ca) {
                      const bX = 10;
                      const bW = pageWidth - 20;
                      const bY = data.cell.y + data.cell.height - CA_BLOCK_H + 1;
                      const bH = CA_BLOCK_H - 2;

                      doc.setFillColor(255, 247, 237);
                      doc.setDrawColor(234, 88, 12);
                      doc.setLineWidth(0.4);
                      doc.rect(bX, bY, bW, bH, "FD");

                      doc.setFillColor(234, 88, 12);
                      doc.rect(bX, bY, 2.5, bH, "F");

                      doc.setTextColor(180, 50, 0);
                      doc.setFontSize(7.5);
                      doc.setFont(undefined, "bold");
                      doc.text("! ACTION CORRECTIVE REQUISE", bX + 5, bY + 5);

                      doc.setFontSize(7);
                      doc.setTextColor(60, 60, 60);
                      doc.setFont(undefined, "bold");
                      doc.text("Responsable :", bX + 5, bY + 11);
                      doc.setFont(undefined, "normal");
                      doc.text(ca.responsable || "—", bX + 29, bY + 11);

                      doc.setFont(undefined, "bold");
                      doc.text("Echeance :", bX + 95, bY + 11);
                      doc.setFont(undefined, "normal");
                      const caDate = ca.due_date ? new Date(ca.due_date).toLocaleDateString("fr-FR") : "—";
                      doc.text(caDate, bX + 112, bY + 11);

                      doc.setFont(undefined, "bold");
                      doc.text("Action :", bX + 5, bY + 17);
                      doc.setFont(undefined, "normal");
                      const actionLines = doc.splitTextToSize(ca.action_required || "—", bW - 22);
                      doc.text(actionLines[0] || "—", bX + 22, bY + 17);
                      if (actionLines[1]) doc.text(actionLines[1], bX + 22, bY + 21);

                      doc.setTextColor(0, 0, 0);
                      doc.setDrawColor(200, 200, 200);
                      doc.setLineWidth(0.1);
                      doc.setFont(undefined, "normal");
                    }
                  }
                },
              });
              y = doc.lastAutoTable.finalY + 12;
            }
          }

          // ✅ AJOUT SECTION "AUTRES" DANS LE PDF
          const remarkKey = `${zName}|Autres|Remarques`;
          const remarkAns = answerMap[remarkKey];
          if (remarkAns && remarkAns.comment && remarkAns.comment.trim() !== "") {
            const commentText = remarkAns.comment.trim();
            const splitText = doc.splitTextToSize(commentText, pageWidth - 40);
            const boxHeight = 15 + (splitText.length * 5); // Base 15 + 5 per line

            if (y > pageHeight - (boxHeight + 10)) { doc.addPage(); currentPage++; addPageDesign(currentPage); y = 50; }
            
            doc.setFillColor(248, 250, 252);
            doc.setDrawColor(200, 200, 200);
            doc.roundedRect(14, y, pageWidth - 28, boxHeight, 2, 2, "FD");
            
            doc.setTextColor(...colorSlate);
            doc.setFontSize(10);
            doc.setFont(undefined, "bold");
            doc.text("Autres (Remarques générales) :", 18, y + 8);
            
            doc.setFont(undefined, "normal");
            doc.setFontSize(9);
            doc.text(splitText, 18, y + 15);
            y += boxHeight + 10;
          }
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = `Rapport_Audit_Revey_${atelier.replace(/\s/g, "_")}--${audit.replace(/\s/g, "_")}--${zone.replace(/\s/g, "_")}--${timestamp}.pdf`;

        const pdfBlob = doc.output('blob');
        doc.save(fileName);

        try {
          const { error: uploadError } = await supabase.storage
            .from('reports')
            .upload(fileName, pdfBlob, {
              cacheControl: '3600',
              upsert: true,
              contentType: 'application/pdf'
            });

          if (uploadError) {
            console.error("Erreur lors de l'upload du rapport:", uploadError);
            alert("Le rapport a été téléchargé localement mais n'a pas pu être sauvegardé sur le serveur.");
          } else {
            showToast("✅ Rapport téléchargé et sauvegardé avec succès !");
            const { error: metadataError } = await supabase
              .from('audit_reports')
              .insert({
                user_id: userId,
                audit_name: `${atelier} — ${audit}`,
                filename: fileName,
                file_path: fileName,
                generated_at: new Date().toISOString(),
                score: globalScore,
                period: getCurrentAuditPeriod(audit)
              });

            if (metadataError) {
              console.error("Erreur lors de l'enregistrement des métadonnées:", metadataError);
            }

            // Notifier que l'audit est terminé (uniquement pour le rôle "auditeur")
            const userRole = sessionStorage.getItem("audit_user_role");
            if (userRole === "auditeur") {
              try {
                const { error: notifError } = await supabase.functions.invoke('notify-ca', {
                  body: {
                    auditor_name: username,
                    audit_name: `${atelier} — ${audit}`,
                    zone: zone || null,
                    date: dateStr,
                    company: "Revey",
                  },
                });
                if (notifError) console.error("[notify-audit-complete] Erreur:", notifError.message);
                else console.log("[notify-audit-complete] ✅ Notifications envoyées");
              } catch (notifErr) {
                console.error("[notify-audit-complete] Erreur réseau:", notifErr.message);
              }
            }
          }
        } catch (uploadErr) {
          console.error("Erreur upload:", uploadErr);
          alert("Le rapport a été téléchargé localement mais l'upload vers le serveur a échoué.");
        }
      } catch (err) {
        console.error(err);
        alert("Erreur PDF: " + err.message);
      } finally {
        hideLoading();
      }
    };

    await generatePDF();

  } catch (error) {
    console.error(error);
  }
});
/* ===================== PDF DOWNLOAD - SCORES COMPLETS (toutes zones) ===================== */
downloadScoreBtn?.addEventListener("click", async () => {
  const atelier = atelierSelect.value || "";
  const audit = auditSelect.value || "";
  const dateStr = new Date().toLocaleDateString("fr-FR").replace(/\//g, "-");

  if (!atelier || !audit) {
    alert("Veuillez d'abord sélectionner un atelier et un type d'audit.");
    return;
  }

  showLoading("Génération du fichier Excel...");

  try {
    const fullAuditName = `${atelier} — ${audit}`;
    const periodStartDate = getAuditPeriodStartDate(audit);

    // 1. Fetch sessions & answers
    const { data: sessions, error: sessErr } = await supabase
      .from("audit_sessions")
      .select("id, zone")
      .eq("audit", fullAuditName)
      .eq("user_id", userId)
      .gte("created_at", periodStartDate);

    const answerMap = {}; // "zone|rubrique|question" -> answer
    const caMap = {}; // "zone|rubrique|question" -> ca
    if (sessions && sessions.length > 0) {
      const sessionIds = sessions.map(s => s.id);
      const sessionMap = {};
      sessions.forEach(s => sessionMap[s.id] = { zone: s.zone });

      const { data: answers } = await supabase
        .from("audit_answers")
        .select("session_id, rubrique, question, status, comment")
        .in("session_id", sessionIds);

      if (answers) {
        answers.forEach(a => {
          const sess = sessionMap[a.session_id];
          if (!sess?.zone) return;
          const key = `${sess.zone}|${a.rubrique || "Questions"}|${a.question}`;
          answerMap[key] = a;
        });
      }
      
      const { data: caRows } = await supabase
        .from("corrective_actions")
        .select("zone, rubrique, question, responsable, action_required, due_date")
        .in("session_id", sessionIds);
        
      (caRows || []).forEach(ca => {
        if (!ca.zone) return;
        caMap[`${ca.zone}|${ca.rubrique || "Questions"}|${ca.question}`] = ca;
      });
    }

    // 2. Build complete list from DICT_REVEY
    const auditData = DICT_REVEY?.[atelier]?.[audit] || {};
    const excelData = [];

    const zoneScores = {};
    let totalGood = 0;
    let totalQ = 0;

    const filterBySelectedZone = isSafetyAuditSelected();
    for (const [zName, zoneData] of Object.entries(auditData)) {
      if (filterBySelectedZone && zoneSelect.value && zName !== zoneSelect.value) {
        continue;
      }

      zoneScores[zName] = { good: 0, total: 0 };

      // Helper function to process questions under a rubrique
      const processQuestions = (rName, questions) => {
        (Array.isArray(questions) ? questions : []).forEach(q => {
          const key = `${zName}|${rName}|${q}`;
          const ans = answerMap[key];

          const safety = isSafetyAuditSelected();
          let isGood = false;
          let countInTotal = false;

          const status = ans?.status || "";
          if (status !== "") {
            if (safety) {
              if (status !== "Non applicable") {
                countInTotal = true;
                if (status === "Oui") isGood = true;
              }
            } else {
              countInTotal = true;
              if (status === "Good" || status === "Oui" || status === "1") isGood = true;
            }
          }

          if (countInTotal) {
            totalQ++;
            zoneScores[zName].total++;
            if (isGood) {
              totalGood++;
              zoneScores[zName].good++;
            }
          }

          let actionText = "";
          let responsableText = "";
          let delaiText = "";

          if (status === "Unsatisfactory" || status === "Non applicable" || status === "Non") {
            const ca = caMap[key];
            if (ca) {
              actionText = ca.action_required || "";
              responsableText = ca.responsable || "";
              delaiText = ca.due_date || "";
            }
          }

          excelData.push({
            "Atelier": atelier,
            "Audit": audit,
            "Zone": zName,
            "Rubrique": rName,
            "Question": q,
            "Status": status,
            "Commentaire": ans?.comment || "",
            "Action Correctives": actionText,
            "Responsable": responsableText,
            "Delai": delaiText,
          });
        });
      };

      if (Array.isArray(zoneData)) {
        processQuestions("Questions", zoneData);
      } else if (typeof zoneData === "object" && zoneData !== null) {
        const values = Object.values(zoneData);
        const isDirectRubriques = values.length > 0 && values.every(v => Array.isArray(v));

        if (isDirectRubriques) {
          for (const [rName, questions] of Object.entries(zoneData)) {
            processQuestions(rName, questions);
          }
        } else {
          // Zone -> Sous-zone -> Rubrique -> Questions
          for (const [szName, szData] of Object.entries(zoneData)) {
            const rubriques = Array.isArray(szData) ? { "Questions": szData } : szData;
            for (const [rName, questions] of Object.entries(rubriques)) {
              processQuestions(rName, questions);
            }
          }
        }
      }

      const remarkKey = `${zName}|Autres|Remarques`;
      const remarkAns = answerMap[remarkKey];
      if (remarkAns && remarkAns.comment && remarkAns.comment.trim() !== "") {
        excelData.push({
          "Atelier": atelier,
          "Audit": audit,
          "Zone": zName,
          "Rubrique": "Autres",
          "Question": "Remarques générales",
          "Status": "Information",
          "Commentaire": remarkAns.comment.trim(),
          "Action Correctives": "",
          "Actions Préventives": "",
          "Responsable": "",
          "Delai": ""
        });
      }
    }

    // 3. Generate Excel file
    const workbook = XLSX.utils.book_new();

    // Sheet 1: Score (Summary)
    const username = localStorage.getItem("username") || "Auditeur";
    const globalScore = totalQ > 0 ? Math.round((totalGood / totalQ) * 100) : 0;

    const scoreData = [
      ["Informations générales", ""],
      ["Atelier", atelier],
      ["Audit", audit],
      ["Auditeur", username],
      ["Date", new Date().toLocaleDateString("fr-FR")],
      [],
      ["SCORE GLOBAL", `${globalScore}%`],
      [],
      ["Zone", "Score"]
    ];

    for (const [zName, zScore] of Object.entries(zoneScores)) {
      const pct = zScore.total > 0 ? Math.round((zScore.good / zScore.total) * 100) : 0;
      scoreData.push([zName, `${pct}%`]);
    }

    const worksheet = XLSX.utils.aoa_to_sheet(scoreData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Score");

    // Sheet 2: New "Rapport d'Audit" (WELL ORGANIZED)
    const reportData = excelData.map(row => ({
      "Atelier": row["Atelier"],
      "Audit": row["Audit"],
      "Zone": row["Zone"],
      "Rubrique": row["Rubrique"],
      "Question": row["Question"],
      "Status": row["Status"],
      "Commentaire": row["Commentaire"],
      "Actions Préventives": row["Actions Préventives"],
      "Action Correctives": row["Action Correctives"],
      "Responsable": row["Responsable"],
      "Delai": row["Delai"]
    }));
    const reportSheet = XLSX.utils.json_to_sheet(reportData);
    XLSX.utils.book_append_sheet(workbook, reportSheet, "Rapport d'Audit");

    // Auto-size columns for both sheets
    [worksheet, reportSheet].forEach(ws => {
      const data = XLSX.utils.sheet_to_json(ws);
      if (data.length === 0) return;
      const headers = Object.keys(data[0]);
      const maxWidths = headers.map(h => {
        let max = h.length;
        data.forEach(row => {
          const val = row[h] ? row[h].toString() : "";
          if (val.length > max) max = val.length;
        });
        return { wch: max + 2 };
      });
      ws["!cols"] = maxWidths;
    });

    XLSX.writeFile(workbook, `Score_Audit_Revey_${dateStr}.xlsx`);


  } catch (e) {
    console.error("Erreur Export Excel:", e);
    alert("Erreur Export Excel: " + e.message);
  } finally {
    hideLoading();
  }
});