// A synthetic website article that passes the uliquid-blog-json-v1 profile (R82).
// Shared by the blog review and blog delivery tests (R81, R83).
export const TITLE = "Paper Trading Builds Confidence Before Real Orders";
export const SLUG = "paper-trading-builds-confidence-before-real-orders";
export const ARTICLE = {
  seoTitle: "Paper trading builds confidence before real orders",
  description:
    "Why practising strategies with paper trading helps traders review their decisions calmly.",
  excerpt:
    "Paper trading lets traders rehearse a plan, review it and keep every decision their own.",
  category: "Trading desk",
  keywords: ["paper trading", "trading desk", "strategy review"],
  relatedLinks: [
    { label: "Trading desk", href: "/features/trading-desk/" },
    {
      label: "Market intelligence",
      href: "/blog/market-intelligence-context-not-signal/",
    },
  ],
};
const SENTENCE =
  "Paper trading gives a calm place to rehearse a plan and to review each decision before any real order is placed. ";
const SECOND =
  "A written plan makes the later review easier, because every trade can be compared with what was intended at the start. ";
/** A body in the restricted format: six sections of about 220 words with the profile's CTA once, the last with a closing list. */
export const articleBody = (extra = "") =>
  Array.from({ length: 6 }, (_, index) => {
    const paragraph = SENTENCE.repeat(5).trim();
    const second = SECOND.repeat(5).trim();
    const list =
      index === 5
        ? "\n\n- Write the plan down first\n- Review every paper trade"
        : "";
    return `## Section ${index + 1} of the review\n\n${paragraph}\n\n${second}${index === 0 ? ` Learn more.${extra}` : ""}${list}`;
  }).join("\n\n");
