import React from "react";

type Block =
  | { type: "h1" | "h2" | "h3"; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "code"; lang: string | null; body: string };

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const flushList = (items: string[], ordered: boolean) => {
    if (items.length > 0) {
      blocks.push({ type: ordered ? "ol" : "ul", items });
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang, body: body.join("\n") });
      continue;
    }

    if (/^###\s+/.test(line)) {
      blocks.push({ type: "h3", text: line.replace(/^###\s+/, "") });
      i++;
      continue;
    }
    if (/^##\s+/.test(line)) {
      blocks.push({ type: "h2", text: line.replace(/^##\s+/, "") });
      i++;
      continue;
    }
    if (/^#\s+/.test(line)) {
      blocks.push({ type: "h1", text: line.replace(/^#\s+/, "") });
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      flushList(items, false);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      flushList(items, true);
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", text: para.join(" ") });
  }

  return blocks;
}

function renderInline(text: string, key: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let counter = 0;
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/;

  while (remaining.length > 0) {
    const match = remaining.match(pattern);
    if (!match || match.index === undefined) {
      parts.push(remaining);
      break;
    }
    if (match.index > 0) {
      parts.push(remaining.slice(0, match.index));
    }
    const token = match[0];
    const partKey = `${key}-i${counter++}`;
    if (token.startsWith("`")) {
      parts.push(
        <code
          key={partKey}
          className="px-1 py-0.5 rounded bg-gray-100 text-gray-800 font-mono text-[0.9em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      parts.push(
        <strong key={partKey} className="font-semibold text-gray-900">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        parts.push(
          <a
            key={partKey}
            href={linkMatch[2]}
            className="text-indigo-600 hover:text-indigo-800 underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkMatch[1]}
          </a>,
        );
      } else {
        parts.push(token);
      }
    }
    remaining = remaining.slice(match.index + token.length);
  }

  return parts;
}

export function renderMarkdown(md: string): React.ReactNode {
  const blocks = parseBlocks(md);
  return blocks.map((block, idx) => {
    const key = `b-${idx}`;
    switch (block.type) {
      case "h1":
        return (
          <h1
            key={key}
            className="text-2xl font-bold text-gray-900 mt-2 mb-4 pb-2 border-b border-gray-200"
          >
            {renderInline(block.text, key)}
          </h1>
        );
      case "h2":
        return (
          <h2
            key={key}
            className="text-xl font-semibold text-gray-900 mt-6 mb-3"
          >
            {renderInline(block.text, key)}
          </h2>
        );
      case "h3":
        return (
          <h3
            key={key}
            className="text-base font-semibold text-gray-900 mt-4 mb-2"
          >
            {renderInline(block.text, key)}
          </h3>
        );
      case "p":
        return (
          <p key={key} className="text-sm text-gray-700 my-3 leading-relaxed">
            {renderInline(block.text, key)}
          </p>
        );
      case "ul":
        return (
          <ul
            key={key}
            className="list-disc ml-6 my-3 space-y-1 text-sm text-gray-700"
          >
            {block.items.map((item, i) => (
              <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
            ))}
          </ul>
        );
      case "ol":
        return (
          <ol
            key={key}
            className="list-decimal ml-6 my-3 space-y-1 text-sm text-gray-700"
          >
            {block.items.map((item, i) => (
              <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
            ))}
          </ol>
        );
      case "code":
        return (
          <pre
            key={key}
            className="my-3 p-3 bg-gray-900 text-gray-100 rounded text-xs font-mono overflow-x-auto"
          >
            <code>{block.body}</code>
          </pre>
        );
    }
  });
}
