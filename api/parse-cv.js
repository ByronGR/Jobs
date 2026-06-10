// POST /api/parse-cv
// Server-side proxy: receives a CV as base64 JSON, sends it to the
// Affinda Resume Parser as multipart/form-data, returns structured data.
// The API key lives in process.env.AFFINDA_API_KEY (server-side only).

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const key = (process.env.AFFINDA_API_KEY || "").trim();
  if (!key) {
    return res.status(500).json({ ok: false, error: "AFFINDA_API_KEY not configured" });
  }

  // Vercel auto-parses JSON bodies into req.body; fall back to stream read.
  let payload = req.body;
  if (!payload || typeof payload !== "object") {
    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return res.status(400).json({ ok: false, error: "Could not parse request body as JSON" });
    }
  }

  const { data: base64, filename = "cv.pdf", mimeType = "application/octet-stream" } = payload;
  if (!base64 || typeof base64 !== "string") {
    return res.status(400).json({ ok: false, error: "Missing field: data (base64 file)" });
  }

  try {
    const fileBuffer = Buffer.from(base64, "base64");

    // RFC 2046 multipart/form-data — boundary must NOT include leading "--"
    const bnd  = `NearworkBnd${Date.now()}`;
    const CRLF = "\r\n";

    // Helper: text field part
    const textPart = (name, value) =>
      `--${bnd}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`;

    const multipart = Buffer.concat([
      Buffer.from(textPart("workspace",    "iKIEtiBE")),
      Buffer.from(textPart("documentType", "rcqSyqXA")),  // Resume Parser collection
      // File part header
      Buffer.from(
        `--${bnd}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
        `Content-Type: ${mimeType}${CRLF}${CRLF}`
      ),
      // Raw file bytes
      fileBuffer,
      // Closing boundary (CRLF after binary content + closing delimiter)
      Buffer.from(`${CRLF}--${bnd}--${CRLF}`),
    ]);

    const affRes = await fetch("https://api.us1.affinda.com/v3/documents", {
      method: "POST",
      headers: {
        Authorization:    `Bearer ${key}`,
        "Content-Type":   `multipart/form-data; boundary=${bnd}`,
        "Content-Length": String(multipart.length),
      },
      body: multipart,
    });

    if (!affRes.ok) {
      const errText = await affRes.text().catch(() => "");
      console.error("[parse-cv] Affinda HTTP", affRes.status, errText.slice(0, 400));
      return res.status(502).json({ ok: false, error: `Affinda returned ${affRes.status}`, detail: errText.slice(0, 200) });
    }

    const json = await affRes.json().catch(() => null);
    const d    = json?.data;

    if (!d) {
      return res.status(200).json({ ok: true, name: "", phone: "", city: "", summary: "", skills: [], workHistory: [], languages: [], certifications: [] });
    }

    // Affinda custom workspace uses singular field names: candidateName, phoneNumber, skill, language
    const nameObj  = d.candidateName || d.name || {};
    const name     = nameObj.raw || [nameObj.first, nameObj.last].filter(Boolean).join(" ") || "";
    const phoneArr = d.phoneNumber || d.phoneNumbers || [];
    const phone    = phoneArr[0]?.raw || phoneArr[0]?.rawText || phoneArr[0]?.value || "";
    const city     = d.location?.raw || d.location?.city || "";
    const summary  = (typeof d.summary === "string" ? d.summary : d.summary?.raw || d.objective?.raw || "").slice(0, 800);

    // Strip trailing punctuation/whitespace that Affinda sometimes includes
    const cleanSkill = (s) => String(s || "").replace(/[,.\s]+$/, "").replace(/^[,.\s]+/, "").trim();

    const rawWorkExp = d.workExperience || d.work_experience || d.WorkExperience || [];

    // Convert "Oct 2023", "2023-10-01", or similar to "YYYY-MM"
    const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    const toYearMonth = (s) => {
      if (!s) return "";
      const str = String(s);
      // ISO date: 2023-10-01 → 2023-10
      const iso = str.match(/(\d{4})-(\d{2})/);
      if (iso) return `${iso[1]}-${iso[2]}`;
      // "Oct 2023" or "October 2023"
      const mon = str.match(/([a-z]{3})[a-z]*[\s.,]+(\d{4})/i);
      if (mon) return `${mon[2]}-${String(MONTHS[mon[1].toLowerCase()] || 1).padStart(2, "0")}`;
      // Just a year: "2023"
      const yr = str.match(/\b(20\d{2})\b/);
      if (yr) return `${yr[1]}-01`;
      return "";
    };

    const workHistory = rawWorkExp
      .map((w) => {
        const p = w.parsed || {};
        const title   = p.workExperienceJobTitle?.raw    || p.workExperienceJobTitle?.parsed    || w.jobTitle    || w.job_title    || "";
        const company = p.workExperienceOrganization?.raw || p.workExperienceOrganization?.parsed || w.organization || w.company     || "";

        // Dates: try dedicated start/end fields first (Affinda custom workspace naming),
        // then combined workExperienceDates, then flat w.dates, then parse from raw text
        const startVal = p.workExperienceStartDate?.raw   || p.workExperienceStartDate?.parsed   ||
                         p.workExperienceDates?.parsed?.startDate || p.workExperienceDates?.startDate ||
                         w.dates?.startDate || "";
        const endVal   = p.workExperienceEndDate?.raw     || p.workExperienceEndDate?.parsed     ||
                         p.workExperienceDates?.parsed?.endDate   || p.workExperienceDates?.endDate   ||
                         w.dates?.endDate || "";
        const isCurrentFlag =
          p.workExperienceDates?.parsed?.isCurrent ??
          p.workExperienceDates?.isCurrent ??
          w.dates?.isCurrent ??
          (typeof endVal === "string" && /present|current|actualidad/i.test(endVal));

        // Fallback: extract first and second date from the raw entry text
        const rawText    = w.raw || "";
        const rawDates   = [...rawText.matchAll(/([A-Z][a-z]{2}\.?\s+\d{4}|\d{4})/g)].map((m) => m[0]);
        const fromFinal  = toYearMonth(startVal) || toYearMonth(rawDates[0]) || "";
        const isCurr     = isCurrentFlag || /present|current|actualidad/i.test(rawText.slice(-30));
        const toFinal    = isCurr && fromFinal ? "present" : (toYearMonth(endVal) || toYearMonth(rawDates[1]) || "");

        return { title, company, from: fromFinal, to: toFinal };
      })
      .filter((w) => w.title || w.company);

    // Skills — Affinda uses singular "skill", each entry has a .raw field
    const rawSkills = d.skill || d.skills || d.Skills || [];
    const skills = rawSkills
      .map((s) => cleanSkill(s.raw || s.name || s.text || s.value || ""))
      .filter((s) => s.length > 1);

    // Languages — Affinda uses singular "language"
    const rawLanguages = d.language || d.languages || d.Languages || [];
    const languages = rawLanguages
      .map((l) => cleanSkill(l.raw || l.name || l.rawText || l.value || ""))
      .filter(Boolean);

    // Certifications — check education entries too
    const rawCerts = d.certifications || d.Certifications || d.education || [];
    const certifications = rawCerts
      .map((c) => {
        const cname  = cleanSkill(c.raw || c.name || c.rawText || c.value || "");
        const issuer = c.organization || c.issuer || "";
        const date   = c.completionDate ? String(c.completionDate).slice(0, 7) : "";
        return { name: cname, issuer, date };
      })
      .filter((c) => c.name);

    return res.status(200).json({ ok: true, name, phone, city, summary, skills, workHistory, languages, certifications });

  } catch (e) {
    console.error("[parse-cv] error:", e?.message || String(e));
    return res.status(500).json({ ok: false, error: "Internal error: " + (e?.message || "") });
  }
}
