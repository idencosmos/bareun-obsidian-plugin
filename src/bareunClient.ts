import * as https from 'https';
import { URL } from 'url';
import { BareunIssue, BareunResponse } from './constants';

export class BareunClient {
  static async analyze(endpoint: string, apiKey: string, text: string): Promise<BareunIssue[]> {
    if (!endpoint) {
      console.warn('[BKGA] Bareun endpoint is empty.');
      return [];
    }
    if (!apiKey) {
      console.warn('[BKGA] Bareun API key missing.');
      return [];
    }

    const url = new URL(endpoint);
    const payload = JSON.stringify({
      document: { content: text, language: 'ko-KR' },
      encoding_type: 'UTF32',
    });

    const options: https.RequestOptions = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: url.pathname + (url.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
        'Content-Length': Buffer.byteLength(payload).toString(),
        'User-Agent': 'BKGA-Obsidian/0.1',
      },
      rejectUnauthorized: false,
    };

    return await new Promise<BareunIssue[]>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Bareun HTTP ${res.statusCode ?? 'unknown'}`));
            return;
          }

          try {
            const json = JSON.parse(raw) as unknown as BareunResponse;
            resolve(BareunClient.parseResponse(json));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });

      req.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
      req.setTimeout(8000, () => {
        req.destroy();
        reject(new Error('Bareun request timeout'));
      });
      req.write(payload);
      req.end();
    });
  }

  private static parseResponse(res: BareunResponse): BareunIssue[] {
    const issues: BareunIssue[] = [];
    if (!res.revisedBlocks) {
      return issues;
    }

    for (const block of res.revisedBlocks) {
      if (!block || !block.revisions || block.revisions.length === 0) {
        continue;
      }
      const offset = block.origin?.beginOffset ?? 0;
      const length = block.origin?.length ?? 0;
      const suggestion = block.revised;
      const category = block.revisions[0]?.category ?? 'UNKNOWN';
      const message = block.revisions[0]?.description || category;
      issues.push({
        start: offset,
        end: offset + length,
        message,
        suggestion,
        severity: category === 'TYPO' ? 'error' : 'warning',
      });
    }
    return issues;
  }
}
