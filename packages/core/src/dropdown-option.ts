/**
 * Choose the native dropdown option a step sentence names. A quoted label
 * wins; otherwise the one option label that appears in the sentence as whole
 * words, ignoring labels that a longer named label contains. Returns null
 * when no option, or more than one, is named, so the step fails instead of
 * guessing.
 */
export function chooseOption(
  sentence: string,
  labels: readonly string[],
): string | null {
  const norm = (text: string) =>
    text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
  const usable = [...new Set(labels.filter((label) => norm(label)))];
  const quoted = [...sentence.matchAll(/"([^"]+)"|“([^”]+)”/gu)].map((match) =>
    norm(match[1] ?? match[2] ?? ""),
  );
  const byQuote = usable.filter((label) => quoted.includes(norm(label)));
  if (byQuote.length === 1) return byQuote[0]!;
  if (byQuote.length > 1) return null;
  const text = ` ${norm(sentence).replace(/[.,;:!?]+$/u, "")} `;
  const named = usable.filter((label) => {
    const needle = norm(label);
    let index = text.indexOf(needle);
    while (index >= 0) {
      const before = text[index - 1] ?? " ";
      const after = text[index + needle.length] ?? " ";
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after))
        return true;
      index = text.indexOf(needle, index + 1);
    }
    return false;
  });
  // "Canada" also names "Can"; keep only labels no other named label contains.
  const distinct = named.filter(
    (label) =>
      !named.some(
        (other) => other !== label && norm(other).includes(norm(label)),
      ),
  );
  return distinct.length === 1 ? distinct[0]! : null;
}
