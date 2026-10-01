// src/types/email.ts

export interface Email {
  id: string;
  sender: {
    name: string;
    email: string;
  };
  subject: string;
  snippet: string;
  timestamp: string;
  body : string | null;
}