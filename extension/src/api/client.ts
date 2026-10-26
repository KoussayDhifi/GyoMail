
import type { Email } from "../types/email";

export type ClassificationResult = {
  email_id?: string;
  label: string;
  score: number;
  body_analyzed?: boolean;
  detected_language?: string;
  language_warning?: string | null;
};

export type BatchClassificationResponse = {
  Results?: ClassificationResult[];
  results?: ClassificationResult[];
};

export type SingleClassificationResponse = {
  message?: string;
  email?: Email;
  classification?: ClassificationResult;
} & Partial<ClassificationResult>;

type RuntimeResponse<T> = {
  success?: boolean;
  error?: string;
  data?: T;
};

export async function classifyEmails(
  emails: Email[]
): Promise<BatchClassificationResponse | ClassificationResult[]> {
  const response = (await chrome.runtime.sendMessage({
    type: "CLASSIFY_EMAILS",
    emails,
  })) as RuntimeResponse<
    BatchClassificationResponse | ClassificationResult[]
  >;

  if (!response?.success) {
    throw new Error(response?.error ?? "Classification failed");
  }

  return response.data ?? { Results: [] };
}

export async function classifyEmail(
  email: Email
): Promise<SingleClassificationResponse> {
  const response = (await chrome.runtime.sendMessage({
    type: "CLASSIFY_EMAIL",
    email,
  })) as RuntimeResponse<SingleClassificationResponse>;

  if (!response?.success) {
    throw new Error(response?.error ?? "Classification failed");
  }

  return response.data ?? {};
}
