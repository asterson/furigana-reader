"use client";

import JSZip from "jszip";
import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from "react";

type Chapter = { id: string; href: string; title: string };
type BookState = { zip: JSZip; title: string; author: string; chapters: Chapter[]; css: string; coverUrl?: string };
type ReadingMode = "book" | "vertical" | "horizontal";

const FORBIDDEN = "script,iframe,object,embed,form,input,button,textarea,video,audio,link,meta,base";

function dirname(path: string) { return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : ""; }
function resolvePath(fromFile: string, relative: string) {
  const parts = `${dirname(fromFile)}${relative.split("#")[0].split("?")[0]}`.split("/");
  const output: string[] = [];
  for (const part of parts) { if (!part || part === ".") continue; if (part === "..") output.pop(); else output.push(part); }
  return output.join("/");
}
function mediaType(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" } as Record<string, string>)[ext || ""] || "application/octet-stream";
}
function cleanCss(css: string) {
  return css.replace(/@import[\s\S]*?;/gi, "").replace(/url\s*\([^)]*\)/gi, "none").replace(/expression\s*\([^)]*\)/gi, "").replace(/<\/style/gi, "<\\/style");
}
function cleanText(root: Node) {
  const clone = root.cloneNode(true) as ParentNode;
  clone.querySelectorAll?.("rt,rp,script,style").forEach((node) => node.remove());
  return (clone.textContent || "").replace(/[\t ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export default function Home() {
  const [book, setBook] = useState<BookState | null>(null);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [frameHtml, setFrameHtml] = useState("");
  const [mode, setMode] = useState<ReadingMode>("book");
  const [fontSize, setFontSize] = useState(18);
  const [showRuby, setShowRuby] = useState(true);
  const [menuOpen, setMenuOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const chapterUrls = useRef<string[]>([]);

  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2200); }, []);

  const openEpub = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".epub")) { notify("请选择 .epub 文件"); return; }
    setLoading(true);
    try {
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
        if (id && href) manifest.set(id, { href, media: item.getAttribute("media-type") || "", properties: item.getAttribute("properties") || "" });
      });
      const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes("nav"));
      const navTitles = new Map<string, string>();
      if (navItem) {
        const navPath = resolvePath(opfPath, navItem.href);
        const navText = await zip.file(navPath)?.async("text");
        if (navText) {
          const nav = new DOMParser().parseFromString(navText, "application/xhtml+xml");
          nav.querySelectorAll("nav a[href]").forEach((a) => { const href = a.getAttribute("href"); if (href) navTitles.set(resolvePath(navPath, href), a.textContent?.trim() || ""); });
        }
      }
      const chapters: Chapter[] = [];
      opf.querySelectorAll("spine itemref").forEach((ref, index) => {
        const id = ref.getAttribute("idref") || "", item = manifest.get(id); if (!item) return;
        const path = resolvePath(opfPath, item.href);
        chapters.push({ id, href: path, title: navTitles.get(path) || `第 ${index + 1} 节` });
      });
      if (!chapters.length) throw new Error("这本书没有可读章节");
      const styles = await Promise.all([...manifest.values()].filter((item) => item.media === "text/css").map(async (item) => await zip.file(resolvePath(opfPath, item.href))?.async("text") || ""));
      let coverUrl: string | undefined;
      const cover = [...manifest.values()].find((item) => item.properties.includes("cover-image"));
      if (cover) { const path = resolvePath(opfPath, cover.href), blob = await zip.file(path)?.async("blob"); if (blob) coverUrl = URL.createObjectURL(new Blob([blob], { type: mediaType(path) })); }
      setBook((previous) => { if (previous?.coverUrl) URL.revokeObjectURL(previous.coverUrl); return { zip, title, author, chapters, css: cleanCss(styles.join("\n")), coverUrl }; });
      const saved = Number(localStorage.getItem(`furigana-reader:${title}:chapter`) || 0);
      setChapterIndex(Math.min(Math.max(saved, 0), chapters.length - 1));
      setMenuOpen(window.innerWidth > 760);
    } catch (error) { notify(error instanceof Error ? error.message : "EPUB 读取失败"); }
    finally { setLoading(false); }
  }, [notify]);

  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    (async () => {
      setLoading(true); chapterUrls.current.forEach(URL.revokeObjectURL); chapterUrls.current = [];
      const chapter = book.chapters[chapterIndex], source = await book.zip.file(chapter.href)?.async("text");
      if (!source || cancelled) return;
      const doc = new DOMParser().parseFromString(source, "application/xhtml+xml");
      doc.querySelectorAll(FORBIDDEN).forEach((node) => node.remove());
      doc.querySelectorAll("*").forEach((element) => [...element.attributes].forEach((attribute) => {
        if (/^on/i.test(attribute.name) || attribute.name === "srcset" || (attribute.name === "href" && /^(?:javascript|https?):/i.test(attribute.value))) element.removeAttribute(attribute.name);
      }));
      const images = [...doc.querySelectorAll("img[src],image[href]")];
      await Promise.all(images.map(async (image) => {
        const attr = image.hasAttribute("src") ? "src" : "href", src = image.getAttribute(attr); if (!src || /^(?:data|blob):/i.test(src)) return;
        const path = resolvePath(chapter.href, src), blob = await book.zip.file(path)?.async("blob");
        if (!blob) { image.removeAttribute(attr); return; }
        const url = URL.createObjectURL(new Blob([blob], { type: mediaType(path) })); chapterUrls.current.push(url); image.setAttribute(attr, url);
      }));
      const body = doc.querySelector("body"); if (!body || cancelled) return;
      const bodyClass = mode === "horizontal" ? "reader-horizontal" : mode === "vertical" ? "reader-vertical" : "reader-book";
      const style = `${book.css}
        :root{color-scheme:light;--reader-font:${fontSize}px}html{height:100%;background:#fbf8f1}
        body{box-sizing:border-box;min-height:100%;margin:0;padding:3rem;font-size:var(--reader-font);color:#292823;background:#fbf8f1;font-family:"Noto Serif JP","Yu Mincho","Hiragino Mincho ProN",serif;text-rendering:optimizeLegibility}
        body.reader-horizontal{writing-mode:horizontal-tb!important;-webkit-writing-mode:horizontal-tb!important;max-width:820px;height:auto!important;margin:0 auto;line-height:1.95!important;overflow:visible!important}
        body.reader-vertical{writing-mode:vertical-rl!important;-webkit-writing-mode:vertical-rl!important;height:100vh!important;min-width:100%;line-height:1.9!important;overflow-x:auto!important;overflow-y:hidden!important}
        body.reader-book{font-size:var(--reader-font)!important}img,svg{max-width:100%;max-height:90vh;object-fit:contain}ruby{ruby-position:over}rt{font-size:.5em;user-select:none;-webkit-user-select:none}${showRuby ? "" : "rt,rp{display:none!important}"}::selection{background:#e9cfae;color:#1f1d19}@media(max-width:700px){body{padding:1.5rem}}`;
      setFrameHtml(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${style}</style></head><body class="${bodyClass}" translate="yes">${body.innerHTML}</body></html>`);
      localStorage.setItem(`furigana-reader:${book.title}:chapter`, String(chapterIndex)); setLoading(false);
    })().catch(() => { setLoading(false); notify("这一章读取失败"); });
    return () => { cancelled = true; };
  }, [book, chapterIndex, fontSize, mode, notify, showRuby]);

  useEffect(() => () => { chapterUrls.current.forEach(URL.revokeObjectURL); window.speechSynthesis?.cancel(); }, []);

  const attachFrameEvents = () => {
    const doc = frameRef.current?.contentDocument; if (!doc) return;
    doc.addEventListener("copy", (event) => {
      const selection = doc.getSelection(); if (!selection?.rangeCount || selection.isCollapsed) return;
      const wrapper = doc.createElement("div"); wrapper.appendChild(selection.getRangeAt(0).cloneContents()); event.preventDefault(); event.clipboardData?.setData("text/plain", cleanText(wrapper));
    });
  };
  const copyChapter = async () => { const body = frameRef.current?.contentDocument?.body; if (!body) return; await navigator.clipboard.writeText(cleanText(body)); notify("已复制正文，假名标注已跳过"); };
  const speak = () => {
    if (!("speechSynthesis" in window)) { notify("当前浏览器不支持朗读"); return; }
    if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); return; }
    const doc = frameRef.current?.contentDocument; if (!doc) return;
    const selection = doc.getSelection();
    const text = selection && !selection.isCollapsed && selection.rangeCount ? (() => { const div = doc.createElement("div"); div.appendChild(selection.getRangeAt(0).cloneContents()); return cleanText(div); })() : cleanText(doc.body);
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text); utterance.lang = "ja-JP"; utterance.rate = .92;
    const voice = window.speechSynthesis.getVoices().find((item) => item.lang.toLowerCase().startsWith("ja")); if (voice) utterance.voice = voice;
    utterance.onend = () => setSpeaking(false); utterance.onerror = () => setSpeaking(false); window.speechSynthesis.cancel(); window.speechSynthesis.speak(utterance); setSpeaking(true);
  };
  const changeFile = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) openEpub(file); event.target.value = ""; };
  const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files?.[0]; if (file) openEpub(file); };

  if (!book) return (
    <main className="welcome" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <div className="paper-grain" /><header className="welcome-header"><span className="brand-mark">ふ</span><span>ふりがな読書</span></header>
      <section className="welcome-content"><p className="eyebrow">LOCAL EPUB READER</p><h1><ruby>日本語<rt>にほんご</rt></ruby>の本を、<br />読む。選ぶ。聴く。</h1>
        <p className="intro">画像とルビをきれいに保ったまま、コピーするときだけ読み仮名を外す。翻訳にも朗読にも使いやすい、静かな読書画面です。</p>
        <label className={`drop-zone ${dragging ? "is-dragging" : ""}`}><input type="file" accept=".epub,application/epub+zip" onChange={changeFile} /><span className="upload-icon">＋</span><strong>{loading ? "本を開いています…" : "EPUBを開く"}</strong><small>点击选择，或把文件拖到这里 · 文件只在本机处理</small></label>
        <div className="feature-row"><div><span>01</span><b>ルビ排版</b><p>纵排、横排和图片都按书籍结构显示</p></div><div><span>02</span><b>干净复制</b><p>选择文字时自动跳过 rt 与 rp 标记</p></div><div><span>03</span><b>日语朗读</b><p>朗读选中内容，未选择时朗读整章</p></div></div>
      </section>{toast && <div className="toast">{toast}</div>}
    </main>
  );

  const chapter = book.chapters[chapterIndex], progress = ((chapterIndex + 1) / book.chapters.length) * 100;
  return (
    <main className="reader-shell" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="reader-header"><button className="icon-button" onClick={() => setMenuOpen((v) => !v)} aria-label="切换目录">☰</button><div className="book-heading"><strong>{book.title}</strong><span>{chapter.title} · {chapterIndex + 1} / {book.chapters.length}</span></div>
        <div className="header-actions"><button onClick={copyChapter}>复制本章</button><button className={speaking ? "active" : ""} onClick={speak}>{speaking ? "停止朗读" : "选中 / 本章朗读"}</button><label className="file-button">换一本<input type="file" accept=".epub,application/epub+zip" onChange={changeFile} /></label></div></header>
      <div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="reader-body">
        <aside className={menuOpen ? "toc open" : "toc"}><div className="cover-area">{book.coverUrl ? <img src={book.coverUrl} alt="书籍封面" /> : <div className="cover-placeholder">本</div>}<div><strong>{book.title}</strong>{book.author && <span>{book.author}</span>}</div></div>
          <nav aria-label="目录">{book.chapters.map((item, index) => <button key={`${item.id}-${index}`} className={index === chapterIndex ? "current" : ""} onClick={() => { setChapterIndex(index); if (window.innerWidth <= 760) setMenuOpen(false); }}><span>{String(index + 1).padStart(2, "0")}</span>{item.title}</button>)}</nav></aside>
        <section className="reading-stage"><div className="tools"><div className="segmented" aria-label="排版方向"><button className={mode === "book" ? "selected" : ""} onClick={() => setMode("book")}>原书</button><button className={mode === "vertical" ? "selected" : ""} onClick={() => setMode("vertical")}>纵排</button><button className={mode === "horizontal" ? "selected" : ""} onClick={() => setMode("horizontal")}>横排</button></div>
          <label className="font-control"><span>字</span><input type="range" min="14" max="28" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} /><span>字</span></label><label className="switch"><input type="checkbox" checked={showRuby} onChange={(e) => setShowRuby(e.target.checked)} /><span />显示假名</label></div>
          <div className="page-frame">{loading && <div className="loading"><span />排版中…</div>}<iframe ref={frameRef} title={chapter.title} srcDoc={frameHtml} onLoad={attachFrameEvents} sandbox="allow-same-origin" /></div>
          <div className="page-nav"><button disabled={chapterIndex === 0} onClick={() => setChapterIndex((v) => v - 1)}>← 上一章</button><span>{Math.round(progress)}%</span><button disabled={chapterIndex === book.chapters.length - 1} onClick={() => setChapterIndex((v) => v + 1)}>下一章 →</button></div>
        </section></div>{toast && <div className="toast">{toast}</div>}
    </main>
  );
}
