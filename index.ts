// @ts-nocheck — Deno runtime types, not available in the VS Code TS server
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BREVO_API_KEY        = Deno.env.get("BREVO_API_KEY")!;
const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL_SENDER_EMAIL   = Deno.env.get("EMAIL_SENDER_EMAIL") || "noreply@qualite.com";
const EMAIL_SENDER_NAME    = Deno.env.get("EMAIL_SENDER_NAME")  || "Gestion Qualité";

// Seul ce rôle reçoit les notifications « audit terminé »
const ROLE_AUTORISE = "auditeur";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sendBrevoEmail(to: { email: string; name?: string }, subject: string, htmlContent: string) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: { name: EMAIL_SENDER_NAME, email: EMAIL_SENDER_EMAIL },
      to: [to],
      subject,
      htmlContent,
    }),
  });
  return { ok: res.ok, status: res.status };
}

// Construit le HTML d'une notification de non-conformité (réutilisé pour le
// responsable ET pour l'auteur de l'action).
function buildNonConformiteHtml({
  headerTitle,
  greetingName,
  intro,
  zone,
  question,
  action_required,
  priority,
  dueFr,
  created_by,
}: {
  headerTitle: string;
  greetingName: string;
  intro: string;
  zone?: string;
  question?: string;
  action_required?: string;
  priority?: string;
  dueFr: string;
  created_by?: string;
}) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:#f59e0b;padding:20px 24px;">
        <h1 style="margin:0;font-size:18px;color:#0f172a;">${headerTitle}</h1>
      </div>
      <div style="padding:24px;">
        <p>Bonjour <strong>${greetingName}</strong>,</p>
        <p>${intro}</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          ${zone ? `<tr><td style="padding:8px 0;color:#94a3b8;">Zone</td><td style="padding:8px 0;"><strong>${zone}</strong></td></tr>` : ""}
          <tr><td style="padding:8px 0;color:#94a3b8;">Non-conformité</td><td style="padding:8px 0;">${question || "-"}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Action requise</td><td style="padding:8px 0;"><strong>${action_required || "-"}</strong></td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Priorité</td><td style="padding:8px 0;">${priority || "-"}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Date limite</td><td style="padding:8px 0;"><strong style="color:#f59e0b;">${dueFr}</strong></td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Signalé par</td><td style="padding:8px 0;">${created_by || "-"}</td></tr>
        </table>
        <p style="font-size:12px;color:#64748b;margin-top:24px;">Système de Gestion Qualité</p>
      </div>
    </div>
  `;
}

// Construit le HTML envoyé à l'auteur de l'action lorsqu'elle est clôturée
// par son responsable.
function buildClotureHtml({
  greetingName,
  responsable,
  zone,
  question,
  action_required,
  dueFr,
}: {
  greetingName: string;
  responsable: string;
  zone?: string;
  question?: string;
  action_required?: string;
  dueFr: string;
}) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:#10b981;padding:20px 24px;">
        <h1 style="margin:0;font-size:18px;color:#fff;">✅ Action clôturée</h1>
      </div>
      <div style="padding:24px;">
        <p>Bonjour <strong>${greetingName}</strong>,</p>
        <p><strong>${responsable}</strong>, à qui vous aviez attribué cette action, l'a <strong>clôturée</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          ${zone ? `<tr><td style="padding:8px 0;color:#94a3b8;">Zone</td><td style="padding:8px 0;"><strong>${zone}</strong></td></tr>` : ""}
          <tr><td style="padding:8px 0;color:#94a3b8;">Non-conformité</td><td style="padding:8px 0;">${question || "-"}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Action</td><td style="padding:8px 0;"><strong>${action_required || "-"}</strong></td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Échéance</td><td style="padding:8px 0;">${dueFr}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Clôturée par</td><td style="padding:8px 0;"><strong>${responsable}</strong></td></tr>
        </table>
        <p style="font-size:12px;color:#64748b;margin-top:24px;">Système de Gestion Qualité</p>
      </div>
    </div>
  `;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const payload = await req.json();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── CAS 1 : Audit terminé (auditor_name présent) ──────────────────────────
    if (payload.auditor_name) {
      const { auditor_name, audit_name, zone, date, company } = payload;

      // On récupère aussi le rôle pour pouvoir filtrer les auditeurs.
      const { data: users, error: dbError } = await supabase
        .from("authorized_users")
        .select("email, username, role")
        .not("email", "is", null);

      if (dbError) throw new Error(`DB error: ${dbError.message}`);

      // On garde uniquement les utilisateurs qui ont un email ET dont le rôle
      // est « auditeur » (comparaison insensible à la casse).
      const usersWithEmail = (users ?? []).filter(
        (u) => u.email && (u.role ?? "").toLowerCase() === ROLE_AUTORISE
      );

      if (usersWithEmail.length === 0) {
        return new Response(JSON.stringify({ success: true, sent: 0 }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      const htmlContent = `
        <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:12px;overflow:hidden;">
          <div style="background:#10b981;padding:20px 24px;">
            <h1 style="margin:0;font-size:18px;color:#fff;">✅ Audit terminé</h1>
          </div>
          <div style="padding:24px;">
            <p>Bonjour,</p>
            <p><strong>${auditor_name}</strong> a terminé l'audit suivant :</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:8px 0;color:#94a3b8;">Société</td><td style="padding:8px 0;"><strong>${company}</strong></td></tr>
              <tr><td style="padding:8px 0;color:#94a3b8;">Audit</td><td style="padding:8px 0;">${audit_name}</td></tr>
              <tr><td style="padding:8px 0;color:#94a3b8;">Date</td><td style="padding:8px 0;">${date}</td></tr>
            </table>
            <p>Le rapport est disponible dans la section <strong>Historiques</strong>.</p>
            <p style="font-size:12px;color:#64748b;margin-top:24px;">Système de Gestion Qualité</p>
          </div>
        </div>
      `;

      const results = await Promise.all(
        usersWithEmail.map(async (u) => {
          const result = await sendBrevoEmail(
            { email: u.email, name: u.username },
            `Audit terminé — ${audit_name} (${company})`,
            htmlContent
          );
          if (result.ok) {
            console.log("[EMAIL] ✅ Envoyé →", u.email);
          } else {
            console.error("[EMAIL] ❌ Échec →", u.email, "| status:", result.status);
          }
          return { email: u.email, ...result };
        })
      );

      const failed = results.filter((r) => !r.ok);
      return new Response(
        JSON.stringify({ success: true, sent: results.length, failed: failed.length, results }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // ── CAS 2 : Action corrective ────────────────────────────────────────────
    const { responsable, action_required, due_date, priority, audit_name, question, created_by, zone } = payload;

    // Date limite formatée (réutilisée dans les emails).
    const dueFr = due_date
      ? new Date(due_date).toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" })
      : "-";

    // Le payload est une CLÔTURE si le frontend envoie ce drapeau.
    const isCloture = payload.cloturee === true || payload.event === "cloture";

    // ── CAS 2b : Action clôturée par le responsable → notifier l'AUTEUR ───────
    if (isCloture) {
      if (!created_by) {
        return new Response(
          JSON.stringify({ error: "Le champ 'created_by' (auteur de l'action) est requis pour une clôture." }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const { data: creator, error: creatorError } = await supabase
        .from("authorized_users")
        .select("username, email")
        .eq("username", created_by)
        .single();

      if (creatorError || !creator) {
        return new Response(
          JSON.stringify({ error: "Auteur de l'action introuvable.", details: creatorError }),
          { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      if (!creator.email) {
        console.log("[EMAIL] ⚠️ Aucun email pour l'auteur", created_by, "— email non envoyé.");
        return new Response(
          JSON.stringify({ success: true, sent: 0, reason: "Auteur sans email" }),
          { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const htmlCloture = buildClotureHtml({
        greetingName: creator.username,
        responsable: responsable || "Le responsable",
        zone,
        question,
        action_required,
        dueFr,
      });

      const clotureResult = await sendBrevoEmail(
        { email: creator.email, name: creator.username },
        `[Action clôturée] ${action_required || "Action corrective"} — ${audit_name || "Audit"}`,
        htmlCloture
      );

      if (clotureResult.ok) {
        console.log("[EMAIL] ✅ Clôture envoyée à l'auteur → status:", clotureResult.status, "| à:", creator.email);
      } else {
        console.error("[EMAIL] ❌ Échec clôture → status:", clotureResult.status);
      }

      return new Response(
        JSON.stringify({ success: true, results: { created_by: { email: creator.email, ...clotureResult } } }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // ── CAS 2a : Action assignée → notifier le RESPONSABLE ────────────────────
    if (!responsable) {
      return new Response(
        JSON.stringify({ error: "Le champ 'responsable' ou 'auditor_name' est requis." }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const { data: user, error: userError } = await supabase
      .from("authorized_users")
      .select("username, email")
      .eq("username", responsable)
      .single();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Utilisateur introuvable.", details: userError }),
        { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const results: Record<string, unknown> = {};

    if (user.email) {
      const htmlResponsable = buildNonConformiteHtml({
        headerTitle: "⚠️ Non-conformité assignée",
        greetingName: user.username,
        intro: "Une non-conformité vous a été assignée et nécessite votre action.",
        zone,
        question,
        action_required,
        priority,
        dueFr,
        created_by,
      });

      const emailResult = await sendBrevoEmail(
        { email: user.email, name: user.username },
        `[Non-conformité] Action requise — ${audit_name || "Audit"}`,
        htmlResponsable
      );

      if (emailResult.ok) {
        console.log("[EMAIL] ✅ Envoyé au responsable → status:", emailResult.status, "| à:", user.email);
      } else {
        console.error("[EMAIL] ❌ Échec responsable → status:", emailResult.status);
      }
      results.responsable = { email: user.email, ...emailResult };
    } else {
      console.log("[EMAIL] ⚠️ Aucun email pour le responsable", responsable, "— email non envoyé.");
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );

  } catch (err) {
    console.error("[notify-ca] ❌ Erreur inattendue:", (err as Error).message, (err as Error).stack);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
});
