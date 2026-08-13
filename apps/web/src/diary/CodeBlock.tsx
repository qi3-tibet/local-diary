import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import langBash from "@shikijs/langs/bash";
import langCss from "@shikijs/langs/css";
import langHtml from "@shikijs/langs/html";
import langJavaScript from "@shikijs/langs/javascript";
import langJson from "@shikijs/langs/json";
import langMarkdown from "@shikijs/langs/markdown";
import langPython from "@shikijs/langs/python";
import langSql from "@shikijs/langs/sql";
import langTsx from "@shikijs/langs/tsx";
import langTypeScript from "@shikijs/langs/typescript";
import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
import { useEffect, useState, type ReactNode } from "react";

const languageAliases = {
  bash: "bash",
  css: "css",
  html: "html",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  markdown: "markdown",
  md: "markdown",
  py: "python",
  python: "python",
  sh: "bash",
  shell: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  xml: "html",
} as const;

type SupportedLanguage = typeof languageAliases[keyof typeof languageAliases];

let highlighterPromise: ReturnType<typeof createHighlighterCore> | undefined;

type CodeBlockProps = {
  children?: ReactNode;
  className?: string;
};

export function normalizeCodeLanguage(value: string | undefined): SupportedLanguage | undefined {
  if (!value) return undefined;
  const alias = value.trim().toLowerCase();
  return alias in languageAliases
    ? languageAliases[alias as keyof typeof languageAliases]
    : undefined;
}

export function CodeBlock({ children, className }: CodeBlockProps) {
  const source = String(children ?? "");
  const rawLanguage = className?.split(/\s+/u).find((name) => name.startsWith("language-"))?.slice(9);
  const language = normalizeCodeLanguage(rawLanguage);
  const theme = useDocumentTheme();
  const [html, setHtml] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setHtml(undefined);
    if (!language) return;
    let cancelled = false;
    void getHighlighter().then((highlighter) => highlighter.codeToHtml(source, {
      lang: language,
      theme: theme === "dark" ? "dark-plus" : "light-plus",
    })).then((next) => {
      if (!cancelled) setHtml(next);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [language, source, theme]);

  async function copy(): Promise<void> {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    try {
      await clipboard.writeText(source);
      setCopied(true);
    } catch {
      // A missing or denied Clipboard API must not disrupt diary reading.
    }
  }

  const label = language?.toUpperCase() ?? rawLanguage?.toUpperCase() ?? "TEXT";
  return (
    <section className="entry-code-block">
      <div className="entry-code-toolbar">
        <span>{label}</span>
        <button className="entry-code-copy" type="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>
      {html ? (
        <div className="entry-code-highlight" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre><code className={className}>{source}</code></pre>
      )}
    </section>
  );
}

function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [langBash, langCss, langHtml, langJavaScript, langJson, langMarkdown, langPython, langSql, langTsx, langTypeScript],
    themes: [darkPlus, lightPlus],
  });
  return highlighterPromise;
}

function useDocumentTheme(): "light" | "dark" {
  const readTheme = (): "light" | "dark" => document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
