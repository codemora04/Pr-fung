import { supabase } from "./supabase.js";
import { handleSupabaseError, clearAuditProgress } from "./utils.js";



document.getElementById("operatorName").textContent =
    "Bienvenue" ;

/* ===================== DOM REFERENCES ===================== */
const companySelect     = document.getElementById("companySelect");
const atelierContainer  = document.getElementById("atelierContainer");
const atelierSelect     = document.getElementById("atelierSelect");
const auditSelect       = document.getElementById("auditSelect");
const chartContainer    = document.getElementById("chartContainer");
const summaryContainer  = document.getElementById("summaryTableContainer");
const noDataMessage     = document.getElementById("noDataMessage");
const logoutBtn         = document.getElementById("logoutBtn");
const downloadBtn       = document.getElementById("downloadBtn");
const canvas            = document.getElementById("scoreChart");
const zoneSpeechBubble  = document.getElementById("zoneSpeechBubble");
const ctx               = canvas.getContext("2d");

let scoreChart  = null;
let DICT_BALTIMAR = null;
let DICT_REVEY    = null;

/* ===================== ZONE STRUCTURES ===================== */

// Sub-zones for general safety audits (used in speech bubble on chart click)
const SAFETY_SUBZONES = {
    "Accès Piétons":        ["Voie d'accès", "Sol", "Signalétique", "Éclairage"],
    "Accès Engins":         ["Voie d'accès", "Sol", "Signalétique", "Éclairage"],
    "Stockage Extérieur":   ["Conformité", "Propreté", "Organisation"],
    "Parking":              ["Marquage", "Signalétique", "État général"],
    "Zone de Déchargement": ["Sécurité", "Organisation", "Propreté"],
    "Vestiaires":           ["Propreté", "Équipements", "Ventilation"],
    "Sanitaires":           ["Propreté", "État", "Accessibilité"],
    "Réfectoire":           ["Hygiène", "Équipements", "Propreté"],
    "Bureaux":              ["Ergonomie", "Ordre", "Sécurité"],
    "Ateliers":             ["Machines", "Propreté", "Rangement", "EPI", "Ventilation"],
    "Stockage Intérieur":   ["Organisation", "Rayonnages", "Signalétique"],
    "Circulation Intérieure": ["Marquage", "Dégagements", "Signalétique"],
    "Issues de Secours":    ["Accessibilité", "Signalétique", "Fonctionnement"],
    "Extincteurs":          ["Présence", "Accessibilité", "Contrôle"],
    "Électricité":          ["Armoires", "Câblage", "Conformité"],
};

// Numbered factory zones with their sub-areas (used in the summary table)
const FACTORY_ZONES = {
    "Zone 1":  ["Stockage 1500", "Station de lavage"],
    "Zone 2":  ["Atelier chaudronnerie", "Atelier mécanique", "Atelier électrique"],
    "Zone 3":  ["Stockage C130", "Stockage 840", "Stockage 842"],
    "Zone 4":  ["Station traitement eaux usée", "Bassin des acides gras"],
    "Zone 5":  ["Chaufferie"],
    "Zone 6":  ["Fosse de dépotage", "Stockage fuel", "Cantine", "Pompe de dépotage"],
    "Zone 7":  ["Stockage propane", "Stockage bouteilles de gaz", "Poste de contrôle"],
    "Zone 8":  ["Vestiaire", "Poste Transfo"],
    "Zone 9":  ["Electrolyseur N°2/N°3"],
    "Zone 10": ["Local mezzanine préparation Révey", "Préparation Révey (pâte à tartiner)"],
    "Zone 11": ["Conditionnement Révey (pâte à tartiner)", "Frigo stockage fruits secs"],
    "Zone 12": ["Shortening (Conditionnement graisse végétale)", "Fritys (Conditionnement graisse végétale)"],
    "Zone 13": ["Raffinage 1 (graisse végétale)"],
    "Zone 14": ["Hydrogénation (graisse végétale)"],
    "Zone 15": ["Magazine matériel dépotage", "Magazine produits chimiques", "Magazine acide citrique",
                "Local Calorifuge", "Stockage emballage", "PDR", "Local Sel", "Local Puits"],
    "Zone 16": ["Mezzanine salle bleue (stockage emballage/matière)", "Salle bleue"],
    "Zone 17": ["Mezzanine Révey (stockage emballage)", "Magazine Révey emballage", "Magazine Révey consommables"],
    "Zone 18": ["Raffinage 2 (graisse végétale)"],
    "Zone 19": ["Stockage 65", "Barkining", "Administration"],
    "Zone 20": ["Bureau magasinier", "Bureau maintenance", "Bureau agent de sécurité"],
};

/* ===================== HELPERS ===================== */

function isSafetyAudit() {
    return (auditSelect.value || "").toLowerCase().includes("safety");
}

function resetAuditSelect(placeholder = "-- Choisir un audit --") {
    auditSelect.innerHTML = `<option value="">${placeholder}</option>`;
    auditSelect.disabled = true;
}

function hideChart() {
    chartContainer.classList.add("hidden");
    noDataMessage.classList.add("hidden");
    if (summaryContainer) summaryContainer.classList.add("hidden");
    if (zoneSpeechBubble) zoneSpeechBubble.classList.add("hidden");
}

function showChart() {
    chartContainer.classList.remove("hidden");
    if (summaryContainer) summaryContainer.classList.remove("hidden");
}

/* ===================== DATA LOADING ===================== */

async function loadDict(name) {
    const { data, error } = await supabase
        .from("app_data")
        .select("data")
        .eq("name", name)
        .single();

    if (error) {
        console.error("Cannot load dict:", name, error);
        return null;
    }
    return data?.data ?? null;
}

function populateAudits(dict) {
    if (!dict) {
        resetAuditSelect("Erreur de chargement");
        return;
    }
    auditSelect.innerHTML = `<option value="">-- Choisir un audit --</option>`;
    Object.keys(dict).forEach(audit => {
        const opt = document.createElement("option");
        opt.value = audit;
        opt.textContent = audit;
        auditSelect.appendChild(opt);
    });
    auditSelect.disabled = false;
}

/* ===================== FILTER: COMPANY ===================== */

companySelect.addEventListener("change", async () => {
    const company = companySelect.value;

    atelierContainer.style.display = "none";
    atelierSelect.innerHTML = `<option value="">-- Choisir un atelier --</option>`;
    resetAuditSelect("-- Sélectionner une entreprise d'abord --");
    hideChart();

    if (!company) return;

    if (company === "BALTIMAR") {
        if (!DICT_BALTIMAR) DICT_BALTIMAR = await loadDict("DICT_BALTIMAR");
        populateAudits(DICT_BALTIMAR);

    } else if (company === "REVEY") {
        if (!DICT_REVEY) DICT_REVEY = await loadDict("DICT_REVEY");

        if (DICT_REVEY) {
            Object.keys(DICT_REVEY).forEach(atelier => {
                const opt = document.createElement("option");
                opt.value = atelier;
                opt.textContent = atelier;
                atelierSelect.appendChild(opt);
            });
            atelierContainer.style.display = "block";
            resetAuditSelect("-- Choisir un atelier d'abord --");
        } else {
            resetAuditSelect("Erreur de chargement de Revey");
        }
    }
});

/* ===================== FILTER: ATELIER (Revey only) ===================== */

atelierSelect.addEventListener("change", () => {
    const atelier = atelierSelect.value;
    resetAuditSelect();
    hideChart();
    if (!atelier || !DICT_REVEY) return;
    populateAudits(DICT_REVEY[atelier]);
});

/* ===================== FILTER: AUDIT → FETCH & RENDER ===================== */

auditSelect.addEventListener("change", async () => {
    const audit = auditSelect.value;
    hideChart();
    if (!audit) return;

    // Determine valid zones for the selected company + atelier + audit
    const company = companySelect.value;
    const atelier = atelierSelect.value;
    let validZones = null;

    if (company === "BALTIMAR" && DICT_BALTIMAR) {
        const auditData = DICT_BALTIMAR[audit];
        if (auditData) validZones = Object.keys(auditData);
    } else if (company === "REVEY" && atelier && DICT_REVEY) {
        const auditData = DICT_REVEY[atelier]?.[audit];
        if (auditData) validZones = Object.keys(auditData);
    }


    const auditQueryName = (company === "REVEY" && atelier)
        ? `${atelier} — ${audit}`
        : audit;

    let sessionsQuery = supabase
        .from("audit_sessions")
        .select("id, zone, created_at")
        .eq("audit", auditQueryName)
        .order("created_at", { ascending: true });

    if (validZones?.length) {
        sessionsQuery = sessionsQuery.in("zone", validZones);
    }

    const { data: sessions, error: sessErr } = await sessionsQuery;

    if (sessErr || !sessions?.length) {
        noDataMessage.classList.remove("hidden");
        return;
    }

    const sessionIds = sessions.map(s => s.id);

    // 2. Fetch answers for those sessions
    const { data: answers, error: ansErr } = await supabase
        .from("audit_answers")
        .select("session_id, status")
        .in("session_id", sessionIds);

    if (ansErr || !answers?.length) {
        noDataMessage.classList.remove("hidden");
        return;
    }

    // 3. Build a lookup: session ID → { zone, formatted date }
    const sessionMap = {};
    const orderedLabels = [];

    sessions.forEach(s => {
        if (!s.zone || !s.created_at) return;
        const dateStr = new Date(s.created_at).toLocaleDateString("fr-FR", {
            month: "short",
            year: "numeric",
        });
        sessionMap[s.id] = { zone: s.zone, date: dateStr };
        if (!orderedLabels.includes(dateStr)) orderedLabels.push(dateStr);
    });

    // 4. Aggregate scores by date and zone
    const timelineStats = {};
    const uniqueZones = new Set();
    const safetyAudit = isSafetyAudit();

    answers.forEach(ans => {
        const info = sessionMap[ans.session_id];
        if (!info) return;

        const { zone, date } = info;

        if (!timelineStats[date])        timelineStats[date] = {};
        if (!timelineStats[date][zone])  timelineStats[date][zone] = { total: 0, good: 0 };
        uniqueZones.add(zone);

        // Pour les audits safety, "Non applicable" est exclu du calcul du score
        if (safetyAudit && ans.status === "Non applicable") return;

        timelineStats[date][zone].total++;
        const isGood = ans.status === "Good" || ans.status === "Oui" || ans.status === "1";
        if (isGood) timelineStats[date][zone].good++;
    });

    const labels      = orderedLabels;
    const zonesToChart = Array.from(uniqueZones);

    if (!labels.length || !zonesToChart.length) {
        noDataMessage.classList.remove("hidden");
        return;
    }

    // 5. Build one Chart.js dataset per zone
    const datasets = zonesToChart.map((zone, index) => {
        const color = `hsl(${(index * 137.5) % 360}, 70%, 50%)`;
        const dataPoints = labels.map(date => {
            const stats = timelineStats[date]?.[zone];
            if (!stats || stats.total === 0) return null;
            return Math.round((stats.good / stats.total) * 100);
        });
        return {
            label: zone,
            data: dataPoints,
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            tension: 0.3,
            spanGaps: true,
        };
    });

    renderChart(labels, datasets);
    renderSummaryTable(labels, timelineStats, zonesToChart);
    showChart();
});

/* ===================== RENDER: CHART ===================== */

function renderChart(labels, datasets) {
    if (scoreChart) scoreChart.destroy();

    Chart.defaults.color = "#475569";

    const colorBandsPlugin = {
        id: "colorBands",
        beforeDraw(chart) {
            const { ctx: c, chartArea, scales } = chart;
            if (!chartArea) return;
            const { top, bottom, left, right } = chartArea;
            const yScale = scales.y;
            const bands = [
                { from: 0,  to: 50,  color: "rgba(239,68,68,0.07)" },
                { from: 50, to: 75,  color: "rgba(245,158,11,0.07)" },
                { from: 75, to: 100, color: "rgba(34,197,94,0.07)" },
            ];
            bands.forEach(({ from, to, color }) => {
                const yFrom = yScale.getPixelForValue(from);
                const yTo   = yScale.getPixelForValue(to);
                c.fillStyle = color;
                c.fillRect(left, yTo, right - left, yFrom - yTo);
            });
        }
    };

    scoreChart = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets },
        plugins: [colorBandsPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            datasets: {
                bar: {
                    barPercentage: 0.4,
                    categoryPercentage: 0.5,
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    grid: {
                        color: (context) => {
                            if (context.tick.value === 75) return "rgba(34,197,94,0.45)";
                            if (context.tick.value === 50) return "rgba(245,158,11,0.45)";
                            return "rgba(0,0,0,0.08)";
                        },
                        lineWidth: (context) => {
                            if (context.tick.value === 50 || context.tick.value === 75) return 2;
                            return 1;
                        },
                    },
                    border: {
                        color: "rgba(0,0,0,0.2)",
                    },
                    ticks: {
                        stepSize: 10,
                        autoSkip: false,
                        callback: (value) => value + "%",
                        color: (context) => {
                            if (context.tick.value === 75) return "#16a34a";
                            if (context.tick.value === 50) return "#d97706";
                            return "#475569";
                        },
                        font: { size: 11 },
                        padding: 6,
                    },
                },
                x: {
                    grid: { color: "rgba(0,0,0,0.06)" },
                    border: {
                        color: "rgba(0,0,0,0.2)",
                    },
                    ticks: {
                        color: "#475569",
                        font: { size: 11 },
                        maxRotation: 45,
                        minRotation: 0,
                    },
                },
            },
            plugins: {
                legend: {
                    display: true,
                    position: "bottom",
                    labels: { color: "#000000" },
                },
                tooltip: {
                    callbacks: {
                        label: c => `${c.dataset.label}: ${c.parsed.y}%`,
                    },
                },
            },
            onClick: (e, elements, chart) => {
                if (!zoneSpeechBubble) return;

                if (!elements?.length) {
                    zoneSpeechBubble.classList.add("hidden");
                    return;
                }

                if (!isSafetyAudit()) {
                    zoneSpeechBubble.classList.add("hidden");
                    return;
                }

                const zone     = chart.data.datasets[elements[0].datasetIndex].label;
                const subzones = SAFETY_SUBZONES[zone];

                if (!subzones?.length) {
                    zoneSpeechBubble.classList.add("hidden");
                    return;
                }

                zoneSpeechBubble.innerHTML =
                    `<div class="bubble-title">${zone}</div>` +
                    `<ul class="bubble-list">` +
                    subzones.map(sz => `<li>${sz}</li>`).join("") +
                    `</ul>`;

                zoneSpeechBubble.classList.remove("hidden");
                zoneSpeechBubble.style.left = "-9999px";

                setTimeout(() => {
                    const x = e.native.pageX;
                    const y = e.native.pageY;
                    zoneSpeechBubble.style.left = `${x - zoneSpeechBubble.offsetWidth / 2}px`;
                    zoneSpeechBubble.style.top  = `${y - zoneSpeechBubble.offsetHeight - 15}px`;
                }, 0);
            },
        },
    });
}

/* ===================== RENDER: SUMMARY TABLE ===================== */

function renderSummaryTable(labels, timelineStats, zonesToChart) {
    const tableBody = document.getElementById("summaryTableBody");
    if (!tableBody) return;

    tableBody.innerHTML = "";

    if (!labels.length) {
        const emptyCell = document.createElement("td");
        emptyCell.colSpan = 2;
        emptyCell.textContent = "Aucune donnée disponible";
        const emptyRow = document.createElement("tr");
        emptyRow.appendChild(emptyCell);
        tableBody.appendChild(emptyRow);
        return;
    }

    const latestPeriod = [...labels].reverse().find(label =>
        zonesToChart.some(zone => (timelineStats[label]?.[zone]?.total ?? 0) > 0)
    ) ?? labels[labels.length - 1];
    const showSubzones = isSafetyAudit();

    zonesToChart.forEach(zone => {
        const stats = timelineStats[latestPeriod]?.[zone];
        const score = (stats && stats.total > 0) ? Math.round((stats.good / stats.total) * 100) : 0;

        // Main zone row
        const tr = document.createElement("tr");
        tr.className = "summary-zone-row";

        const tdZone = document.createElement("td");
        tdZone.className = "summary-zone-name";
        tdZone.textContent = zone;

        const tdScore = document.createElement("td");
        tdScore.className = "summary-zone-score";
        tdScore.textContent = `${score}%`;

        tr.appendChild(tdZone);
        tr.appendChild(tdScore);
        tableBody.appendChild(tr);

        // Sub-zone rows (safety audits only)
        if (showSubzones) {
            const subzones = FACTORY_ZONES[zone];
            subzones?.forEach(sz => {
                const subTr = document.createElement("tr");
                subTr.className = "summary-subzone-row";

                const tdSub = document.createElement("td");
                tdSub.className = "summary-subzone-name";
                tdSub.textContent = `↳ ${sz}`;

                const tdDash = document.createElement("td");
                tdDash.className = "summary-subzone-score";
                tdDash.textContent = "—";

                subTr.appendChild(tdSub);
                subTr.appendChild(tdDash);
                tableBody.appendChild(subTr);
            });
        }
    });
}

/* ===================== SPEECH BUBBLE: CLOSE ON OUTSIDE CLICK ===================== */

document.addEventListener("click", e => {
    if (e.target.id !== "scoreChart" && zoneSpeechBubble) {
        zoneSpeechBubble.classList.add("hidden");
    }
});

/* ===================== DOWNLOAD CHART ===================== */

downloadBtn.addEventListener("click", async () => {
    const auditName = auditSelect.value || "chart";
    const fileName  = `${Date.now()}_score-audit-${auditName.toLowerCase()}.png`;

    // Télécharger localement
    const link = document.createElement("a");
    link.download = `score-audit-${auditName.toLowerCase()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();

    // Envoyer automatiquement vers Supabase Storage (seulement si authentifié)
    if (fromParam !== "landing") {
        canvas.toBlob(async (blob) => {
            const { error: storageError } = await supabase.storage
                .from("reports")
                .upload(fileName, blob, { contentType: "image/png" });

            if (storageError) {
                console.error("Erreur upload graphique:", storageError);
                return;
            }

            const { data: urlData } = supabase.storage
                .from("reports")
                .getPublicUrl(fileName);

            const { data: { user } } = await supabase.auth.getUser();

            const { error: dbError } = await supabase
                .from("reports")
                .insert({
                    title:    `Graphique — ${auditName}`,
                    file_url: urlData.publicUrl,
                    user_id:  user?.id ?? null,
                    status:   "uploaded",
                });

            if (dbError) {
                console.error("Erreur enregistrement graphique:", dbError);
                return;
            }

            await loadDownloadHistory();
        }, "image/png");
    }
});



/* ===================== BACK BUTTON ===================== */

const fromParam = new URLSearchParams(window.location.search).get("from");
if (fromParam === "landing") {
    document.getElementById("backBtn").href = "landing.html";
} else {
    document.getElementById("backBtn").href = "accueil.html";
}

/* ===================== LOGOUT ===================== */

logoutBtn.addEventListener("click", async () => {
    sessionStorage.clear();
    clearAuditProgress();
    if (fromParam === "landing") {
        window.location.href = "landing.html";
    } else {
        await supabase.auth.signOut();
        window.location.href = "accueil.html";
    }
});