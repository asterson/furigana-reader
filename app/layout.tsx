import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "ふりがな読書", description: "ルビ、画像、縦書きに対応した、翻訳と朗読に使いやすいローカルEPUBリーダー。", icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }
