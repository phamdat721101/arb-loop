import { PII_PATTERNS } from './patterns';
import type { FilteredMetadata } from './types';

export class MetadataFilter {
  filter(input: string): FilteredMetadata {
    if (!input) return { original: '', filtered: '', redactedFields: [], piiCount: 0 };

    let filtered = input;
    const redactedFields: string[] = [];
    let piiCount = 0;

    for (const [label, regex] of Object.entries(PII_PATTERNS)) {
      const fresh = new RegExp(regex.source, regex.flags);
      const matches = input.match(fresh);
      if (matches) {
        piiCount += matches.length;
        redactedFields.push(label);
        filtered = filtered.replace(fresh, `[${label}]`);
      }
    }

    return { original: input, filtered, redactedFields, piiCount };
  }

  filterFields(fields: Record<string, string>): Record<string, FilteredMetadata> {
    const result: Record<string, FilteredMetadata> = {};
    for (const [key, value] of Object.entries(fields)) {
      result[key] = this.filter(value);
    }
    return result;
  }
}
