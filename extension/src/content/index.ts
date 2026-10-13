// src/content/index.ts

import type { Email } from "../types/email";
import { classifyEmails } from "../api/client";
import { classifyEmail } from "../api/client";


function parseCurrentEmail(): Email | null {
  // The currently open message
  const messageElement = document.querySelector<HTMLElement>(
    ".adn.ads[data-legacy-message-id]"
  );

  if (!messageElement) {
    console.log("GyoMail: no open email found");
    return null;
  }

  // Message ID
  const messageId =
    messageElement.getAttribute("data-legacy-message-id") ?? "";

  // Subject
  const subjectElement = document.querySelector<HTMLElement>(
    "h2.hP.mt-thread"
  );

  const subject =
    subjectElement?.textContent?.trim() ?? "";

  // Sender
  const senderElement = messageElement.querySelector<HTMLElement>(
    ".gD[email]"
  );

  const senderName =
    senderElement?.getAttribute("name") ??
    senderElement?.textContent?.trim() ??
    "";

  const senderEmail =
    senderElement?.getAttribute("email") ??
    "";

  // Timestamp
  const timestampElement =
    messageElement.querySelector<HTMLElement>(".g3");

  const timestamp =
    timestampElement?.getAttribute("title") ??
    timestampElement?.textContent?.trim() ??
    "";

  // Body
  const bodyElement =
    messageElement.querySelector<HTMLElement>(".a3s");

  const body =
    bodyElement?.innerText.trim() || null;

  return {
    id: messageId,

    sender: {
      name: senderName,
      email: senderEmail,
    },

    subject,
    snippet: "",
    timestamp,
    body,
  };
}


function parseEmailsSnippets(): Email[] {
  const emails: Email[] = [];

  const rows = document.querySelectorAll<HTMLTableRowElement>(
    'tr[data-mt-item="mt-list"]'
  );

  console.log("GyoMail: found rows:", rows.length);

  rows.forEach((row) => {
    // Gmail changes sender classes depending on the row state.
    const senderElement = row.querySelector<HTMLElement>(
      '.yW span[email], .zF[email], .yW span[name], .zF'
    );

    // The subject can be inside either .bqe or another span in .bog.
    const subjectElement = row.querySelector<HTMLElement>(
      ".bog .bqe, .bog span[data-thread-id]"
    );

    const snippetElement = row.querySelector<HTMLElement>(".y2");

    const timestampElement = row.querySelector<HTMLElement>(
      '.xW span[title]'
    );

    const threadElement = row.querySelector<HTMLElement>(
      "[data-thread-id], [data-legacy-thread-id]"
    );

    const senderName =
      senderElement?.getAttribute("name") ??
      senderElement?.textContent?.trim() ??
      "";

    const senderEmail =
      senderElement?.getAttribute("email") ?? "";

    const subject =
      subjectElement?.textContent?.trim() ?? "";

    const snippet =
      snippetElement?.textContent?.trim() ?? "";

    const timestamp =
      timestampElement?.getAttribute("title") ?? "";

    const threadId =
      threadElement?.getAttribute("data-thread-id") ??
      threadElement?.getAttribute("data-legacy-thread-id") ??
      "";

    // Log incomplete rows while debugging instead of silently losing them.
    if (!senderElement || !subjectElement || !threadId) {
      console.warn("GyoMail: skipped incomplete row", {
        senderFound: !!senderElement,
        subjectFound: !!subjectElement,
        threadId,
        row,
      });
      return;
    }

    emails.push({
      id: threadId,
      sender: {
        name: senderName,
        email: senderEmail,
      },
      subject,
      snippet,
      timestamp,
      body: null,
    });
  });

  console.log("GyoMail: parsed emails:", emails.length);

  return emails;
}

function waitForGmailEmails(): Promise<void> {
  return new Promise((resolve) => {
    const checkRows = () => {
      const rows = document.querySelectorAll(
        'tr[data-mt-item="mt-list"]'
      );

      if (rows.length > 0) {
        console.log("GyoMail: Gmail rows detected:", rows.length);
        observer.disconnect();
        resolve();
      }
    };

    const observer = new MutationObserver(checkRows);

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Handle rows that already exist before the observer starts.
    checkRows();
  });
}

async function handleHash(hash: string) {
  console.log("Handling hash:", hash);

  if (hash === "#inbox") {
    await waitForGmailEmails();

    const emails = parseEmailsSnippets();

    console.log("Parsed emails:", emails);

    if (emails.length === 0) {
      console.log("No emails found.");
      return;
    }

    try {
      const result = await classifyEmails(emails);
      console.log("API response:", result);
    } catch (error) {
      console.error("Failed to classify emails:", error);
    }
  } else if (hash.startsWith("#inbox/")) {
    const email = parseCurrentEmail();
    console.log("Parsed current email:", email);
    if (!email) {
      console.log("No email found.");
      return;
    }
    const response = await classifyEmail(email);

    console.log("API response for single email:", response);
    
  }
}

async function main() {
  let previousHash = "";

  setInterval(async () => {
    const currentHash = window.location.hash;

    if (currentHash === previousHash) {
      return;
    }

    previousHash = currentHash;

    await handleHash(currentHash);
  }, 500);
}

main();