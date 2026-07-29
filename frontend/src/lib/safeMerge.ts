/**
 * Safe object merging and cloning utilities to prevent prototype pollution attacks.
 */

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Checks whether a property key is safe from prototype pollution attacks.
 */
export function isSafeKey(key: string): boolean {
  if (DANGEROUS_KEYS.has(key) || key.startsWith("__")) {
    return false;
  }
  return true;
}

/**
 * Safely deep clones an object or primitive while omitting dangerous keys.
 */
export function safeClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => safeClone(item)) as unknown as T;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime()) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSafeKey(key)) {
      result[key] = safeClone(value);
    }
  }
  return result as T;
}

/**
 * Safely deep merges source objects into target object without prototype pollution vulnerabilities.
 */
export function safeMerge<T extends Record<string, unknown>>(
  target: T,
  ...sources: Array<Record<string, unknown> | undefined | null>
): T {
  const result = safeClone(target);

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    for (const [key, value] of Object.entries(source)) {
      if (!isSafeKey(key)) continue;

      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (result as Record<string, unknown>)[key] &&
        typeof (result as Record<string, unknown>)[key] === "object" &&
        !Array.isArray((result as Record<string, unknown>)[key])
      ) {
        (result as Record<string, unknown>)[key] = safeMerge(
          (result as Record<string, unknown>)[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        (result as Record<string, unknown>)[key] = safeClone(value);
      }
    }
  }

  return result;
}

/**
 * Safely parses JSON string and strips any polluted prototype properties from the output.
 */
export function safeJsonParse<T>(jsonString: string): T | null {
  try {
    const parsed = JSON.parse(jsonString, (key, value) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return undefined;
      }
      return value;
    });
    return safeClone(parsed) as T;
  } catch {
    return null;
  }
}
