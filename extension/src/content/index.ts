import type { Email } from "../types/email";
import { classifyEmails, classifyEmail } from "../api/client";

/* -------------------------------------------------------------------------- */
/*  Types & constants                                                          */
/* -------------------------------------------------------------------------- */

type Classification = {
  email_id?: string;
  label: string;
  score: number;
  body_analyzed?: boolean;
};

type BadgeState =
  | "loading"
  | "phishing"
  | "legitimate"
  | "uncertain"
  | "error";

type BadgeEntry = {
  state: BadgeState;
  label?: string; // normalized lowercase label ("phishing" | "legitimate" | ...)
  score?: number; // 0..1
  updatedAt: number;
};

type Target = {
  email: Email;
  host: HTMLElement;
  // "after":   badge is inserted right after `host`
  // "prepend": badge is inserted as the first child of `host`
  mode: "after" | "prepend";
};

const BADGE_CLASS = "gyomail-badge";
const STYLE_ID = "gyomail-styles";

const PHISHING_THRESHOLD = 0.75;
const LEGITIMATE_THRESHOLD = 0.65;

const SCAN_DEBOUNCE_MS = 250;
const ERROR_RETRY_MS = 30_000;

const LIST_ROW_SELECTOR = 'tr[data-mt-item="mt-list"], tr.zA';
const OPEN_MESSAGE_SELECTOR = ".adn.ads[data-legacy-message-id]";
const THREAD_ID_SELECTOR = "[data-thread-id], [data-legacy-thread-id]";

/**
 * Results live outside the DOM. Gmail re-renders its DOM constantly and wipes
 * anything we inject, so the cache is the source of truth and badges are
 * simply re-applied from it whenever they go missing.
 */
const cache = new Map<string, BadgeEntry>();

/* -------------------------------------------------------------------------- */
/*  Styles                                                                     */
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

    /* Likely phishing: orange. Likely legitimate keeps the yellow above. */
    .gyomail-uncertain[data-label="phishing"] {
      color: #9a3412;
      background: #ffedd5;
    }
    .gyomail-uncertain[data-label="phishing"] .gyomail-dot { background: #f97316; }

    .gyomail-loading,
    .gyomail-error { color: #475467; background: #f2f4f7; }
    .gyomail-error .gyomail-dot { background: #98a2b3; }

    .gyomail-spinner {
      width: 10px;
      height: 10px;
      border: 2px solid #d0d5dd;
      border-top-color: #667085;
      border-radius: 50%;
      animation: gyomail-spin .7s linear infinite;
      flex-shrink: 0;
    }

    @keyframes gyomail-spin { to { transform: rotate(360deg); } }

    @media (prefers-reduced-motion: reduce) {
      .gyomail-spinner { animation: none; }
    }
  `;

  (document.head ?? document.documentElement).appendChild(style);
}

/* -------------------------------------------------------------------------- */
/*  DOM parsing                                                                */
/* -------------------------------------------------------------------------- */

function getThreadId(root: ParentNode): string {
  const el = root.querySelector<HTMLElement>(THREAD_ID_SELECTOR);
  return (
    el?.getAttribute("data-thread-id") ??
    el?.getAttribute("data-legacy-thread-id") ??
    ""
  );
}

/** Inbox / list view: one target per visible row. */
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
    const timestampElement = row.querySelector<HTMLElement>(".xW span[title]");

    const id = getThreadId(row);

    if (!senderElement || !subjectElement || !id) return;

    // Badge sits between the sender and the subject: it is placed as the
    // first child of the subject container (.y6), right before the subject.
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

/** Opened conversation: one target per expanded message. */
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

      // Body not rendered yet: wait for a later scan instead of sending nothing.
      const body = bodyElement?.innerText.trim() || null;

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
/*  Badge rendering (idempotent)                                               */
/* -------------------------------------------------------------------------- */

function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function badgeText(entry: BadgeEntry): string {
  switch (entry.state) {
    case "loading":
      return "Analyzing…";
    case "error":
      return "Analysis failed";
    case "phishing":
      return `Phishing · ${percent(entry.score ?? 0)}`;
    case "legitimate":
      return `Legitimate · ${percent(entry.score ?? 0)}`;
    case "uncertain":
      return `Likely ${capitalize(entry.label ?? "unknown")} · ${percent(
        entry.score ?? 0
      )}`;
  }
}

function signature(entry: BadgeEntry): string {
  return `${entry.state}|${entry.label ?? ""}|${entry.score ?? ""}`;
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
    badge.title = `GyoMail: ${entry.label ?? ""} (${percent(entry.score)} confidence)`;
  }

  return badge;
}

/**
 * Make sure the badge directly after `anchor` reflects `entry`.
 * Does nothing when the DOM is already correct, so re-running it on every
 * Gmail mutation is cheap and cannot cause an observer loop.
 */
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

/** Remove duplicate/orphan badges Gmail may have left when recycling rows. */
function removeOrphanBadges(validPairs: Target[]): void {
  const valid = new Set(validPairs.map(getSlotBadge));

  document
    .querySelectorAll<HTMLElement>(`.${BADGE_CLASS}`)
    .forEach((badge) => {
      if (!valid.has(badge)) badge.remove();
    });
}

/* -------------------------------------------------------------------------- */
/*  Response handling                                                          */
/* -------------------------------------------------------------------------- */

function toEntry(result: Classification): BadgeEntry {
  const label = String(result.label ?? "").trim().toLowerCase();
  const score = Number(result.score);
  const updatedAt = Date.now();

  if (!label || !Number.isFinite(score) || score < 0 || score > 1) {
    return { state: "error", updatedAt };
  }

  if (label === "phishing" && score >= PHISHING_THRESHOLD) {
    return { state: "phishing", label, score, updatedAt };
  }

  if (label === "legitimate" && score >= LEGITIMATE_THRESHOLD) {
    return { state: "legitimate", label, score, updatedAt };
  }

  return { state: "uncertain", label, score, updatedAt };
}

function getBatchResults(response: any): Classification[] {
  // Supports a raw array or the backend's {"Results": [...]} response.
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
/*  Classification pipeline                                                    */
/* -------------------------------------------------------------------------- */

const inFlight = new Set<string>();

function needsClassification(id: string): boolean {
  if (inFlight.has(id)) return false;

  const entry = cache.get(id);
  if (!entry) return true;

  // Retry failed analyses after a cool-down.
  return entry.state === "error" && Date.now() - entry.updatedAt > ERROR_RETRY_MS;
}

function markLoading(emails: Email[]): void {
  for (const email of emails) {
    inFlight.add(email.id);
    cache.set(email.id, { state: "loading", updatedAt: Date.now() });
  }
}

function setError(id: string): void {
  cache.set(id, { state: "error", updatedAt: Date.now() });
}

async function classifyBatch(emails: Email[]): Promise<void> {
  try {
    const response = await classifyEmails(emails);
    const results = getBatchResults(response);
    const received = new Set<string>();

    for (const result of results) {
      if (!result.email_id) continue;
      received.add(result.email_id);
      cache.set(result.email_id, toEntry(result));
    }

    // Anything the backend skipped is an error, not an eternal spinner.
    for (const email of emails) {
      if (!received.has(email.id)) setError(email.id);
    }

    console.log("GyoMail: classified inbox emails", results);
  } catch (error) {
    console.error("GyoMail: failed to classify inbox", error);
    emails.forEach((email) => setError(email.id));
  } finally {
    emails.forEach((email) => inFlight.delete(email.id));
    scheduleScan();
  }
}

async function classifySingle(email: Email): Promise<void> {
  try {
    const response = await classifyEmail(email);
    const result = getSingleResult(response);

    if (result) {
      cache.set(email.id, toEntry(result));
    } else {
      console.error("GyoMail: unexpected classification response", response);
      setError(email.id);
    }
  } catch (error) {
    console.error("GyoMail: failed to classify current email", error);
    setError(email.id);
  } finally {
    inFlight.delete(email.id);
    scheduleScan();
  }
}

/* -------------------------------------------------------------------------- */
/*  Scan loop                                                                  */
/* -------------------------------------------------------------------------- */

function renderTargets(targets: Target[]): void {
  for (const target of targets) {
    const entry = cache.get(target.email.id);
    if (entry) ensureBadge(target, entry);
  }
}

/**
 * One full pass: find what Gmail is currently showing, start analysis for
 * anything new, and (re)apply every known badge to the live DOM.
 */
function scan(): void {
  const openTargets = collectOpenTargets();
  const listTargets = openTargets.length > 0 ? [] : collectListTargets();
  const targets = [...openTargets, ...listTargets];

  const fresh = targets.filter((t) => needsClassification(t.email.id));

  if (fresh.length > 0) {
    const listEmails = fresh.filter((t) => t.email.body === null).map((t) => t.email);
    const openEmails = fresh.filter((t) => t.email.body !== null).map((t) => t.email);

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
/*  Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

function main(): void {
  installStyles();

  // Gmail is a SPA that re-renders rows on pagination, scrolling, refreshes,
  // category tabs and navigation. Observing the DOM (instead of polling only
  // the URL hash) means badges are restored whenever Gmail wipes them.
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

  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("hashchange", scheduleScan);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleScan();
  });

  scheduleScan();
}

main();