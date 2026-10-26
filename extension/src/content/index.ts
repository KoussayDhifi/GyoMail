import type { Email } from "../types/email";
import { classifyEmails, classifyEmail } from "../api/client";

/* -------------------------------------------------------------------------- */
/* Types & constants                                                          */
/* -------------------------------------------------------------------------- */

type Classification = {
  email_id?: string;
  label: string;
  score: number;
  body_analyzed?: boolean;
  detected_language?: string;
  language_warning?: string | null;
};

type BadgeState =
  | "loading"
  | "phishing"
  | "legitimate"
  | "uncertain"
  | "error";

type BadgeEntry = {
  state: BadgeState;
  label?: string;
  score?: number;
  bodyAnalyzed?: boolean;
  detectedLanguage?: string;
  languageWarning?: string;
  updatedAt: number;
};

type Target = {
  email: Email;
  host: HTMLElement;
  mode: "after" | "prepend";
};

type StoredEmailResult = {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  timestamp: string;
  label: string;
  score: number;
  bodyAnalyzed?: boolean;
  detectedLanguage?: string;
  languageWarning?: string;
  updatedAt: number;
};

const BADGE_CLASS = "gyomail-badge";
const STYLE_ID = "gyomail-styles";
const STORAGE_PREFIX = "gyomail:";

const PHISHING_THRESHOLD = 0.75;
const LEGITIMATE_THRESHOLD = 0.65;

const SCAN_DEBOUNCE_MS = 250;
const ERROR_RETRY_MS = 30_000;

const LIST_ROW_SELECTOR = 'tr[data-mt-item="mt-list"], tr.zA';
const OPEN_MESSAGE_SELECTOR = ".adn.ads[data-legacy-message-id]";
const THREAD_ID_SELECTOR = "[data-thread-id], [data-legacy-thread-id]";

const cache = new Map<string, BadgeEntry>();
const inFlight = new Set<string>();
const retryAfter = new Map<string, number>();

/* -------------------------------------------------------------------------- */
/* Canonical ids                                                               */
/* -------------------------------------------------------------------------- */

// The inbox list identifies an email as "#thread-f:1880051001254616215"
// (decimal), while the opened email uses the same number in hex
// ("1a17486cb9661c97"). Both must be ONE entry, otherwise the result computed
// from the body never reaches the row in the list. BigInt is needed because the
// number is larger than 2^53.
const GMAIL_DOM_ID = /^#?(?:thread|msg)-[a-z]:(\d+)$/i;

function canonicalId(rawId: string): string {
  const id = rawId.trim();
  const match = GMAIL_DOM_ID.exec(id);

  if (match) return BigInt(match[1]).toString(16);

  return id.toLowerCase();
}

function keyOf(email: Email): string {
  return canonicalId(email.id);
}

/* -------------------------------------------------------------------------- */
/* Persistent popup reporting                                                 */
/* -------------------------------------------------------------------------- */

function getSender(email: Email): string {
  return email.sender.name || email.sender.email || "Unknown sender";
}

function getStoredLabel(entry: BadgeEntry): string {
  if (entry.state === "phishing") return "phishing";
  if (entry.state === "legitimate") return "legitimate";
  if (entry.state === "uncertain") return entry.label ?? "uncertain";
  return entry.state;
}

async function saveResult(
  email: Email,
  entry: BadgeEntry
): Promise<void> {
  // Don't count in-progress or failed analyses as completed results.
  if (entry.state === "loading" || entry.state === "error") {
    return;
  }

  const result: StoredEmailResult = {
    id: email.id,
    sender: getSender(email),
    subject: email.subject || "(No subject)",
    snippet: email.snippet || "",
    timestamp: email.timestamp || "",
    label: getStoredLabel(entry),
    score: entry.score ?? 0,
    bodyAnalyzed: entry.bodyAnalyzed ?? false,
    detectedLanguage: entry.detectedLanguage,
    languageWarning: entry.languageWarning,
    updatedAt: entry.updatedAt,
  };

  const storageKey = `${STORAGE_PREFIX}${canonicalId(email.id)}`;

  try {
    const stored = await chrome.storage.local.get(storageKey);
    const previous = stored[storageKey] as StoredEmailResult | undefined;

    // A result based on the full body is never replaced by a snippet-only one.
    if (previous?.bodyAnalyzed && !result.bodyAnalyzed) return;

    // The opened-email view has no snippet; keep the one saved from the list.
    if (!result.snippet && previous?.snippet) result.snippet = previous.snippet;

    await chrome.storage.local.set({ [storageKey]: result });
  } catch (error) {
    console.error("GyoMail: failed to save classification", error);
  }
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;

  style.textContent = `
    .gyomail-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: none;
      margin: 0 8px 0 6px;
      padding: 2px 9px;
      border-radius: 999px;
      font: 500 12px/1.4 Arial, sans-serif;
      white-space: nowrap;
      vertical-align: middle;
      position: relative;
      z-index: 2;
      cursor: default;
      user-select: none;
    }

    .gyomail-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .gyomail-phishing { color: #b42318; background: #fee4e2; }
    .gyomail-phishing .gyomail-dot { background: #dc2626; }

    .gyomail-legitimate { color: #067647; background: #dcfae6; }
    .gyomail-legitimate .gyomail-dot { background: #16a34a; }

    .gyomail-uncertain { color: #854d0e; background: #fef3c7; }
    .gyomail-uncertain .gyomail-dot { background: #eab308; }

    .gyomail-uncertain[data-label="phishing"] {
      color: #9a3412;
      background: #ffedd5;
    }

    .gyomail-uncertain[data-label="phishing"] .gyomail-dot {
      background: #f97316;
    }

    .gyomail-loading,
    .gyomail-error {
      color: #475467;
      background: #f2f4f7;
    }

    .gyomail-error .gyomail-dot { background: #98a2b3; }

    .gyomail-language-warning {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin: 3px 8px 3px 4px;
      padding: 4px 9px;
      border: 1px solid #f5c451;
      border-radius: 7px;
      color: #7a4b00;
      background: #fff7d6;
      font: 600 11px/1.4 Arial, sans-serif;
      vertical-align: middle;
      white-space: normal;
      max-width: 280px;
      cursor: help;
    }

    .gyomail-spinner {
      width: 10px;
      height: 10px;
      border: 2px solid #d0d5dd;
      border-top-color: #667085;
      border-radius: 50%;
      animation: gyomail-spin .7s linear infinite;
      flex-shrink: 0;
    }

    @keyframes gyomail-spin {
      to { transform: rotate(360deg); }
    }

    @media (prefers-reduced-motion: reduce) {
      .gyomail-spinner { animation: none; }
    }
  `;

  (document.head ?? document.documentElement).appendChild(style);
}

/* -------------------------------------------------------------------------- */
/* DOM parsing                                                                */
/* -------------------------------------------------------------------------- */

function getThreadId(root: ParentNode): string {
  const el = root.querySelector<HTMLElement>(THREAD_ID_SELECTOR);

  return (
    el?.getAttribute("data-thread-id") ??
    el?.getAttribute("data-legacy-thread-id") ??
    ""
  );
}

function collectListTargets(): Target[] {
  const targets: Target[] = [];

  document.querySelectorAll<HTMLElement>(LIST_ROW_SELECTOR).forEach((row) => {
    const senderElement = row.querySelector<HTMLElement>(
      ".yW span[email], .zF[email], .yW span[name], .zF"
    );

    const subjectElement = row.querySelector<HTMLElement>(
      ".bog .bqe, .bog span[data-thread-id], .bog"
    );

    const snippetElement = row.querySelector<HTMLElement>(".y2");
    const timestampElement =
      row.querySelector<HTMLElement>(".xW span[title]");

    const id = getThreadId(row);

    if (!senderElement || !subjectElement || !id) return;

    const subjectHost =
      subjectElement.closest<HTMLElement>(".y6") ??
      subjectElement.parentElement;

    if (!subjectHost) return;

    targets.push({
      host: subjectHost,
      mode: "prepend",
      email: {
        id,
        sender: {
          name:
            senderElement.getAttribute("name") ??
            senderElement.textContent?.trim() ??
            "",
          email: senderElement.getAttribute("email") ?? "",
        },
        subject: subjectElement.textContent?.trim() ?? "",
        snippet: snippetElement?.textContent?.trim() ?? "",
        timestamp: timestampElement?.getAttribute("title") ?? "",
        body: null,
      },
    });
  });

  return targets;
}

function collectOpenTargets(): Target[] {
  const targets: Target[] = [];

  const subject =
    document.querySelector<HTMLElement>("h2.hP")?.textContent?.trim() ?? "";

  document
    .querySelectorAll<HTMLElement>(OPEN_MESSAGE_SELECTOR)
    .forEach((messageElement) => {
      const id = messageElement.getAttribute("data-legacy-message-id") ?? "";
      const senderElement =
        messageElement.querySelector<HTMLElement>(".gD[email]");
      const bodyElement = messageElement.querySelector<HTMLElement>(".a3s");
      const timestampElement = messageElement.querySelector<HTMLElement>(".g3");

      const body = bodyElement?.innerText.trim() || null;

      // Wait until Gmail has rendered the message body.
      if (!id || !senderElement || !body) return;

      targets.push({
        host: senderElement,
        mode: "after",
        email: {
          id,
          sender: {
            name:
              senderElement.getAttribute("name") ??
              senderElement.textContent?.trim() ??
              "",
            email: senderElement.getAttribute("email") ?? "",
          },
          subject,
          snippet: "",
          timestamp:
            timestampElement?.getAttribute("title") ??
            timestampElement?.textContent?.trim() ??
            "",
          body,
        },
      });
    });

  return targets;
}

/* -------------------------------------------------------------------------- */
/* Badge rendering                                                             */
/* -------------------------------------------------------------------------- */

function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function badgeText(entry: BadgeEntry): string {
  switch (entry.state) {
    case "loading":
      return "Analyzing…";

    case "error":
      return "Analysis failed";

    case "phishing":
      return `${entry.bodyAnalyzed ? "Phishing" : "Potential Phishing"} · ${percent(
        entry.score ?? 0
      )}`;

    case "legitimate":
      return `${entry.bodyAnalyzed ? "Legitimate" : "Potentially Legitimate"} · ${percent(
        entry.score ?? 0
      )}`;

    case "uncertain": {
      const label = (entry.label ?? "").toLowerCase();
      let displayLabel: string;

      if (label === "phishing") {
        displayLabel = entry.bodyAnalyzed ? "Phishing" : "Potential Phishing";
      } else if (label === "legitimate") {
        displayLabel = entry.bodyAnalyzed
          ? "Legitimate"
          : "Potentially Legitimate";
      } else {
        displayLabel = "Uncertain";
      }

      return `${displayLabel} · ${percent(entry.score ?? 0)}`;
    }
  }
}

function signature(entry: BadgeEntry): string {
  return `${entry.state}|${entry.label ?? ""}|${entry.score ?? ""}|${entry.bodyAnalyzed ?? false}|${entry.detectedLanguage ?? ""}|${entry.languageWarning ?? ""}`;
}

function buildBadge(id: string, entry: BadgeEntry): HTMLElement {
  const badge = document.createElement("span");
  badge.className = `${BADGE_CLASS} gyomail-${entry.state}`;
  badge.dataset.gyomailId = id;
  badge.dataset.gyomailSig = signature(entry);
  badge.setAttribute("role", "status");

  if (entry.label) badge.dataset.label = entry.label;

  if (entry.state === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "gyomail-spinner";
    badge.append(spinner);
  } else {
    const dot = document.createElement("span");
    dot.className = "gyomail-dot";
    badge.append(dot);
  }

  badge.append(document.createTextNode(badgeText(entry)));

  if (entry.score !== undefined) {
    badge.title =
      `GyoMail: ${entry.label ?? ""} (${percent(entry.score)} confidence)`;
  }

  return badge;
}

function getSlotBadge(target: Target): HTMLElement | null {
  const slot =
    target.mode === "prepend"
      ? target.host.firstElementChild
      : target.host.nextElementSibling;

  return slot instanceof HTMLElement && slot.classList.contains(BADGE_CLASS)
    ? slot
    : null;
}

function ensureBadge(target: Target, entry: BadgeEntry): void {
  const id = target.email.id;
  const existing = getSlotBadge(target);

  if (
    existing &&
    existing.dataset.gyomailId === id &&
    existing.dataset.gyomailSig === signature(entry)
  ) {
    return;
  }

  existing?.remove();

  const badge = buildBadge(id, entry);

  if (target.mode === "prepend") target.host.prepend(badge);
  else target.host.after(badge);
}

function ensureLanguageWarning(target: Target, entry: BadgeEntry): void {
  const badge = getSlotBadge(target);
  const next = badge?.nextElementSibling;
  const existing =
    next instanceof HTMLElement &&
    next.classList.contains("gyomail-language-warning")
      ? next
      : null;

  if (!entry.languageWarning) {
    existing?.remove();
    return;
  }

  if (!badge) return;

  const warning = existing ?? document.createElement("span");
  warning.className = "gyomail-language-warning";
  warning.dataset.gyomailId = keyOf(target.email);
  warning.setAttribute("role", "note");
  warning.title = entry.languageWarning;
  warning.textContent =
    entry.detectedLanguage === "fr"
      ? "⚠ French detected · results may be less reliable"
      : `⚠ Language note: ${entry.languageWarning}`;

  if (!existing) badge.after(warning);
}

function removeOrphanBadges(validPairs: Target[]): void {
  const valid = new Set(validPairs.map(getSlotBadge));
  const validWarnings = new Set(
    validPairs
      .map(getSlotBadge)
      .map((badge) => badge?.nextElementSibling)
      .filter(
        (node): node is HTMLElement =>
          node instanceof HTMLElement &&
          node.classList.contains("gyomail-language-warning")
      )
  );

  document
    .querySelectorAll<HTMLElement>(`.${BADGE_CLASS}`)
    .forEach((badge) => {
      if (!valid.has(badge)) badge.remove();
    });

  document
    .querySelectorAll<HTMLElement>(".gyomail-language-warning")
    .forEach((warning) => {
      if (!validWarnings.has(warning)) warning.remove();
    });
}

/* -------------------------------------------------------------------------- */
/* Response handling                                                           */
/* -------------------------------------------------------------------------- */

function toEntry(result: Classification, bodyAnalyzed: boolean): BadgeEntry {
  const label = String(result.label ?? "").trim().toLowerCase();
  const score = Number(result.score);
  const updatedAt = Date.now();

  // Accept both the normalized language codes returned by the backend
  // ("fr", "en", "ar") and raw model labels ("fra_Latn", etc.).
  const rawLanguage = result.detected_language?.trim().toLowerCase();
  const detectedLanguage =
    rawLanguage === "fr" || rawLanguage?.startsWith("fra")
      ? "fr"
      : rawLanguage === "en" || rawLanguage?.startsWith("eng")
        ? "en"
        : rawLanguage === "ar" ||
            rawLanguage?.startsWith("arb") ||
            rawLanguage?.startsWith("ara")
          ? "ar"
          : rawLanguage;

  const languageWarning =
    result.language_warning?.trim() ||
    (detectedLanguage === "fr"
      ? "GyoMail's phishing detection may be less reliable for French emails."
      : undefined);

  // Helpful when checking whether the backend passes language metadata through.
  console.debug("GyoMail: language metadata", {
    emailId: result.email_id,
    detectedLanguage: result.detected_language,
    languageWarning: result.language_warning,
    normalizedLanguage: detectedLanguage,
  });

  if (!label || !Number.isFinite(score) || score < 0 || score > 1) {
    return { state: "error", updatedAt };
  }

  const languageMetadata = {
    detectedLanguage,
    languageWarning,
  };

  if (label === "phishing" && score >= PHISHING_THRESHOLD) {
    return {
      state: "phishing",
      label,
      score,
      bodyAnalyzed,
      ...languageMetadata,
      updatedAt,
    };
  }

  if (label === "legitimate" && score >= LEGITIMATE_THRESHOLD) {
    return {
      state: "legitimate",
      label,
      score,
      bodyAnalyzed,
      ...languageMetadata,
      updatedAt,
    };
  }

  return {
    state: "uncertain",
    label,
    score,
    bodyAnalyzed,
    ...languageMetadata,
    updatedAt,
  };
}

function getBatchResults(response: any): Classification[] {
  const data = response?.data ?? response;

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.Results)) return data.Results;
  if (Array.isArray(data?.results)) return data.results;

  return [];
}

function getSingleResult(response: any): Classification | null {
  const data = response?.data ?? response;
  const result = data?.classification ?? data;

  if (
    result &&
    typeof result.label === "string" &&
    result.score !== undefined
  ) {
    return result as Classification;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Classification pipeline                                                     */
/* -------------------------------------------------------------------------- */

// List requests (snippet) and open-email requests (body) are tracked
// separately, so a pending snippet request can never block the body request
// for the same email.
function flightKey(email: Email): string {
  return `${keyOf(email)}|${email.body === null ? "snippet" : "body"}`;
}

function needsClassification(email: Email): boolean {
  const key = keyOf(email);

  if (inFlight.has(flightKey(email))) return false;
  if ((retryAfter.get(key) ?? 0) > Date.now()) return false;

  const entry = cache.get(key);
  if (!entry) return true;
  if (entry.state === "error") return true;

  // The body always beats the snippet: redo a snippet-based result as soon as
  // the body is available. Rows in the list never trigger this.
  return email.body !== null && !entry.bodyAnalyzed;
}

function markLoading(emails: Email[]): void {
  for (const email of emails) {
    const key = keyOf(email);
    inFlight.add(flightKey(email));

    // Show "Analyzing…" only when there is nothing better to display yet.
    const current = cache.get(key);
    if (!current || current.state === "error") {
      cache.set(key, { state: "loading", updatedAt: Date.now() });
    }
  }
}

function setError(email: Email): void {
  const key = keyOf(email);
  retryAfter.set(key, Date.now() + ERROR_RETRY_MS);

  // Keep a usable earlier result (for example the snippet-based one) on screen.
  const current = cache.get(key);
  if (current && current.state !== "loading" && current.state !== "error") {
    return;
  }

  cache.set(key, { state: "error", updatedAt: Date.now() });
}

function putEntry(email: Email, entry: BadgeEntry): void {
  const key = keyOf(email);
  const current = cache.get(key);

  // A result based on the full body is never replaced by a snippet-only one.
  if (current?.bodyAnalyzed && !entry.bodyAnalyzed) return;

  cache.set(key, entry);
  retryAfter.delete(key);
}

/* -------------------------------------------------------------------------- */
/* Opened email -> list row                                                    */
/* -------------------------------------------------------------------------- */

function severity(entry: BadgeEntry): number {
  if (entry.state === "phishing") return 3;
  if (entry.state === "uncertain" && entry.label === "phishing") return 2;
  if (entry.state === "uncertain") return 1;
  return 0;
}

// The open conversation header carries the thread id. Verify these attribute
// names in DevTools (Elements -> h2.hP) if rows of long threads do not update.
function getOpenThreadId(): string {
  const header = document.querySelector<HTMLElement>("h2.hP");

  return (
    header?.getAttribute("data-legacy-thread-id") ??
    header?.getAttribute("data-thread-perm-id") ??
    ""
  );
}

// The list row represents the whole thread, but the body result belongs to one
// message. Copy it to the thread entry; with several messages the most severe
// verdict wins, so one phishing reply is never hidden by a legitimate one.
async function propagateToThread(
  email: Email,
  entry: BadgeEntry
): Promise<void> {
  const threadId = getOpenThreadId();
  if (!threadId) return;

  const threadEmail: Email = { ...email, id: threadId };
  if (keyOf(threadEmail) === keyOf(email)) return; // already the same entry

  const current = cache.get(keyOf(threadEmail));
  if (current?.bodyAnalyzed && severity(current) >= severity(entry)) return;

  putEntry(threadEmail, entry);
  await saveResult(threadEmail, entry);
}

async function classifyBatch(emails: Email[]): Promise<void> {
  try {
    const response = await classifyEmails(emails);
    const results = getBatchResults(response);
    const received = new Set<string>();
    const emailById = new Map(emails.map((email) => [email.id, email]));

    for (const result of results) {
      if (!result.email_id) continue;

      const email = emailById.get(result.email_id);
      if (!email) continue;

      received.add(result.email_id);

      // body_analyzed is true when the server already holds a result computed
      // from the full body (the user opened this email earlier).
      const entry = toEntry(result, result.body_analyzed === true);

      if (entry.state === "error") {
        setError(email);
        continue;
      }

      putEntry(email, entry);
      await saveResult(email, entry);
    }

    for (const email of emails) {
      if (!received.has(email.id)) setError(email);
    }

    console.log("GyoMail: classified inbox emails", results);
  } catch (error) {
    console.error("GyoMail: failed to classify inbox", error);
    emails.forEach((email) => setError(email));
  } finally {
    emails.forEach((email) => inFlight.delete(flightKey(email)));
    scheduleScan();
  }
}

async function classifySingle(email: Email): Promise<void> {
  try {
    const response = await classifyEmail(email);
    const result = getSingleResult(response);

    // This request carried the full body, so the result is body-based.
    const entry = result ? toEntry(result, true) : null;

    if (entry && entry.state !== "error") {
      putEntry(email, entry);
      await saveResult(email, entry);
      await propagateToThread(email, entry);
    } else {
      console.error("GyoMail: unexpected classification response", response);
      setError(email);
    }
  } catch (error) {
    console.error("GyoMail: failed to classify current email", error);
    setError(email);
  } finally {
    inFlight.delete(flightKey(email));
    scheduleScan();
  }
}

/* -------------------------------------------------------------------------- */
/* Scan loop                                                                   */
/* -------------------------------------------------------------------------- */

function renderTargets(targets: Target[]): void {
  for (const target of targets) {
    let entry = cache.get(keyOf(target.email));

    // An opened email must not show the snippet-based verdict while its own
    // body is being analyzed.
    if (
      entry &&
      target.email.body !== null &&
      !entry.bodyAnalyzed &&
      inFlight.has(flightKey(target.email))
    ) {
      entry = { state: "loading", updatedAt: entry.updatedAt };
    }

    if (entry) {
      ensureBadge(target, entry);
      ensureLanguageWarning(target, entry);
    }
  }
}

function scan(): void {
  const openTargets = collectOpenTargets();
  const listTargets = openTargets.length > 0 ? [] : collectListTargets();
  const targets = [...openTargets, ...listTargets];

  const fresh = targets.filter((target) =>
    needsClassification(target.email)
  );

  if (fresh.length > 0) {
    const listEmails = fresh
      .filter((target) => target.email.body === null)
      .map((target) => target.email);

    const openEmails = fresh
      .filter((target) => target.email.body !== null)
      .map((target) => target.email);

    markLoading([...listEmails, ...openEmails]);

    if (listEmails.length > 0) void classifyBatch(listEmails);

    openEmails.forEach((email) => void classifySingle(email));
  }

  renderTargets(targets);
  removeOrphanBadges(targets);
}

let scanTimer: number | undefined;

function scheduleScan(): void {
  if (scanTimer !== undefined) window.clearTimeout(scanTimer);

  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    scan();
  }, SCAN_DEBOUNCE_MS);
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                   */
/* -------------------------------------------------------------------------- */

function main(): void {
  installStyles();

  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      const nodes = [...mutation.addedNodes, ...mutation.removedNodes];

      return nodes.some(
        (node) =>
          !(
            node instanceof HTMLElement &&
            node.classList.contains(BADGE_CLASS)
          )
      );
    });

    if (relevant) scheduleScan();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  window.addEventListener("hashchange", scheduleScan);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleScan();
  });

  scheduleScan();
}

main();