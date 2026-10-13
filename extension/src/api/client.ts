
import type { Email } from "../types/email";

export async function classifyEmails(emails: Email[]) {
  const response = await chrome.runtime.sendMessage({
    type: "CLASSIFY_EMAILS",
    emails,
  });

  if (!response?.success) {
    throw new Error(response?.error ?? "Classification failed");
  }

  return response.data;
}

export async function classifyEmail(email: Email) {
  const response = await chrome.runtime.sendMessage({
    type: "CLASSIFY_EMAIL",
    email,
  });

  if (!response?.success) {
    throw new Error(response?.error ?? "Classification failed");
  }

  return response.data;
}
