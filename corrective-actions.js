import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase.js";
import { compressImage } from "./utils.js";

// ── MULTI-SELECT COMPONENT ────────────────────────────────────────────────────
export function buildMultiSelect(existingValues = []) {
  const wrapper = document.createElement("div");
  wrapper.className = "ms-wrapper";
  wrapper.innerHTML = `
    <button type="button" class="ms-trigger">
      <span class="ms-display ms-placeholder">-- Choisir un responsable --</span>
      <span class="ms-chevron">▾</span>
    </button>
    <div class="ms-dropdown" style="display:none;">
      <div class="ms-search-wrap">
        <input type="text" class="ms-search" placeholder="🔍 Rechercher…">
      </div>
      <div class="ms-options-list"></div>
    </div>
  `;

  const trigger  = wrapper.querySelector(".ms-trigger");
  const display  = wrapper.querySelector(".ms-display");
  const dropdown = wrapper.querySelector(".ms-dropdown");
  const searchEl = wrapper.querySelector(".ms-search");
  const optsList = wrapper.querySelector(".ms-options-list");

  let allNames = [];
  let selected = new Set(existingValues.filter(Boolean));

  function updateDisplay() {
    const arr = [...selected];
    if (arr.length === 0) {
      display.textContent = "-- Choisir un responsable --";
      display.classList.add("ms-placeholder");
    } else {
      display.textContent = arr.join(", ");
      display.classList.remove("ms-placeholder");
    }
  }

  function renderOptions(filter = "") {
    const lc = filter.toLowerCase();
    const visible = allNames.filter(n => !lc || n.toLowerCase().includes(lc));
    if (!visible.length) {
      optsList.innerHTML = `<div class="ms-empty">Aucun résultat</div>`;
      return;
    }
    optsList.innerHTML = visible.map(n => `
      <label class="ms-option${selected.has(n) ? " ms-selected" : ""}">
        <input type="checkbox" value="${n}"${selected.has(n) ? " checked" : ""}>
        ${n}
      </label>
    `).join("");
    optsList.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(cb.value);
        else selected.delete(cb.value);
        cb.closest(".ms-option").classList.toggle("ms-selected", cb.checked);
        updateDisplay();
      });
    });
  }

  trigger.addEventListener("click", e => {
    e.stopPropagation();
    const isOpen = dropdown.style.display !== "none";
    // Close all other open dropdowns first
    document.querySelectorAll(".ms-dropdown").forEach(d => { d.style.display = "none"; });
    document.querySelectorAll(".ms-trigger.ms-open").forEach(t => t.classList.remove("ms-open"));
    if (!isOpen) {
      dropdown.style.display = "block";
      trigger.classList.add("ms-open");
      searchEl.value = "";
      renderOptions();
      searchEl.focus();
    }
  });

  searchEl.addEventListener("input", () => renderOptions(searchEl.value));

  document.addEventListener("click", e => {
    if (!wrapper.contains(e.target)) {
      dropdown.style.display = "none";
      trigger.classList.remove("ms-open");
    }
  });

  wrapper.populate = names => {
    allNames = names;
    selected = new Set([...selected].filter(n => names.includes(n)));
    renderOptions();
    updateDisplay();
  };
  wrapper.getValues = () => [...selected];
  wrapper.getValue  = () => [...selected].join(", ");
  wrapper.reset     = () => { selected.clear(); updateDisplay(); renderOptions(); };

  updateDisplay();
  return wrapper;
}


export function isNonSatisfactory(statusValue) {
  return statusValue === "3" || statusValue === "non";
}

export function requiresCA(statusValue) {
  return statusValue === "3" || statusValue === "non" || statusValue === "na";
}


export function computeEffectiveStatus(dbStatus, dueDate) {
  if (dbStatus === "Closed") return "Closed";
  if (!dueDate) return dbStatus || "Open";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return due < today ? "Late" : (dbStatus || "Open");
}

const STATUS_CFG = {
  "Open":        { color: "#3b82f6", bg: "rgba(59,130,246,0.12)",  label: "Open" },
  "In Progress": { color: "#f97316", bg: "rgba(249,115,22,0.12)",  label: "In Progress" },
  "Late":        { color: "#ef4444", bg: "rgba(239,68,68,0.12)",   label: "Late" },
  "Closed":      { color: "#10b981", bg: "rgba(16,185,129,0.12)",  label: "Closed" },
};

export function getStatusCfg(status) {
  return STATUS_CFG[status] || { color: "#64748b", bg: "rgba(100,116,139,0.12)", label: status };
}

// ── SUPABASE QUERIES ──────────────────────────────────────────────────────────

export async function loadResponsables() {
  const { data, error } = await supabase
    .from("authorized_users")
    .select("username")
    .order("username");
  if (error) { console.error("loadResponsables:", error); return []; }
  return (data || []).map(u => u.username);
}

export async function loadCorrectiveActionsForSession(sessionId) {
  if (!sessionId) return [];
  const { data, error } = await supabase
    .from("corrective_actions")
    .select("*")
    .eq("session_id", sessionId);
  if (error) { console.error("loadCAForSession:", error); return []; }
  return data || [];
}

export async function loadMyCorrectiveActions(username) {
  const { data, error } = await supabase
    .from("corrective_actions")
    .select("*")
    .ilike("responsable", `%${username.trim()}%`)
    .order("date_created", { ascending: false });
  if (error) throw error;
  return (data || []).filter(a =>
    a.responsable?.split(",").some(r => r.trim().toLowerCase() === username.trim().toLowerCase())
  );
}

export async function loadAllCorrectiveActions() {
  const { data, error } = await supabase
    .from("corrective_actions")
    .select("*")
    .order("date_created", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function saveCorrectiveAction(caData) {
  const { id, ...fields } = caData;
  if (id) {
    const { data, error } = await supabase
      .from("corrective_actions")
      .update(fields)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase
    .from("corrective_actions")
    .insert(fields)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateCorrectiveActionStatus(id, fields) {
  const { data, error } = await supabase
    .from("corrective_actions")
    .update(fields)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── STORAGE ───────────────────────────────────────────────────────────────────

export async function uploadClosureEvidence(file) {
  const compressed = await compressImage(file, 1600, 0.75);
  const ext = (compressed.name.split(".").pop() || "jpg").toLowerCase();
  const filePath = `closure/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from("corrective-actions")
    .upload(filePath, compressed, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage
    .from("corrective-actions")
    .getPublicUrl(filePath);
  return data.publicUrl;
}

// ── AUDIT IMAGES ─────────────────────────────────────────────────────────────

export async function loadAuditImagesForActions(actions) {
  if (!actions.length) return new Map();
  const sessionIds = [...new Set(actions.map(a => a.session_id).filter(Boolean))];
  if (!sessionIds.length) return new Map();

  const { data, error } = await supabase
    .from("audit_answers")
    .select("session_id, rubrique, question, image_url")
    .in("session_id", sessionIds)
    .not("image_url", "is", null);

  if (error) { console.error("loadAuditImagesForActions:", error); return new Map(); }

  const map = new Map();
  for (const row of (data || [])) {
    if (!row.image_url) continue;
    let urls = [];
    if (row.image_url.startsWith("[")) {
      try { urls = JSON.parse(row.image_url); } catch {}
    } else {
      urls = [row.image_url];
    }
    const key = `${row.session_id}|${row.rubrique || ""}|${row.question}`;
    map.set(key, urls);
  }
  return map;
}

// ── AUDIT-SIDE FORM ROW ───────────────────────────────────────────────────────

/**
 * Build a <tr class="ca-form-row"> that is inserted after a question row.
 * Returns the <tr> element; call .classList.remove("hidden") to show it.
 *
 * @param {object} opts
 *   colspan     {number}      - columns in the table (3 desktop / 4 mobile)
 *   existingCA  {object|null}
 *   sessionInfo {object}      - {sessionId, auditName, zone, sousZone, rubrique, question}
 *   createdBy   {string}      - auditor username
 */
export function createCAFormRow({ colspan, existingCA, sessionInfo, createdBy }) {
  const caRow = document.createElement("tr");
  caRow.className = "ca-form-row hidden";

  const td = document.createElement("td");
  td.colSpan = colspan;

  td.innerHTML = `
    <div class="ca-form-container">
      <div class="ca-form-header">
        <span class="ca-form-title">⚠️ Action Corrective Requise</span>
        <span class="ca-priority-badge ca-priority-${(existingCA?.priority || "Medium").toLowerCase()}">${existingCA?.priority || "Medium"}</span>
      </div>
      <div class="ca-form-fields">
        <div class="ca-field-row">
          <div class="ca-field-group">
            <label class="ca-label">Responsable *</label>
            <div class="ca-responsable-wrap"></div>
          </div>
          <div class="ca-field-group">
            <label class="ca-label">Priorité</label>
            <select class="ca-input ca-priority">
              <option value="Low"   ${existingCA?.priority === "Low"    ? "selected" : ""}>Low</option>
              <option value="Medium"${!existingCA?.priority || existingCA.priority === "Medium" ? " selected" : ""}>Medium</option>
              <option value="High"  ${existingCA?.priority === "High"   ? "selected" : ""}>High</option>
            </select>
          </div>
          <div class="ca-field-group">
            <label class="ca-label">Date limite </label>
            <input type="date" class="ca-input ca-due-date" value="${existingCA?.due_date || ""}">
          </div>
        </div>
        <div class="ca-field-group ca-field-full">
          <label class="ca-label">Action corrective requise *</label>
          <textarea class="ca-input ca-action" rows="2" placeholder="Décrivez l'action corrective à réaliser…">${existingCA?.action_required || ""}</textarea>
        </div>
        <div class="ca-field-group ca-field-full">
          <label class="ca-label">Commentaire (facultatif)</label>
          <input type="text" class="ca-input ca-comment" placeholder="Commentaire optionnel…" value="${existingCA?.non_conformity_comment || ""}">
        </div>
        <div class="ca-form-actions">
          <button class="ca-save-btn" type="button">💾 Sauvegarder l'action</button>
          <span class="ca-status-msg"></span>
        </div>
      </div>
    </div>
  `;

  caRow.appendChild(td);

  let caId = existingCA?.id || null;
  const saveBtn       = td.querySelector(".ca-save-btn");
  const statusMsg     = td.querySelector(".ca-status-msg");
  const actionEl      = td.querySelector(".ca-action");
  const dueDateEl     = td.querySelector(".ca-due-date");
  const priorityEl    = td.querySelector(".ca-priority");
  const commentEl     = td.querySelector(".ca-comment");
  const priorityBadge = td.querySelector(".ca-priority-badge");

  // Build multi-select for responsable
  const existingResp = existingCA?.responsable
    ? existingCA.responsable.split(",").map(r => r.trim()).filter(Boolean)
    : [];
  const msEl = buildMultiSelect(existingResp);
  td.querySelector(".ca-responsable-wrap").appendChild(msEl);

  // Populate responsable options from DB
  loadResponsables().then(names => msEl.populate(names));

  // Sync priority badge color on change
  priorityEl.addEventListener("change", () => {
    priorityBadge.className = `ca-priority-badge ca-priority-${priorityEl.value.toLowerCase()}`;
    priorityBadge.textContent = priorityEl.value;
  });

  if (caId) {
    statusMsg.textContent = "✓ Action corrective déjà sauvegardée";
    statusMsg.style.color = "#10b981";
  }

  saveBtn.addEventListener("click", async () => {
    const responsables = msEl.getValues();
    const responsable  = msEl.getValue();   // comma-separated string for DB
    const action       = actionEl.value.trim();
    const dueDate      = dueDateEl.value;

    if (!responsables.length || !action) {
      alert("Veuillez remplir : Responsable(s) et Action corrective.");
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "⏳ Sauvegarde…";
    statusMsg.textContent = "";

    try {
      const isNew = !caId;

      const payload = {
        ...(caId ? { id: caId } : {}),
        session_id:             sessionInfo.sessionId,
        audit_name:             sessionInfo.auditName,
        zone:                   sessionInfo.zone   || null,
        sous_zone:              sessionInfo.sousZone || null,
        rubrique:               sessionInfo.rubrique || null,
        question:               sessionInfo.question,
        non_conformity_comment: commentEl.value.trim() || null,
        responsable,
        action_required:        action,
        priority:               priorityEl.value,
        due_date:               dueDate,
        created_by:             createdBy,
        ...(!caId ? { status: "Open", date_created: new Date().toISOString() } : {}),
      };

      const result = await saveCorrectiveAction(payload);
      caId = result.id;

      // Notification email à chaque responsable (nouvelle action uniquement)
      if (isNew) {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token || SUPABASE_ANON_KEY;

        let allOk = true;
        for (const resp of responsables) {
          try {
            const r = await fetch(`${SUPABASE_URL}/functions/v1/notify-ca`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                responsable:     resp,
                action_required: action,
                due_date:        dueDate,
                priority:        priorityEl.value,
                zone:            sessionInfo.zone      || null,
                audit_name:      sessionInfo.auditName || null,
                question:        sessionInfo.question  || null,
                created_by:      createdBy             || null,
              }),
            });
            const data = await r.json();
            console.log(`[notify-ca] ${resp} — status:`, r.status, JSON.stringify(data));
            if (!r.ok) allOk = false;
          } catch (e) {
            console.error(`[notify-ca] ${resp} — Erreur réseau:`, e.message);
            allOk = false;
          }
        }
        statusMsg.textContent = allOk ? "✓ Sauvegardé — Email(s) envoyé(s)" : "✓ Sauvegardé — ⚠️ Certains emails n'ont pas été envoyés";
        statusMsg.style.color = allOk ? "#10b981" : "#f97316";
      }

      saveBtn.disabled = false;
      saveBtn.textContent = "💾 Sauvegarder l'action";
      if (!isNew) {
        statusMsg.textContent = "✓ Sauvegardé avec succès";
        statusMsg.style.color = "#10b981";
      }
      setTimeout(() => { statusMsg.textContent = ""; }, 5000);
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = "💾 Sauvegarder l'action";
      statusMsg.textContent = "✗ Erreur : " + (e.message || e);
      statusMsg.style.color = "#ef4444";
    }
  });

  return caRow;
}
