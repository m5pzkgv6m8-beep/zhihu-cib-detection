import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.addRule("removeScripts", {
  filter: ["script", "style", "noscript", "iframe"],
  replacement: () => "",
});

turndown.addRule("images", {
  filter: "img",
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const src = el.getAttribute("data-original") || el.getAttribute("src") || "";
    const alt = el.getAttribute("alt") || "";
    if (!src || src.startsWith("data:")) return "";
    return `![${alt}](${src})`;
  },
});

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}
