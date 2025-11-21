export const DEFAULT_BAREUN_REVISION_ENDPOINT =
  'https://api.bareun.ai/bareun.RevisionService/CorrectError';

export const DEFAULT_BAREUN_CUSTOM_DICTIONARY_ENDPOINT =
  'https://api.bareun.ai/bareun.CustomDictionaryService/UpdateCustomDictionary';

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

export type DictSetPayload = {
  items: Record<string, number>;
  type: 'WORD_LIST' | 'WORD_LIST_COMPOUND';
  name?: string;
};

export type UpdateCustomDictionaryRequest = {
  domain_name: string;
  dict: {
    domain_name: string;
    np_set?: DictSetPayload;
    cp_set?: DictSetPayload;
    cp_caret_set?: DictSetPayload;
    vv_set?: DictSetPayload;
    va_set?: DictSetPayload;
  };
};
