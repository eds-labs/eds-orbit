// Hard rules of the support AI (06 §3.5), as code, not prompt text: a
// sensitive customer question goes straight to a human, and a draft with a
// promise or advice is withheld. Deliberately broad; a false alarm costs an
// agent a minute, a miss could cost a customer money.

const SENSITIVE: Array<[reason: string, pattern: RegExp]> = [
  [
    "trading",
    /\b(should i|shall i|is it (a )?good time to)\b.{0,40}\b(buy|sell|invest|trade|hold|short|long)\b|\b(price|kurs)\s*(prediction|target|prognose|ziel)|\b(financial|investment|anlage)[ -]?(advice|beratung)\b|\bsoll(te)? ich\b.{0,40}\b(kaufen|verkaufen|investieren|halten)\b|\bwill (the )?price\b|\bgeht der (preis|kurs)\b/i,
  ],
  [
    "account_security",
    /\b(hacked|stolen|phishing|scam(med)?|compromised|unauthori[sz]ed|lost access|2fa|two[- ]factor|seed phrase|private key|gehackt|gestohlen|betrug|zugang verloren)\b/i,
  ],
  [
    "billing",
    /\b(refund|chargeback|charged twice|double charge|invoice|billing|subscription fee|rückerstattung|erstattung|rechnung|abbuchung|doppelt (abgebucht|belastet))\b/i,
  ],
  [
    "legal",
    /\b(lawyer|attorney|lawsuit|legal action|sue|court|gdpr request|data deletion request|anwalt|klage|gericht|dsgvo|auskunftsersuchen)\b/i,
  ],
];

/** Whether a customer's message must go to a human, and why. */
export function screenCustomerText(text: string) {
  const reasons = SENSITIVE.filter(([, pattern]) => pattern.test(text)).map(
    ([reason]) => reason,
  );
  return { sensitive: reasons.length > 0, reasons };
}

const FORBIDDEN: Array<[reason: string, pattern: RegExp]> = [
  [
    "promise",
    /\b(we (will|'ll) (refund|credit|reimburse|compensate)|guarantee[ds]?|guaranteed|wir (erstatten|garantieren)|garantiert)\b/i,
  ],
  [
    "advice",
    /\b(you should\b.{0,30}\b(buy|sell|invest|hold)|(we|i) recommend (buying|selling|investing)|good investment|sie sollten\b.{0,30}\b(kaufen|verkaufen|investieren|halten)|du solltest\b.{0,30}\b(kaufen|verkaufen|investieren|halten)|empfehlen (ihnen )?zu (kaufen|verkaufen))\b/i,
  ],
];

/** What disqualifies a drafted reply; empty when it may be shown to an agent. */
export function screenDraft(text: string) {
  return FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(
    ([reason]) => `forbidden:${reason}`,
  );
}
