import type { StoredEmailResult } from "../types/storedemail";

const PREFIX = "gyomail:";

const phishingCount = document.querySelector("#phishing-count");
const suspiciousCount = document.querySelector("#suspicious-count");
const safeCount = document.querySelector("#safe-count");
const analyzedCount = document.querySelector("#analyzed-count");
const recentList = document.querySelector("#recent-list");

type Category = "phishing" | "safe" | "suspicious";

function getCategory(result: StoredEmailResult): Category {
  const label = result.label.toLowerCase();

  // Snippet-only predictions are potential, not final classifications.
  if (result.bodyAnalyzed !== true) {
    return "suspicious";
  }

  if (label === "phishing") return "phishing";
  if (label === "legitimate") return "safe";

  return "suspicious";
}

function getBadgeText(category: Category): string {
  switch (category) {
    case "phishing":
      return "Phishing";
    case "safe":
      return "Legitimate";
    case "suspicious":
      return "Suspicious";
  }
}

function render(results: StoredEmailResult[]) {
  const phishing = results.filter(
    (email) => getCategory(email) === "phishing"
  ).length;

  const safe = results.filter(
    (email) => getCategory(email) === "safe"
  ).length;

  const suspicious = results.filter(
    (email) => getCategory(email) === "suspicious"
  ).length;

  if (phishingCount) phishingCount.textContent = String(phishing);
  if (suspiciousCount) suspiciousCount.textContent = String(suspicious);
  if (safeCount) safeCount.textContent = String(safe);
  if (analyzedCount) analyzedCount.textContent = String(results.length);

  if (!recentList) return;

  recentList.replaceChildren();

  for (const email of results.slice(0, 5)) {
    const category = getCategory(email);

    const item = document.createElement("article");
    item.className = `email-card ${category}`;

    const title = document.createElement("strong");
    title.textContent = email.sender || "Unknown sender";

    const subject = document.createElement("p");
    subject.className = "email-subject";
    subject.textContent = email.subject || "(No subject)";

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = getBadgeText(category);

    item.append(title, subject, badge);
    recentList.append(item);
  }
}

async function loadResults() {
  const stored = await chrome.storage.local.get(null);

  const results = Object.entries(stored)
    .filter(
      ([key, value]) =>
        key.startsWith(PREFIX) &&
        value !== null &&
        typeof value === "object"
    )
    .map(([, value]) => value as StoredEmailResult)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  render(results);
}

void loadResults();

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "local") {
    void loadResults();
  }
});
