export type StoredEmailResult = {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  timestamp: string;
  label: string;
  score: number;
  bodyAnalyzed: boolean;
  updatedAt: number;
};