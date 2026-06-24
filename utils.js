/**
 * Nettoie uniquement les données d'audit des périodes expirées.
 * Les données de la période en cours sont conservées pour que l'auditeur
 * retrouve sa progression même après déconnexion/reconnexion.
 * @param {boolean} forceAll - Si true, supprime TOUT (réinitialisation complète)
 */
export function clearAuditProgress(forceAll = false) {
  const keysToRemove = [];

  // Toutes les périodes courantes possibles
  const currentPeriods = [
    getCurrentAuditPeriod("safety"),       // yearly  e.g. "2026"
    getCurrentAuditPeriod("5S"), // monthly e.g. "2026_04"
    getCurrentAuditPeriod("other"),        // bi-monthly e.g. "2026_04_P1"
  ];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);

    // Ne jamais supprimer le username — il sert à scoper les données
    if (key === "username") continue;

    const isAuditKey =
      key.startsWith("prog_") ||
      key.includes("_state") ||
      key.startsWith("revey_") ||
      key.startsWith("baltimar_");

    if (!isAuditKey) continue;

    if (forceAll) {
      keysToRemove.push(key);
      continue;
    }

    // Pour les clés de progression (prog_username_period_...),
    // on vérifie si la période est toujours courante
    if (key.startsWith("prog_")) {
      const belongsToCurrentPeriod = currentPeriods.some(p => key.includes(`_${p}_`));
      if (!belongsToCurrentPeriod) {
        keysToRemove.push(key);
      }
      // sinon on la garde
      continue;
    }

    // Pour les clés d'état (_state), on les conserve toujours
    // (elles permettent la restauration des sélections de l'auditeur)
    if (key.includes("_state")) continue;

    // Tout autre clé baltimar_*/revey_* de période expirée
    keysToRemove.push(key);
  }

  keysToRemove.forEach(key => localStorage.removeItem(key));
}

export function getCurrentAuditPeriod(auditName = "") {
  const now = new Date();
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const month = String(monthIndex + 1).padStart(2, '0');
  
  const nameLower = auditName.toLowerCase();
  
  if (nameLower.includes("safety")) {
    const quarter = Math.floor(monthIndex / 3) + 1;
    return `${year}`;
  }
  
  if (nameLower.includes("5S")) {
    return `${year}_${month}`;
  }

  const day = now.getDate();
  const period = day <= 15 ? 'P1' : 'P2';
  return `${year}_${month}_${period}`;
}


export function getAuditPeriodStartDate(auditName = "") {
  const now = new Date();
  const nameLower = auditName.toLowerCase();
  if (nameLower.includes("safety")) {
    return new Date(now.getFullYear(), 0, 1).toISOString();
  }
  
  if (nameLower.includes("5S")) {
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }

  const periodStartDay = now.getDate() <= 15 ? 1 : 16;
  return new Date(now.getFullYear(), now.getMonth(), periodStartDay).toISOString();
}

export async function compressImage(file, maxW = 1024, quality = 0.6) {
  if (!file || !file.type.startsWith("image/")) return file;

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

  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  return new File([blob], file.name, { type: "image/jpeg" });
}


export function showLoading(text = "Chargement...") {
  let overlay = document.getElementById("global-loader");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "global-loader";
    overlay.className = "loading-overlay";
    overlay.innerHTML = `
      <div class="spinner"></div>
      <div class="loading-text">${text}</div>
    `;
    document.body.appendChild(overlay);
  } else {
    overlay.querySelector(".loading-text").textContent = text;
    overlay.classList.remove("hidden");
  }
}

export function hideLoading() {
  const overlay = document.getElementById("global-loader");
  if (overlay) overlay.classList.add("hidden");
}


export function handleSupabaseError(error, customMsg = "Une erreur est survenue") {
  console.error(customMsg, error);
  hideLoading();
  alert(`${customMsg}: ${error.message || "Erreur réseau ou serveur"}`);
}

export function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-box">
        <p class="confirm-msg">${message}</p>
        <div class="confirm-btns">
          <button class="confirm-btn-cancel">Annuler</button>
          <button class="confirm-btn-ok">Télécharger</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector(".confirm-btn-ok").addEventListener("click", () => {
      overlay.remove();
      resolve(true);
    });
    overlay.querySelector(".confirm-btn-cancel").addEventListener("click", () => {
      overlay.remove();
      resolve(false);
    });
  });
}

export function showToast(message, type = "success", duration = 4000) {
  const existing = document.getElementById("global-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "global-toast";
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-hide");
    setTimeout(() => toast.remove(), 400);
  }, duration);
}
