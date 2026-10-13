interface ExtensionMessage {
  type: "CLASSIFY_EMAILS" | "CLASSIFY_EMAIL";
  emails?: unknown[];
  email?: unknown;
}

interface ApiMessageResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

const API_URL = import.meta.env.VITE_API_URL;

async function postJSON(
  endpoint: string,
  payload: unknown
): Promise<unknown> {
  if (!API_URL) {
    throw new Error("VITE_API_URL is not configured.");
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `${endpoint} failed (${response.status} ${response.statusText}): ${details}`
    );
  }

  return response.json();
}

// Send the entire inbox batch to /send-email only.
async function sendEmailBatch(emails: unknown[]): Promise<unknown> {
  return postJSON("/send-email", { emails });
}

// Classify only the individual email that the user opens.
async function classifySingleEmail(email: unknown): Promise<unknown> {
  return postJSON("/classify-email", email);
}

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender,
    sendResponse: (response: ApiMessageResponse) => void
  ) => {
    if (
      message.type !== "CLASSIFY_EMAILS" &&
      message.type !== "CLASSIFY_EMAIL"
    ) {
      return;
    }

    const processMessage = async (): Promise<unknown> => {
      if (message.type === "CLASSIFY_EMAILS") {
        if (!Array.isArray(message.emails)) {
          throw new Error("Expected an array of emails.");
        }

        if (message.emails.length === 0) {
          console.log("GyoMail: empty batch, skipping request.");
          return [];
        }

        console.log(
          `GyoMail: sending batch of ${message.emails.length} emails to /send-email`
        );

        return sendEmailBatch(message.emails);
      }

      if (message.email == null) {
        throw new Error("No email was provided.");
      }

      console.log("GyoMail: sending individual email to /classify-email");

      return classifySingleEmail(message.email);
    };

    processMessage()
      .then((data) => {
        sendResponse({ success: true, data });
      })
      .catch((error: unknown) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        console.error("GyoMail background error:", errorMessage);

        sendResponse({
          success: false,
          error: errorMessage,
        });
      });

    return true;
  }
);