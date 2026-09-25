import type { ReactNode } from "react";

const inlinePattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;

function inline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const index = match.index;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const token = match[0];
    if (token.startsWith("**"))
      nodes.push(<strong key={`${key}-${index}`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`"))
      nodes.push(<code key={`${key}-${index}`}>{token.slice(1, -1)}</code>);
    else nodes.push(<em key={`${key}-${index}`}>{token.slice(1, -1)}</em>);
    cursor = index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

const heading = /^(#{1,4})\s+(.+)$/;
const bullet = /^[-*]\s+(.+)$/;
const numbered = /^\d+\.\s+(.+)$/;
const quote = /^>\s?(.*)$/;
const fence = /^```/;

function beginsBlock(line: string) {
  return (
    heading.test(line) ||
    bullet.test(line) ||
    numbered.test(line) ||
    quote.test(line) ||
    fence.test(line) ||
    /^---+$/.test(line)
  );
}

/** Render only a bounded Markdown subset as React text nodes, never as HTML. */
export function ChatMarkdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    const key = `block-${i}`;
    if (fence.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !fence.test(lines[i].trim()))
        code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(
        <pre key={key}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = heading.exec(line);
    if (h) {
      const content = inline(h[2], key);
      blocks.push(
        h[1].length <= 2 ? (
          <h3 key={key}>{content}</h3>
        ) : (
          <h4 key={key}>{content}</h4>
        ),
      );
      i++;
      continue;
    }
    if (/^---+$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    const item = bullet.exec(line) ?? numbered.exec(line);
    if (item) {
      const ordered = Boolean(numbered.exec(line));
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const next = (ordered ? numbered : bullet).exec(lines[i].trim());
        if (!next) break;
        items.push(
          <li key={`${key}-${i}`}>{inline(next[1], `${key}-${i}`)}</li>,
        );
        i++;
      }
      blocks.push(
        ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
      );
      continue;
    }
    if (quote.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const next = quote.exec(lines[i].trim());
        if (!next) break;
        quoted.push(next[1]);
        i++;
      }
      blocks.push(
        <blockquote key={key}>{inline(quoted.join(" "), key)}</blockquote>,
      );
      continue;
    }
    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !beginsBlock(lines[i].trim()))
      paragraph.push(lines[i++].trim());
    blocks.push(<p key={key}>{inline(paragraph.join(" "), key)}</p>);
  }
  return <div className="chat-markdown">{blocks}</div>;
}
