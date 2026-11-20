/**
 * Confusable-script detection for user-supplied identifiers (ZV-109).
 *
 * Flags identifiers that mix plain Latin letters with visually-identical
 * letters borrowed from another script (Cyrillic, Greek) in the same word
 * — e.g. a Cyrillic "а" (U+0430) substituted into an otherwise-Latin "DAO"
 * name to imitate it. A name written entirely in one script, including
 * entirely in Cyrillic or Greek, is left alone: single-script names are a
 * legitimate localization need, and mixing is the actual spoofing
 * technique, not script choice itself (this mirrors the "Moderately
 * Restrictive" profile from Unicode TR39, scoped to the scripts relevant
 * to Latin-alphabet brand/DAO-name impersonation).
 *
 * This is a curated subset of Unicode's confusables.txt, not the full
 * table: it covers the letters attackers actually substitute when
 * imitating a Latin name, not every script Unicode defines.
 */

const CONFUSABLE_TO_LATIN: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic
  а: "a",
  А: "A",
  е: "e",
  Е: "E",
  о: "o",
  О: "O",
  р: "p",
  Р: "P",
  с: "c",
  С: "C",
  у: "y",
  У: "Y",
  х: "x",
  Х: "X",
  і: "i",
  І: "I",
  ѕ: "s",
  Ѕ: "S",
  ј: "j",
  Ј: "J",
  ԛ: "q",
  һ: "h",
  Һ: "H",
  в: "B",
  к: "k",
  К: "K",
  м: "M",
  н: "H",
  т: "T",
  // Greek
  α: "a",
  Α: "A",
  ο: "o",
  Ο: "O",
  ρ: "p",
  Ρ: "P",
  υ: "y",
  Υ: "Y",
  κ: "k",
  Κ: "K",
  ν: "v",
  Ν: "N",
  β: "B",
  Β: "B",
  χ: "x",
  Χ: "X",
  τ: "t",
  Τ: "T",
  ι: "i",
  Ι: "I",
  η: "n",
  Η: "H",
});

const LATIN_LETTER = /[A-Za-z]/;

export interface ConfusableCheckResult {
  confusable: boolean;
  /** `name` with every confusable character replaced by its Latin look-alike. */
  skeleton: string;
  reason?: string;
}

/**
 * Detect script-mixing confusables: a name that combines plain Latin
 * letters with look-alike Cyrillic/Greek letters is almost always trying
 * to imitate a Latin-script name, which is never legitimate for an
 * otherwise-Latin identifier.
 */
export function detectConfusableMixedScript(
  name: string,
): ConfusableCheckResult {
  let skeleton = "";
  let hasPlainLatin = false;
  let hasConfusableSubstitution = false;

  for (const ch of name) {
    const latinEquivalent = CONFUSABLE_TO_LATIN[ch];
    if (latinEquivalent) {
      skeleton += latinEquivalent;
      hasConfusableSubstitution = true;
    } else {
      skeleton += ch;
      if (LATIN_LETTER.test(ch)) hasPlainLatin = true;
    }
  }

  const confusable = hasPlainLatin && hasConfusableSubstitution;
  return {
    confusable,
    skeleton,
    reason: confusable
      ? "Name mixes Latin letters with visually-identical characters from another script"
      : undefined,
  };
}

/** Convenience boolean wrapper around {@link detectConfusableMixedScript}. */
export function isConfusableName(name: string): boolean {
  return detectConfusableMixedScript(name).confusable;
}
