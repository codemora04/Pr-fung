import { supabase } from "./supabase.js";

/* ===================== AUTH CHECK ===================== */

const { data: sessionData } = await supabase.auth.getSession();
if (!sessionData.session) window.location.href = "login.html";

/* ===================== HELPERS ===================== */

let allHistoryFiles = [];
let DICT_REVEY = null;

async function loadReveyDict() {
    const { data } = await supabase
        .from("app_data")
        .select("data")
        .eq("name", "DICT_REVEY")
        .single();
    DICT_REVEY = data?.data ?? null;
}

function parseReveyOldFormat(filename) {
    if (!DICT_REVEY) return null;
    const prefix = "Rapport_Audit_Revey_";
    if (!filename.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    const rest = filename.slice(prefix.length);

    for (const atelier of Object.keys(DICT_REVEY)) {
        const atelierPat = atelier.replace(/\s/g, "_");
        if (!rest.toLowerCase().startsWith(atelierPat.toLowerCase() + "_")) continue;
        const afterAtelier = rest.slice(atelierPat.length + 1);

        for (const audit of Object.keys(DICT_REVEY[atelier] || {})) {
            const auditPat = audit.replace(/\s/g, "_");
            if (!afterAtelier.toLowerCase().startsWith(auditPat.toLowerCase() + "_")) continue;
            const afterAudit = afterAtelier.slice(auditPat.length + 1);

            const tsMatch = afterAudit.match(/^(.+?)_(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.pdf$/i);
            if (tsMatch) {
                return {
                    company: "revey",
                    atelier,
                    audit,
                    zone: tsMatch[1].replace(/_/g, " "),
                };
            }
        }
    }
    return null;
}

function parseReportMeta(filename) {
    const bMatch = filename.match(/^Rapport_Audit_Baltimar_(.+?)_(\d{4}-\d{2}-\d{2}T[\d-]+Z)_(.+?)\.pdf$/i);
    if (bMatch) {
        return {
            company: "baltimar",
            atelier: null,
            audit: bMatch[1].replace(/_/g, " "),
            zone: bMatch[3].replace(/_/g, " "),
        };
    }

    // New Revey format (uses -- as field separator)
    const rMatchNew = filename.match(/^Rapport_Audit_Revey_(.+?)--(.+?)--(.+?)--(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.pdf$/i);
    if (rMatchNew) {
        return {
            company: "revey",
            atelier: rMatchNew[1].replace(/_/g, " "),
            audit: rMatchNew[2].replace(/_/g, " "),
            zone: rMatchNew[3].replace(/_/g, " "),
        };
    }

    // Old Revey format: use DICT_REVEY to resolve ambiguous _ separators
    const dictParsed = parseReveyOldFormat(filename);
    if (dictParsed) return dictParsed;

    const lc = filename.toLowerCase();
    return {
        company: lc.includes("baltimar") ? "baltimar" : lc.includes("revey") ? "revey" : null,
        atelier: null,
        audit: null,
        zone: null,
    };
}

function populateHistoryFilters(subset) {
    const auditEl = document.getElementById("histFilterAudit");
    const zoneEl  = document.getElementById("histFilterZone");
    if (!auditEl || !zoneEl) return;

    const audits = new Set();
    const zones  = new Set();
    subset.forEach(({ meta }) => {
        if (meta.audit) audits.add(meta.audit);
        if (meta.zone)  zones.add(meta.zone);
    });

    const curAudit = auditEl.value;
    const curZone  = zoneEl.value;

    auditEl.innerHTML = `<option value="">Tous</option>`;
    Array.from(audits).sort().forEach(a => {
        const opt = document.createElement("option");
        opt.value = a.toLowerCase();
        opt.textContent = a;
        auditEl.appendChild(opt);
    });

    zoneEl.innerHTML = `<option value="">Toutes</option>`;
    Array.from(zones).sort().forEach(z => {
        const opt = document.createElement("option");
        opt.value = z.toLowerCase();
        opt.textContent = z;
        zoneEl.appendChild(opt);
    });

    if (curAudit) auditEl.value = curAudit;
    if (curZone)  zoneEl.value  = curZone;
}

function renderHistoryList(files) {
    const historyList = document.getElementById("downloadHistoryList");
    if (!historyList) return;

    if (!files.length) {
        historyList.innerHTML = `<p class="hist-empty">Aucun rapport correspondant aux filtres.</p>`;
        return;
    }

    historyList.innerHTML = files.map(({ file, meta }) => {
        const { data: urlData } = supabase.storage.from("reports").getPublicUrl(file.name);
        const date = new Date(file.created_at).toLocaleString("fr-FR", {
            day: "2-digit", month: "short", year: "numeric",
            hour: "2-digit", minute: "2-digit"
        });
        const title = file.name.replace(/^\d+_/, "").replace(/[-_]/g, " ").replace(/\.\w+$/, "");

        const companyBadge = meta.company
            ? `<span class="hist-badge hist-badge-${meta.company}">${meta.company === "baltimar" ? "Baltimar" : "Revey"}</span>`
            : "";

        const atelierBadge = meta.atelier
            ? `<span class="hist-badge hist-badge-atelier">${meta.atelier}</span>`
            : "";

        const auditBadge = meta.audit
            ? `<span class="hist-badge hist-badge-audit">${meta.audit}</span>`
            : "";

        return `
        <div class="hist-item">
            <div class="hist-item-left">
                <div class="hist-item-title-row">
                    <span class="hist-item-title">📄 ${title}</span>
                    ${companyBadge}${atelierBadge}${auditBadge}
                </div>
                <span class="hist-item-date">${date}</span>
            </div>
            <a href="${urlData.publicUrl}" target="_blank" rel="noopener" class="hist-open-btn">
                Ouvrir →
            </a>
        </div>`;
    }).join("");
}

function applyHistoryFilters() {
    const companyVal = (document.getElementById("histFilterCompany")?.value || "").toLowerCase();
    const auditVal   = (document.getElementById("histFilterAudit")?.value   || "").toLowerCase();
    const zoneVal    = (document.getElementById("histFilterZone")?.value    || "").toLowerCase();

    const filtered = allHistoryFiles.filter(({ meta }) => {
        if (companyVal && meta.company !== companyVal) return false;
        if (auditVal   && (!meta.audit || meta.audit.toLowerCase() !== auditVal)) return false;
        if (zoneVal    && (!meta.zone  || meta.zone.toLowerCase()  !== zoneVal))  return false;
        return true;
    });

    renderHistoryList(filtered);
}

async function loadDownloadHistory() {
    const historyList = document.getElementById("downloadHistoryList");
    if (!historyList) return;

    await loadReveyDict();

    const { data, error } = await supabase.storage
        .from("reports")
        .list("", { limit: 100, sortBy: { column: "created_at", order: "desc" } });

    if (error) {
        console.error("Erreur chargement rapports:", error);
        historyList.innerHTML = `<p class="hist-error">Erreur : ${error.message}</p>`;
        return;
    }

    const files = (data || []).filter(f => f.name && f.id && f.name !== ".emptyFolderPlaceholder");

    if (!files.length) {
        historyList.innerHTML = `<p class="hist-empty">Aucun rapport d'audit enregistré.</p>`;
        return;
    }

    allHistoryFiles = files.map(file => ({ file, meta: parseReportMeta(file.name) }));
    populateHistoryFilters(allHistoryFiles);
    applyHistoryFilters();

    const companyEl = document.getElementById("histFilterCompany");
    const auditEl   = document.getElementById("histFilterAudit");
    const zoneEl    = document.getElementById("histFilterZone");

    [companyEl, auditEl, zoneEl].forEach(el => {
        if (el && !el.dataset.listenerAttached) {
            el.addEventListener("change", () => {
                if (el === companyEl) {
                    const cv = el.value.toLowerCase();
                    const subset = cv ? allHistoryFiles.filter(({ meta }) => meta.company === cv) : allHistoryFiles;
                    populateHistoryFilters(subset);
                }
                applyHistoryFilters();
            });
            el.dataset.listenerAttached = "1";
        }
    });
}

/* ===================== INIT ===================== */

loadDownloadHistory();
