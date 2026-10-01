import type { Email } from "../types/email";

const API_URL = import.meta.env.API_URL as string;

export async function classifyEmails(emails: Email[]) {
  const response = await fetch(`${API_URL}/classify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      emails,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}