// Word-level patterns over class, id, and icon tokens split at - _ : / #.
const ICON_KINDS: readonly [RegExp, string][] = [
  [/(?:^|-)(?:up-?vote|vote-?up|votearrow)(?:$|-)/, "upvote arrow"],
  [/(?:^|-)(?:down-?vote|vote-?down)(?:$|-)/, "downvote arrow"],
  [/(?:^|-)(?:search|magnifier|magnifying|loupe)(?:$|-)/, "search"],
  [/(?:^|-)(?:hamburger|burger|menu|bars)(?:$|-)/, "menu"],
  [/(?:^|-)(?:close|dismiss|xmark|x-mark|times)(?:$|-)/, "close"],
  [
    /(?:^|-)(?:(?:arrow|chevron|caret|angle|paddlenav)-?(?:right|next|forward)|(?:right|next|forward)-?(?:arrow|chevron|caret))(?:$|-)/,
    "right arrow",
  ],
  [
    /(?:^|-)(?:(?:arrow|chevron|caret|angle|paddlenav)-?(?:left|prev|previous|back)|(?:left|prev|previous|back)-?(?:arrow|chevron|caret))(?:$|-)/,
    "left arrow",
  ],
  [/(?:^|-)(?:terminal|shell|console|prompt)(?:$|-)/, "terminal"],
  [/(?:^|-)(?:cart|basket)(?:$|-)/, "cart"],
  [/(?:^|-)(?:kebab|ellipsis|more|dots)(?:$|-)/, "more"],
  [/(?:^|-)(?:settings|gear|cog)(?:$|-)/, "settings"],
  [/(?:^|-)share(?:$|-)/, "share"],
  [/(?:^|-)(?:copy|clipboard)(?:$|-)/, "copy"],
  [/(?:^|-)(?:bell|notifications?)(?:$|-)/, "notifications"],
  [/(?:^|-)(?:avatar|account|profile|user)(?:$|-)/, "account"],
  [/(?:^|-)play(?:$|-)/, "play"],
  [/(?:^|-)pause(?:$|-)/, "pause"],
];

export function iconKind(tokens: string[]): string {
  return (
    ICON_KINDS.find(([pattern]) =>
      tokens.some((token) => pattern.test(token)),
    )?.[1] ?? ""
  );
}

function hintWords(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether `text` says something the name does not, word for word. */
export function addsWords(text: string, name: string): boolean {
  const own = new Set(hintWords(name));
  return hintWords(text).some(
    (word) => word.length > 1 && /\p{L}/u.test(word) && !own.has(word),
  );
}

export function includesHintWord(text: string, word: string): boolean {
  return hintWords(text).includes(word);
}
