// Print Intake Patch A (2026-11-18) — a SERVER-SIDE read-only database facade
// for dry-run planning.
//
// The intake agent's -DryRun asks the route-plan endpoint "what WOULD happen to
// this file?". The endpoint normally records what it decides (review rows,
// job linkage, audit entries). In a dry run every one of those writes must be
// suppressed on the server — hiding them in the PowerShell script would not be
// a guarantee. `readOnlyIntakeDb` wraps the Prisma client so that:
//   - every read (find*, count, aggregate, groupBy) passes straight through;
//   - every write (create*, update*, upsert, delete*) and every transaction or
//     raw statement is NOT executed — it resolves to a harmless stub and is
//     counted, so the response can prove nothing was written.
// The facade is an allowlist of reads: an unknown method is treated as a write.

const READ_METHODS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);

export type ReadOnlyDb<T> = { client: T; suppressedWrites: () => string[] };

export function readOnlyIntakeDb<T extends object>(db: T): ReadOnlyDb<T> {
  const suppressed: string[] = [];
  const client = new Proxy(db, {
    get(target, key) {
      const name = String(key);
      if (typeof key === "symbol" || name === "then") return undefined;
      if (name.startsWith("$")) {
        // $transaction / $executeRaw* / $queryRaw* — never run in a dry run.
        return async () => {
          suppressed.push(name);
          return [];
        };
      }
      const model = (target as any)[name];
      if (!model || typeof model !== "object") return model;
      return new Proxy(model, {
        get(modelTarget, method) {
          const methodName = String(method);
          if (typeof method === "symbol") return undefined;
          if (READ_METHODS.has(methodName)) return (...args: unknown[]) => (modelTarget as any)[methodName](...args);
          return async () => {
            suppressed.push(`${name}.${methodName}`);
            return {};
          };
        },
      });
    },
  }) as T;
  return { client, suppressedWrites: () => [...suppressed] };
}
