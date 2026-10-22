// ILIKE with user input neutralized — % and _ are wildcards; a search for "100%" must not
// match everything, and "\\" must not eat the next character. Shared by file/folder search.

import { ilike, type SQL } from 'drizzle-orm';

export function ilikeSafe(column: SQL | unknown, q: string): SQL {
  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  return ilike(column as never, `%${escaped}%`);
}
