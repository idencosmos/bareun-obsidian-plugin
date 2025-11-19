import { BareunIssue } from './constants';

export type ProcessedIssue = BareunIssue & { category: string };

export type AnalyzeOptions = {
  ignoreEnglish?: boolean;
};

export function refineIssues(
  text: string,
  issues: BareunIssue[],
  options: AnalyzeOptions = {}
): ProcessedIssue[] {
  const ignoreEnglish = options.ignoreEnglish ?? true;
  const inlineSpans = computeInlineCodeOffsets(text);

  const processed: ProcessedIssue[] = [];

  for (const issue of issues) {
    if (intersectsInlineCode(issue.start, issue.end, inlineSpans)) {
      continue;
    }
    const snippet = safeSlice(text, issue.start, issue.end);
    const category = extractCategory(issue.message);
    if (!snippet) {
      continue;
    }
    if (shouldIgnoreSnippet(snippet, category, ignoreEnglish)) {
      continue;
    }
    processed.push({ ...issue, category });
  }

  return processed;
}

export function buildLocalHeuristics(text: string): ProcessedIssue[] {
  const issues: ProcessedIssue[] = [];

  const doubleSpace = / {2,}/g;
  let m: RegExpExecArray | null;
  while ((m = doubleSpace.exec(text))) {
    issues.push({
      start: m.index,
      end: m.index + m[0].length,
      message: '여분의 공백이 있습니다.',
      suggestion: ' ',
      severity: 'warning',
      category: 'SPACING',
    });
  }

  const lines = text.split(/\r?\n/);
  let pos = 0;
  for (const line of lines) {
    if (line.endsWith(' ')) {
      const trimmedLength = line.trimEnd().length;
      issues.push({
        start: pos + trimmedLength,
        end: pos + line.length,
        message: '행 끝에 불필요한 공백이 있습니다.',
        suggestion: '',
        severity: 'info',
        category: 'SPACING',
      });
    }
    pos += line.length + 1;
  }

  return issues;
}

export function extractCategory(message: string): string {
  const match = message?.match(/^([A-Z_가-힣]+)/);
  if (match) {
    return match[1].toUpperCase();
  }
  return 'UNKNOWN';
}

function computeInlineCodeOffsets(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let fenceLen = 1;
    while (i + fenceLen < text.length && text[i + fenceLen] === '`') {
      fenceLen++;
    }
    const fence = '`'.repeat(fenceLen);
    const contentStart = i;
    i += fenceLen;
    const closing = text.indexOf(fence, i);
    if (closing === -1) {
      break;
    }
    spans.push({ start: contentStart, end: closing + fenceLen });
    i = closing + fenceLen;
  }
  return spans;
}

function intersectsInlineCode(
  start: number,
  end: number,
  spans: Array<{ start: number; end: number }>
): boolean {
  if (!spans.length) {
    return false;
  }
  return spans.some((span) => Math.max(span.start, start) < Math.min(span.end, end));
}

function shouldIgnoreSnippet(snippet: string, category: string, ignoreEnglish: boolean): boolean {
  const trimmed = snippet.trim();
  if (!trimmed) {
    return true;
  }
  if (ignoreEnglish && isLikelyEnglish(trimmed)) {
    return true;
  }
  if (containsUrlOrEmail(trimmed) || containsMarkdownLink(trimmed)) {
    return true;
  }
  if (containsParentheticalList(trimmed)) {
    return true;
  }
  if (category.includes('SPACING')) {
    if (containsShortcutPattern(trimmed) || containsHangulCommaRun(trimmed) || containsAllCapsAscii(trimmed)) {
      return true;
    }
  }
  return false;
}

function isLikelyEnglish(text: string): boolean {
  const cleaned = text.replace(/[^A-Za-z가-힣]/g, '');
  if (!cleaned) {
    return false;
  }
  if (/[가-힣]/.test(cleaned)) {
    return false;
  }
  return /[A-Za-z]/.test(cleaned);
}

function containsShortcutPattern(text: string): boolean {
  const shortcutRegex = /\b(?:cmd|ctrl|shift|alt|option|enter|esc|tab|space|backspace|delete|del)\b/i;
  if (!shortcutRegex.test(text)) {
    return false;
  }
  return /\+/.test(text) || /[()[\]]/.test(text);
}

function containsMarkdownLink(text: string): boolean {
  return /\[[^\]]+\]\([^)]+\)/.test(text);
}

function containsUrlOrEmail(text: string): boolean {
  return /https?:\/\/\S+/i.test(text) || /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text);
}

function containsHangulCommaRun(text: string): boolean {
  return /[가-힣],[가-힣]/.test(text);
}

function containsAllCapsAscii(text: string): boolean {
  return /\b[A-Z0-9]{3,}\b/.test(text);
}

function containsParentheticalList(text: string): boolean {
  const match = /\(([^)]+)\)/.exec(text);
  if (!match) {
    return false;
  }
  const inner = match[1];
  if (!/[가-힣]/.test(inner)) {
    return false;
  }
  const parts = inner
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  const validPart = /^[가-힣0-9\s·-]+$/;
  return parts.every((part) => validPart.test(part));
}

function safeSlice(text: string, start: number, end: number): string {
  if (start < 0 || end < 0 || start >= text.length || end <= start) {
    return '';
  }
  return text.slice(start, Math.min(end, text.length));
}
