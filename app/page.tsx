"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { BookState, CachedSpine, PageRef, chapterPages, cleanText, getSpine, mediaType, parseEpub, resolvePath, splitHref } from "./epub";

type ReadingMode = "book" | "vertical" | "horizontal";
type SpeechNode = { node: Text; nodeStart: number; textStart: number; textEnd: number };
type SpeechPlan = { text: string; nodes: SpeechNode[] };

function buildSpeechPlan(doc: Document, selectedRange?: Range): SpeechPlan {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: SpeechNode[] = [];
  let text = "", lastBlock: Element | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (!parent || parent.closest("rt,rp,script,style,[aria-hidden='true']")) continue;
    if (selectedRange) {
      try { if (!selectedRange.intersectsNode(node)) continue; } catch { continue; }
    }
    let nodeStart = selectedRange?.startContainer === node ? selectedRange.startOffset : 0;
    let nodeEnd = selectedRange?.endContainer === node ? selectedRange.endOffset : node.data.length;
    nodeStart = Math.max(0, Math.min(nodeStart, node.data.length));
    nodeEnd = Math.max(nodeStart, Math.min(nodeEnd, node.data.length));
    const value = node.data.slice(nodeStart, nodeEnd);
    if (!value) continue;
    const block = parent.closest("p,li,div,h1,h2,h3,h4,h5,h6,blockquote,td,th") || parent;
    if (text && block !== lastBlock) text += "\n";
    const textStart = text.length;
    text += value;
    nodes.push({ node, nodeStart, textStart, textEnd: text.length });
    lastBlock = block;
  }
  return { text, nodes };
}

function speechRanges(plan: SpeechPlan, start: number, end: number) {
  const ranges: Range[] = [];
  for (const segment of plan.nodes) {
    const from = Math.max(start, segment.textStart), to = Math.min(end, segment.textEnd);
    if (from >= to) continue;
    const range = segment.node.ownerDocument.createRange();
    range.setStart(segment.node, segment.nodeStart + from - segment.textStart);
    range.setEnd(segment.node, segment.nodeStart + to - segment.textStart);
    ranges.push(range);
  }
  return ranges;
}

function clearSpeechHighlights(doc?: Document | null) {
  if (!doc) return;
  const view = doc.defaultView as unknown as { CSS?: { highlights?: { delete(name: string): void } } };
  view.CSS?.highlights?.delete("reader-sentence");
  view.CSS?.highlights?.delete("reader-word");
  doc.querySelectorAll(".speech-sentence-active,.speech-word-active").forEach((node) => node.classList.remove("speech-sentence-active", "speech-word-active"));
}

function setSpeechHighlight(doc: Document, name: "reader-sentence" | "reader-word", ranges: Range[], scroll = false) {
  const fallback = name === "reader-sentence" ? "speech-sentence-active" : "speech-word-active";
  doc.querySelectorAll(`.${fallback}`).forEach((node) => node.classList.remove(fallback));
  const view = doc.defaultView as unknown as {
    CSS?: { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } };
    Highlight?: new (...ranges: Range[]) => unknown;
  };
  if (view.CSS?.highlights && view.Highlight) {
    view.CSS.highlights.delete(name);
    if (ranges.length) view.CSS.highlights.set(name, new view.Highlight(...ranges));
  } else {
    ranges.forEach((range) => (range.startContainer.parentElement || range.startContainer.parentNode as Element | null)?.closest("p,li,div,h1,h2,h3,h4,h5,h6,blockquote")?.classList.add(fallback));
  }
  if (scroll && ranges[0]) {
    const element = ranges[0].startContainer.parentElement;
    element?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }
}

function textSegments(text: string, granularity: "sentence" | "word") {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter("ja", { granularity }).segment(text)].map((item) => ({ start: item.index, end: item.index + item.segment.length, text: item.segment })).filter((item) => item.text.trim());
  }
  const expression = granularity === "sentence" ? /[^。！？!?\n]+[。！？!?]?/g : /\S/g;
  return [...text.matchAll(expression)].map((item) => ({ start: item.index || 0, end: (item.index || 0) + item[0].length, text: item[0] }));
}

export default function Home() {
  const [book, setBook] = useState<BookState | null>(null);
  const [spineIndex, setSpineIndex] = useState(0);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [tocIndex, setTocIndex] = useState(0);
  const [pages, setPages] = useState<PageRef[]>([]);
  const [frameHtml, setFrameHtml] = useState("");
  const [mode, setMode] = useState<ReadingMode>("book");
  const [fontSize, setFontSize] = useState(18);
  const [showRuby, setShowRuby] = useState(true);
  const [menuOpen, setMenuOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [localProgress, setLocalProgress] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const spineCache = useRef(new Map<string, CachedSpine>());
  const pendingAnchor = useRef("");
  const renderSequence = useRef(0);
  const speechRun = useRef(0);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }, []);

  const openEpub = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".epub")) { notify("请选择 .epub 文件"); return; }
    setLoading(true);
    try {
      const parsed = await parseEpub(file);
      setBook((previous) => {
        if (previous?.coverUrl) URL.revokeObjectURL(previous.coverUrl);
        return parsed;
      });
      spineCache.current.clear();
      const savedRaw = localStorage.getItem(`furigana-reader:${parsed.title}:location`);
      let saved = { spineIndex: parsed.toc[0]?.spineIndex || 0, chunkIndex: 0 };
      if (savedRaw) {
        try { saved = { ...saved, ...JSON.parse(savedRaw) }; } catch { /* use start */ }
      }
      const safeSpine = Math.min(Math.max(saved.spineIndex, 0), parsed.spine.length - 1);
      const activeToc = Math.max(0, parsed.toc.findLastIndex((item) => item.spineIndex <= safeSpine));
      setSpineIndex(safeSpine);
      setChunkIndex(Math.max(saved.chunkIndex, 0));
      setTocIndex(activeToc);
      setMenuOpen(window.innerWidth > 760);
    } catch (error) {
      notify(error instanceof Error ? error.message : "EPUB 读取失败");
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    chapterPages(book, tocIndex, spineCache.current).then((result) => {
      if (!cancelled) setPages(result);
    }).catch(() => notify("章节进度生成失败"));
    return () => { cancelled = true; };
  }, [book, notify, tocIndex]);

  useEffect(() => {
    if (!book) return;
    speechRun.current += 1;
    window.speechSynthesis?.cancel();
    clearSpeechHighlights(frameRef.current?.contentDocument);
    setSpeaking(false);
    const sequence = ++renderSequence.current;
    const urls: string[] = [];
    let cancelled = false;
    (async () => {
      setLoading(true);
      const cached = await getSpine(book, spineIndex, spineCache.current);
      const safeChunk = Math.min(chunkIndex, cached.chunks.length - 1);
      if (safeChunk !== chunkIndex) { setChunkIndex(safeChunk); return; }
      const doc = new DOMParser().parseFromString(`<body>${cached.chunks[safeChunk]}</body>`, "text/html");
      const images = [...doc.querySelectorAll("img,image")];
      await Promise.all(images.map(async (image) => {
        const attr = image.hasAttribute("src") ? "src" : image.hasAttribute("href") ? "href" : "xlink:href";
        const src = image.getAttribute(attr);
        if (!src || /^(?:data|blob):/i.test(src)) return;
        const path = resolvePath(book.spine[spineIndex].path, src);
        const blob = await book.zip.file(path)?.async("blob");
        if (!blob) { image.removeAttribute(attr); return; }
        const url = URL.createObjectURL(new Blob([blob], { type: mediaType(path) }));
        urls.push(url);
        image.setAttribute(attr, url);
      }));
      if (cancelled || sequence !== renderSequence.current) return;
      const readerClass = mode === "horizontal" ? "reader-horizontal" : mode === "vertical" ? "reader-vertical" : "reader-book";
      const originalClass = cached.bodyClass.replace(/[^a-zA-Z0-9 _-]/g, "");
      const style = `${book.css}
        :root{color-scheme:light;--reader-font:${fontSize}px}html{width:100%;height:100%;overflow:auto;background:#fbf8f1;scroll-behavior:smooth}
        body{box-sizing:border-box;min-height:100%;margin:0;padding:3rem;font-size:var(--reader-font);color:#292823;background:#fbf8f1;font-family:"Noto Serif JP","Yu Mincho","Hiragino Mincho ProN",serif;text-rendering:optimizeLegibility}
        body.reader-horizontal{writing-mode:horizontal-tb!important;-webkit-writing-mode:horizontal-tb!important;max-width:820px;height:auto!important;margin:0 auto;line-height:1.95!important;overflow:visible!important}
        body.reader-vertical{writing-mode:vertical-rl!important;-webkit-writing-mode:vertical-rl!important;width:max-content!important;min-width:100%!important;height:100%!important;min-height:0!important;line-height:1.9!important;overflow:visible!important}
        body.reader-book{font-size:var(--reader-font)!important}img,svg{max-width:100%;max-height:90vh;object-fit:contain}ruby{ruby-position:over}rt{font-size:.5em;user-select:none;-webkit-user-select:none}${showRuby ? "" : "rt,rp{display:none!important}"}a{color:inherit;text-decoration-color:#b98975;text-underline-offset:.18em}::selection{background:#e9cfae;color:#1f1d19}::highlight(reader-sentence){background:#f3e3ad;color:inherit}::highlight(reader-word){background:#e4b85e;color:#352515}.speech-sentence-active{background:#f3e3ad!important}.speech-word-active{background:#e4b85e!important;color:#352515!important}@media(max-width:700px){body{padding:1.5rem}}`;
      setFrameHtml(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${style}</style></head><body class="${originalClass} ${readerClass}" translate="yes">${doc.body.innerHTML}</body></html>`);
      localStorage.setItem(`furigana-reader:${book.title}:location`, JSON.stringify({ spineIndex, chunkIndex: safeChunk }));
      setLocalProgress(0);
      setLoading(false);
    })().catch(() => {
      if (!cancelled) { setLoading(false); notify("这一页读取失败"); }
    });
    return () => { cancelled = true; urls.forEach(URL.revokeObjectURL); };
  }, [book, chunkIndex, fontSize, mode, notify, showRuby, spineIndex]);

  useEffect(() => () => {
    speechRun.current += 1;
    window.speechSynthesis?.cancel();
    clearSpeechHighlights(frameRef.current?.contentDocument);
  }, []);

  const goToPage = useCallback((page: PageRef, anchor = "") => {
    pendingAnchor.current = anchor;
    setSpineIndex(page.spineIndex);
    setChunkIndex(page.chunkIndex);
  }, []);

  const goToToc = useCallback(async (index: number, end = false) => {
    if (!book || index < 0 || index >= book.toc.length) return;
    setLoading(true);
    const chapter = await chapterPages(book, index, spineCache.current);
    setTocIndex(index);
    setPages(chapter);
    goToPage(end ? chapter[chapter.length - 1] : chapter[0], end ? "" : book.toc[index].anchor);
    if (window.innerWidth <= 760) setMenuOpen(false);
  }, [book, goToPage]);

  const navigateHref = useCallback(async (href: string) => {
    if (!book || !href) return;
    if (/^https?:/i.test(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    const { rawPath, anchor } = splitHref(href);
    const currentPath = book.spine[spineIndex].path;
    const targetPath = rawPath ? resolvePath(currentPath, rawPath) : currentPath;
    const targetSpine = book.spine.findIndex((item) => item.path === targetPath);
    if (targetSpine < 0) { notify("找不到链接指向的页面"); return; }
    const cached = await getSpine(book, targetSpine, spineCache.current);
    const targetChunk = anchor ? cached.anchorToChunk.get(anchor) ?? 0 : 0;
    const targetToc = Math.max(0, book.toc.findLastIndex((item) => item.spineIndex <= targetSpine));
    setTocIndex(targetToc);
    if (targetSpine === spineIndex && targetChunk === chunkIndex && anchor) {
      frameRef.current?.contentDocument?.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else goToPage({ spineIndex: targetSpine, chunkIndex: targetChunk }, anchor);
  }, [book, chunkIndex, goToPage, notify, spineIndex]);

  const attachFrameEvents = () => {
    const frame = frameRef.current, doc = frame?.contentDocument;
    if (!frame || !doc) return;
    const updateProgress = () => {
      const root = doc.scrollingElement || doc.documentElement;
      const writingMode = getComputedStyle(doc.body).writingMode;
      const vertical = writingMode.startsWith("vertical");
      const max = vertical ? root.scrollWidth - root.clientWidth : root.scrollHeight - root.clientHeight;
      const current = vertical ? Math.abs(root.scrollLeft) : root.scrollTop;
      setLocalProgress(max > 0 ? Math.min(100, Math.round(current / max * 100)) : 100);
    };
    doc.addEventListener("copy", (event) => {
      const selection = doc.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      const wrapper = doc.createElement("div");
      wrapper.appendChild(selection.getRangeAt(0).cloneContents());
      event.preventDefault();
      event.clipboardData?.setData("text/plain", cleanText(wrapper));
    });
    doc.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      const link = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!link) return;
      event.preventDefault();
      navigateHref(link.getAttribute("href") || "");
    });
    doc.addEventListener("scroll", updateProgress, { passive: true });
    window.setTimeout(() => {
      const anchor = pendingAnchor.current;
      if (anchor) {
        doc.getElementById(anchor)?.scrollIntoView({ behavior: "auto", block: "start" });
        pendingAnchor.current = "";
      }
      updateProgress();
    }, 0);
  };

  const pagePosition = Math.max(0, pages.findIndex((page) => page.spineIndex === spineIndex && page.chunkIndex === chunkIndex));
  const movePage = async (direction: number) => {
    const target = pagePosition + direction;
    if (target >= 0 && target < pages.length) goToPage(pages[target]);
    else if (direction > 0 && tocIndex < (book?.toc.length || 0) - 1) await goToToc(tocIndex + 1);
    else if (direction < 0 && tocIndex > 0) await goToToc(tocIndex - 1, true);
  };

  const copyChapter = async () => {
    if (!book) return;
    const refs = await chapterPages(book, tocIndex, spineCache.current);
    const parts: string[] = [];
    for (const ref of refs) {
      const cached = await getSpine(book, ref.spineIndex, spineCache.current);
      const doc = new DOMParser().parseFromString(`<body>${cached.chunks[ref.chunkIndex]}</body>`, "text/html");
      parts.push(cleanText(doc.body));
    }
    await navigator.clipboard.writeText(parts.filter(Boolean).join("\n"));
    notify("已复制本章正文，假名标注已跳过");
  };

  const speak = () => {
    if (!("speechSynthesis" in window)) { notify("当前浏览器不支持朗读"); return; }
    const doc = frameRef.current?.contentDocument;
    if (speaking) {
      speechRun.current += 1;
      window.speechSynthesis.cancel();
      clearSpeechHighlights(doc);
      setSpeaking(false);
      return;
    }
    if (!doc) return;
    const selection = doc.getSelection();
    const selectedRange = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
    const plan = buildSpeechPlan(doc, selectedRange);
    if (!plan.text.trim()) return;
    selection?.removeAllRanges();
    const sentences = textSegments(plan.text, "sentence").flatMap((sentence) => {
      if (sentence.end - sentence.start <= 220) return [sentence];
      const chunks = [];
      for (let start = sentence.start; start < sentence.end; start += 180) chunks.push({ start, end: Math.min(start + 180, sentence.end), text: plan.text.slice(start, Math.min(start + 180, sentence.end)) });
      return chunks;
    });
    const words = textSegments(plan.text, "word");
    const voice = window.speechSynthesis.getVoices().find((item) => item.lang.toLowerCase().startsWith("ja"));
    const run = ++speechRun.current;
    window.speechSynthesis.cancel();
    clearSpeechHighlights(doc);
    setSpeaking(true);
    const speakSentence = (index: number) => {
      if (run !== speechRun.current) return;
      if (index >= sentences.length) {
        clearSpeechHighlights(doc);
        setSpeaking(false);
        return;
      }
      const sentence = sentences[index];
      const utterance = new SpeechSynthesisUtterance(sentence.text);
      utterance.lang = "ja-JP"; utterance.rate = .92;
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        if (run !== speechRun.current) return;
        setSpeechHighlight(doc, "reader-sentence", speechRanges(plan, sentence.start, sentence.end), true);
        setSpeechHighlight(doc, "reader-word", [], false);
      };
      utterance.onboundary = (event) => {
        if (run !== speechRun.current) return;
        const position = sentence.start + event.charIndex;
        const word = words.find((item) => item.start <= position && position < item.end) || words.find((item) => item.start >= position);
        if (word) setSpeechHighlight(doc, "reader-word", speechRanges(plan, word.start, word.end));
      };
      utterance.onend = () => speakSentence(index + 1);
      utterance.onerror = (event) => {
        if (event.error === "canceled" || event.error === "interrupted") return;
        clearSpeechHighlights(doc);
        setSpeaking(false);
      };
      window.speechSynthesis.speak(utterance);
    };
    speakSentence(0);
  };

  const changeFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (file) openEpub(file); event.target.value = "";
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault(); setDragging(false); const file = event.dataTransfer.files?.[0]; if (file) openEpub(file);
  };

  if (!book) return (
    <main className="welcome" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <div className="paper-grain" />
      <header className="welcome-header"><span className="brand-mark">ふ</span><span>ふりがな読書</span></header>
      <section className="welcome-content">
        <p className="eyebrow">LOCAL EPUB READER</p>
        <h1><ruby>日本語<rt>にほんご</rt></ruby>の本を、<br />読む。選ぶ。聴く。</h1>
        <p className="intro">画像とルビをきれいに保ったまま、コピーするときだけ読み仮名を外す。翻訳にも朗読にも使いやすい、静かな読書画面です。</p>
        <label className={`drop-zone ${dragging ? "is-dragging" : ""}`}><input type="file" accept=".epub,application/epub+zip" onChange={changeFile} /><span className="upload-icon">＋</span><strong>{loading ? "本を開いています…" : "EPUBを開く"}</strong><small>点击选择，或把文件拖到这里 · 文件只在本机处理</small></label>
        <div className="feature-row"><div><span>01</span><b>ルビ排版</b><p>纵排、横排和图片都按书籍结构显示</p></div><div><span>02</span><b>轻量翻译</b><p>长章节分块显示，减少浏览器翻译负担</p></div><div><span>03</span><b>目录与注释</b><p>书内目录、脚注和返回链接均可跳转</p></div></div>
      </section>{toast && <div className="toast">{toast}</div>}
    </main>
  );

  const currentToc = book.toc[tocIndex];
  const overallProgress = ((spineIndex + (chunkIndex + 1) / Math.max(1, pages.length)) / book.spine.length) * 100;
  const atBookStart = tocIndex === 0 && pagePosition === 0;
  const atBookEnd = tocIndex === book.toc.length - 1 && pagePosition === pages.length - 1;

  return (
    <main className="reader-shell" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="reader-header"><button className="icon-button" onClick={() => setMenuOpen((value) => !value)} aria-label="切换目录">☰</button><div className="book-heading"><strong>{book.title}</strong><span>{currentToc?.title} · 本章 {pagePosition + 1} / {Math.max(pages.length, 1)}</span></div>
        <div className="header-actions"><button onClick={copyChapter}>复制本章</button><button className={speaking ? "active" : ""} onClick={speak}>{speaking ? "停止朗读" : "选中 / 本页朗读"}</button><label className="file-button">换一本<input type="file" accept=".epub,application/epub+zip" onChange={changeFile} /></label></div></header>
      <div className="progress-track"><span style={{ width: `${Math.min(100, overallProgress)}%` }} /></div>
      <div className="reader-body"><aside className={menuOpen ? "toc open" : "toc"}><div className="cover-area">{book.coverUrl ? <img src={book.coverUrl} alt="书籍封面" /> : <div className="cover-placeholder">本</div>}<div><strong>{book.title}</strong>{book.author && <span>{book.author}</span>}</div></div>
        <nav aria-label="书籍目录">{book.toc.map((item, index) => <button key={`${item.href}-${index}`} className={index === tocIndex ? "current" : ""} onClick={() => goToToc(index)}><span>{String(index + 1).padStart(2, "0")}</span>{item.title}</button>)}</nav></aside>
        <section className="reading-stage"><div className="tools"><div className="segmented" aria-label="排版方向"><button className={mode === "book" ? "selected" : ""} onClick={() => setMode("book")}>原书</button><button className={mode === "vertical" ? "selected" : ""} onClick={() => setMode("vertical")}>纵排</button><button className={mode === "horizontal" ? "selected" : ""} onClick={() => setMode("horizontal")}>横排</button></div>
          <label className="font-control"><span>字</span><input type="range" min="14" max="28" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} /><span>字</span></label><label className="switch"><input type="checkbox" checked={showRuby} onChange={(e) => setShowRuby(e.target.checked)} /><span />显示假名</label></div>
          <div className="page-frame">{loading && <div className="loading"><span />排版中…</div>}<iframe ref={frameRef} title={currentToc?.title || "正文"} srcDoc={frameHtml} onLoad={attachFrameEvents} sandbox="allow-same-origin allow-popups" /></div>
          <div className="page-nav"><button disabled={atBookStart} onClick={() => movePage(-1)}>← 上一页</button><div className="chapter-jump"><span>本章</span><input aria-label="章节内进度" type="range" min="0" max={Math.max(0, pages.length - 1)} value={pagePosition} onChange={(e) => goToPage(pages[Number(e.target.value)] || pages[0])} /><small>{pagePosition + 1}/{Math.max(1, pages.length)} · 页内 {localProgress}%</small></div><button disabled={atBookEnd} onClick={() => movePage(1)}>下一页 →</button></div>
        </section></div>{toast && <div className="toast">{toast}</div>}
    </main>
  );
}
