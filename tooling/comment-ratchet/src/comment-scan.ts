import crypto from "node:crypto";
import ts from "typescript";

export type ScannedComment = {
  line: number;
  value: string;
};

const TYPESCRIPT_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const C_STYLE_FILE = /\.(?:java|swift|gradle|kts|c|h|css|json|jsonc)$/;
const HASH_STYLE_FILE =
  /\.(?:sh|tf|hcl|yaml|yml|toml|properties)$|(?:^|\/)(?:\.gitignore|\.gitattributes|\.npmrc|Dockerfile)$/;
const SQL_FILE = /\.sql$/;
const MARKUP_FILE = /\.(?:xml|html|plist|svg|xcprivacy)$/;
const EXEMPT_FILE = [/(?:^|\/)drizzle\/.+\.sql$/, /(?:^|\/)test\/evals\/cases\/.+\.html$/];

const FUNCTIONAL_COMMENT = [
  /^(?:eslint|oxlint)-(?:disable|enable)/,
  /^@ts-(?:check|nocheck|expect-error|ignore)/,
  /^(?:prettier|oxfmt|biome)-ignore/,
  /^\/ <reference /,
  /^(?:c8|v8|istanbul) ignore/,
  /^@vitest-environment /,
  /^#?(?:end)?region\b/,
  /^@vite-ignore$/,
  /^webpack[A-Z]\w*:/,
  /^[#@]__PURE__$/,
  /^@(?:type|typedef|satisfies|import)\b/,
  /^@(?:param|returns?) \{/,
  /^> statement-breakpoint$/,
  /^shellcheck /,
  /^swiftlint:/,
  /^yaml-language-server:/,
  /^syntax=/,
];

export function isScannable(filePath: string): boolean {
  if (EXEMPT_FILE.some((pattern) => pattern.test(filePath))) {
    return false;
  }
  return [TYPESCRIPT_FILE, C_STYLE_FILE, HASH_STYLE_FILE, SQL_FILE, MARKUP_FILE].some((pattern) =>
    pattern.test(filePath),
  );
}

export function normalizeCommentValue(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/^\s*\*+/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^\*+|\*+$/g, "")
    .trim();
}

export function isFunctionalComment(value: string): boolean {
  const normalized = normalizeCommentValue(value);
  return FUNCTIONAL_COMMENT.some((pattern) => pattern.test(normalized));
}

export function fingerprintComment(value: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeCommentValue(value))
    .digest("hex")
    .slice(0, 16);
}

export function scanComments(filePath: string, text: string): ScannedComment[] {
  return scanAllComments(filePath, text).filter((comment) => !isFunctionalComment(comment.value));
}

export function countCommentLines(comment: ScannedComment): number {
  return comment.value.split("\n").length;
}

function scanAllComments(filePath: string, text: string): ScannedComment[] {
  if (TYPESCRIPT_FILE.test(filePath)) {
    return scanTypeScriptComments(filePath, text);
  }
  if (C_STYLE_FILE.test(filePath)) {
    return scanCStyleComments(text);
  }
  if (HASH_STYLE_FILE.test(filePath)) {
    return scanLinePrefixedComments(text, /(?:^|(?<=\s))#(?=\s|$|[^!{(\w])(.*)$/gm);
  }
  if (SQL_FILE.test(filePath)) {
    return scanLinePrefixedComments(text, /(?:^|(?<=\s))--(.*)$/gm);
  }
  if (MARKUP_FILE.test(filePath)) {
    return scanMarkupComments(text);
  }
  return [];
}

function scanTypeScriptComments(filePath: string, text: string): ScannedComment[] {
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const nodes: ts.Node[] = [];
  const collectNodes = (node: ts.Node) => {
    nodes.push(node);
    node.getChildren(sourceFile).forEach(collectNodes);
  };
  collectNodes(sourceFile);
  const jsxTexts = nodes.filter((node) => node.kind === ts.SyntaxKind.JsxText);
  const isInJsxText = (position: number) =>
    jsxTexts.some((jsxText) => position >= jsxText.pos && position < jsxText.end);
  const ranges = new Map<number, ts.CommentRange>();
  for (const node of nodes) {
    const found = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ];
    for (const range of found) {
      if (!isInJsxText(range.pos)) {
        ranges.set(range.pos, range);
      }
    }
  }
  return [...ranges.values()]
    .toSorted((first, second) => first.pos - second.pos)
    .map((range) => toScannedComment(sourceFile, text, range));
}

function toScannedComment(
  sourceFile: ts.SourceFile,
  text: string,
  range: ts.CommentRange,
): ScannedComment {
  const raw = text.slice(range.pos, range.end);
  const value =
    range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? raw.slice(2) : raw.slice(2, -2);
  return { line: sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1, value };
}

function scanCStyleComments(text: string): ScannedComment[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const comments: ScannedComment[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      comments.push({
        line: lineAt(text, scanner.getTokenStart()),
        value: scanner.getTokenText().slice(2),
      });
    } else if (kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push({
        line: lineAt(text, scanner.getTokenStart()),
        value: scanner.getTokenText().slice(2, -2),
      });
    }
  }
  return comments;
}

function scanLinePrefixedComments(text: string, pattern: RegExp): ScannedComment[] {
  return [...text.matchAll(pattern)].map((match) => ({
    line: lineAt(text, match.index),
    value: match[1] ?? "",
  }));
}

function scanMarkupComments(text: string): ScannedComment[] {
  return [...text.matchAll(/<!--([\s\S]*?)-->/g)].map((match) => ({
    line: lineAt(text, match.index),
    value: match[1] ?? "",
  }));
}

function lineAt(text: string, position: number): number {
  let line = 1;
  for (
    let index = text.indexOf("\n");
    index !== -1 && index < position;
    index = text.indexOf("\n", index + 1)
  ) {
    line += 1;
  }
  return line;
}
