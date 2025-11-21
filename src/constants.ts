export const DEFAULT_BAREUN_REVISION_ENDPOINT =
  'https://api.bareun.ai/bareun.RevisionService/CorrectError';

export type BareunIssue = {
  start: number;
  end: number;
  message: string;
  suggestion?: string;
  severity?: 'error' | 'warning' | 'info';
};

export type BareunResponse = {
  revisedBlocks?: Array<{
    origin?: { beginOffset?: number; length?: number };
    revisions?: Array<{ category?: string; description?: string }>;
    revised?: string;
  }>;
};
