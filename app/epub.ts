import JSZip from "jszip";

export type SpineItem = { id: string; path: string };
export type TocItem = { title: string; href: string; path: string; anchor: string; spineIndex: number };
export type BookState = {
  zip: JSZip;
  title: string;
  author: string;
  css: string;
  coverUrl?: string;
  spine: SpineItem[];
  toc: TocItem[];
};
export type CachedSpine = { chunks: string[]; anchorToChunk: Map<string, number>; bodyClass: string };
export type PageRef = { spineIndex: number; chunkIndex: number };

const FORBIDDEN = "script,iframe,object,embed,form,input,button,textarea,video,audio,link,meta,base";

export function dirname(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
}

export function splitHref(href: string) {
  const hash = href.indexOf("#");
  const rawPath = hash >= 0 ? href.slice(0, hash) : href;
  const rawAnchor = hash >= 0 ? href.slice(hash + 1) : "";
  let anchor = rawAnchor;
  try { anchor = decodeURIComponent(rawAnchor); } catch { /* keep original */ }
  return { rawPath, anchor };
}

export function resolvePath(fromFile: string, relative: string) {
  let clean = relative.split("#")[0].split("?")[0];
  try { clean = decodeURIComponent(clean); } catch { /* keep original */ }
  const parts = `${dirname(fromFile)}${clean}`.split("/");
  const output: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return output.join("/");
}

export function mediaType(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" } as Record<string, string>)[ext || ""] || "application/octet-stream";
}

function cleanCss(css: string) {
  return css
    .replace(/@import[\s\S]*?;/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/<\/style/gi, "<\\/style");
}

export async function parseEpub(file: File): Promise<BookState> {
  const zip = await JSZip.loadAsync(file);
  const containerText = await zip.file("META-INF/container.xml")?.async("text");
  if (!containerText) throw new Error("找不到 EPUB 容器信息");
  const container = new DOMParser().parseFromString(containerText, "application/xml");
  const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("找不到内容清单");
  const opfText = await zip.file(opfPath)?.async("text");
  if (!opfText) throw new Error("内容清单无法读取");
  const opf = new DOMParser().parseFromString(opfText, "application/xml");
  const title = opf.querySelector("title")?.textContent?.trim() || file.name.replace(/\.epub$/i, "");
  const author = opf.querySelector("creator")?.textContent?.trim() || "";
  const manifest = new Map<string, { href: string; media: string; properties: string }>();
  opf.querySelectorAll("manifest item").forEach((item) => {
    const id = item.getAttribute("id"), href = item.getAttribute("href");
    if (id && href) manifest.set(id, {
      href,
      media: item.getAttribute("media-type") || "",
      properties: item.getAttribute("properties") || "",
    });
  });
  const spine: SpineItem[] = [];
  opf.querySelectorAll("spine itemref").forEach((ref) => {
    const id = ref.getAttribute("idref") || "", item = manifest.get(id);
    if (item) spine.push({ id, path: resolvePath(opfPath, item.href) });
  });
  if (!spine.length) throw new Error("这本书没有可读内容");

  const toc: TocItem[] = [];
  const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes("nav"));
  if (navItem) {
    const navPath = resolvePath(opfPath, navItem.href);
    const navText = await zip.file(navPath)?.async("text");
    if (navText) {
      const navDoc = new DOMParser().parseFromString(navText, "application/xhtml+xml");
      const navs = [...navDoc.querySelectorAll("nav")];
      const tocNav = navs.find((node) => node.getAttribute("epub:type") === "toc" || node.getAttributeNS("http://www.idpf.org/2007/ops", "type") === "toc") || navDoc.querySelector("nav#toc");
      tocNav?.querySelectorAll("a[href]").forEach((link) => {
        const href = link.getAttribute("href") || "";
        const { rawPath, anchor } = splitHref(href);
        const path = resolvePath(navPath, rawPath);
        const spineIndex = spine.findIndex((item) => item.path === path);
        if (spineIndex >= 0) toc.push({ title: link.textContent?.trim() || `第 ${toc.length + 1} 章`, href, path, anchor, spineIndex });
      });
    }
  }
  if (!toc.length) {
    spine.forEach((item, index) => toc.push({ title: `第 ${index + 1} 节`, href: item.path, path: item.path, anchor: "", spineIndex: index }));
  }
  const styles = await Promise.all([...manifest.values()].filter((item) => item.media === "text/css").map(async (item) => await zip.file(resolvePath(opfPath, item.href))?.async("text") || ""));
  let coverUrl: string | undefined;
  const cover = [...manifest.values()].find((item) => item.properties.includes("cover-image"));
  if (cover) {
    const path = resolvePath(opfPath, cover.href), blob = await zip.file(path)?.async("blob");
    if (blob) coverUrl = URL.createObjectURL(new Blob([blob], { type: mediaType(path) }));
  }
  return { zip, title, author, css: cleanCss(styles.join("\n")), coverUrl, spine, toc };
}

function sanitizeDocument(doc: Document) {
  doc.querySelectorAll(FORBIDDEN).forEach((node) => node.remove());
  doc.querySelectorAll("*").forEach((element) => [...element.attributes].forEach((attribute) => {
    const value = attribute.value.trim();
    if (/^on/i.test(attribute.name) || attribute.name === "srcset") element.removeAttribute(attribute.name);
    if ((attribute.name === "href" || attribute.name === "src") && /^(?:javascript|vbscript):/i.test(value)) element.removeAttribute(attribute.name);
    if (attribute.name === "style" && /(?:url\s*\(|expression\s*\()/i.test(value)) element.removeAttribute(attribute.name);
  }));
}

function nodeHtml(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  return (node as Element).outerHTML || new XMLSerializer().serializeToString(node);
}

export async function getSpine(book: BookState, index: number, cache: Map<string, CachedSpine>) {
  const spineItem = book.spine[index];
  const existing = cache.get(spineItem.path);
  if (existing) return existing;
  const source = await book.zip.file(spineItem.path)?.async("text");
  if (!source) throw new Error("这一页无法读取");
  const doc = new DOMParser().parseFromString(source, "application/xhtml+xml");
  sanitizeDocument(doc);
  const body = doc.querySelector("body");
  if (!body) throw new Error("这一页没有正文");
  const tocAnchors = new Set(book.toc.filter((item) => item.path === spineItem.path && item.anchor).map((item) => item.anchor));
  const chunks: string[] = [], anchorToChunk = new Map<string, number>();
  let group: Node[] = [], chars = 0, elements = 0, anchors: string[] = [];
  let pendingAnchors: string[] = [];
  let keepWithNext = false;
  const flush = () => {
    if (!group.length) return;
    const hasVisibleContent = group.some((node) => {
      if (node.textContent?.trim()) return true;
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      const element = node as Element;
      return element.matches("img,svg,hr,table") || Boolean(element.querySelector("img,svg,hr,table"));
    });
    if (!hasVisibleContent) {
      pendingAnchors.push(...anchors);
      group = []; chars = 0; elements = 0; anchors = [];
      return;
    }
    const chunkIndex = chunks.length;
    chunks.push(group.map(nodeHtml).join(""));
    [...pendingAnchors, ...anchors].forEach((anchor) => anchorToChunk.set(anchor, chunkIndex));
    pendingAnchors = [];
    group = []; chars = 0; elements = 0; anchors = [];
  };
  [...body.childNodes].forEach((node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : null;
    const nodeAnchors = element ? [element, ...element.querySelectorAll("[id],[name]")].flatMap((item) => [item.getAttribute("id"), item.getAttribute("name")].filter(Boolean) as string[]) : [];
    const tocBoundary = nodeAnchors.some((anchor) => tocAnchors.has(anchor));
    const nodeChars = node.textContent?.length || 0;
    const isFullPageImage = Boolean(element?.matches("div.s1"));
    const isImageOnly = Boolean(!isFullPageImage && element?.querySelector("img,svg") && nodeChars < 20);
    const groupHasContent = group.some((item) => item.nodeType === Node.ELEMENT_NODE || Boolean(item.textContent?.trim()));
    const isMeaningful = Boolean(element && (node.textContent?.trim() || element.querySelector("img,svg")));

    // Ordinary image headings begin a fresh page and stay attached to the first
    // meaningful block after them. Full-page illustrations remain standalone.
    if (isImageOnly && groupHasContent) flush();
    if (!keepWithNext && group.length && (tocBoundary || elements >= 45 || chars + nodeChars > 5500)) flush();
    group.push(node); chars += nodeChars; if (element) elements += 1; anchors.push(...nodeAnchors);
    if (isFullPageImage) {
      keepWithNext = false;
      flush();
    } else if (isImageOnly) {
      keepWithNext = true;
    } else if (keepWithNext && isMeaningful) {
      keepWithNext = false;
    }
  });
  flush();
  if (pendingAnchors.length && chunks.length) pendingAnchors.forEach((anchor) => anchorToChunk.set(anchor, chunks.length - 1));
  const result = { chunks: chunks.length ? chunks : [""], anchorToChunk, bodyClass: body.getAttribute("class") || "" };
  cache.set(spineItem.path, result);
  return result;
}

export async function chapterPages(book: BookState, tocIndex: number, cache: Map<string, CachedSpine>): Promise<PageRef[]> {
  const start = book.toc[tocIndex];
  const next = book.toc[tocIndex + 1];
  const endSpine = next ? next.spineIndex : book.spine.length;
  const pages: PageRef[] = [];
  for (let spineIndex = start.spineIndex; spineIndex <= Math.min(endSpine, book.spine.length - 1); spineIndex += 1) {
    const data = await getSpine(book, spineIndex, cache);
    const firstChunk = spineIndex === start.spineIndex && start.anchor ? data.anchorToChunk.get(start.anchor) || 0 : 0;
    let lastChunk = data.chunks.length;
    if (next && spineIndex === next.spineIndex) lastChunk = next.anchor ? data.anchorToChunk.get(next.anchor) || 0 : 0;
    for (let chunkIndex = firstChunk; chunkIndex < lastChunk; chunkIndex += 1) pages.push({ spineIndex, chunkIndex });
    if (next && spineIndex === next.spineIndex) break;
  }
  return pages.length ? pages : [{ spineIndex: start.spineIndex, chunkIndex: 0 }];
}

export function cleanText(root: Node) {
  const clone = root.cloneNode(true) as ParentNode;
  clone.querySelectorAll?.("rt,rp,script,style").forEach((node) => node.remove());
  return (clone.textContent || "").replace(/[\t ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
