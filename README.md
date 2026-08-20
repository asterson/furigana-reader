# ふりがな読書 / Furigana Reader

一个面向日语 EPUB 的本地优先网页版阅读器。正确显示图片、`ruby` 注音和日文竖排；复制正文时自动跳过假名标注，并支持浏览器日语朗读。

在线版本：<https://furigana-reader.souma-fuyuko.chatgpt.site>

## 功能

- 在浏览器本地解析 EPUB，书籍不会上传到服务器
- 使用 EPUB 自带的语义目录，不把插图页误作章节
- 支持封面、章节图片、Ruby 与原书 CSS
- 原书排版、强制纵排、强制横排切换
- 选区复制或整章复制时移除 `rt` / `rp`
- 将长正文分块渲染，降低浏览器翻译和排版的 CPU 压力
- 支持章节内进度跳转、书内目录、脚注与返回链接
- 使用 Web Speech API 朗读选区或当前页
- 记忆每本书的章节进度
- 对 EPUB 内容移除脚本、表单、外部资源与危险属性

## 阅读架构

阅读器区分 EPUB 的两层结构：`spine` 负责真实阅读顺序，`nav[epub:type="toc"]` 负责用户看到的章节目录。长 XHTML 会按段落和图片边界拆成小页，当前只挂载一页；相对链接经过内部路由定位到目标 spine、分页块和锚点。

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

打开 <http://localhost:3000>，拖入本机 EPUB 即可。

## 部署

这是标准 Next.js App Router 项目，可部署到 Vercel，或运行：

```bash
npm run build
npm run start
```

当前版本不需要数据库、对象存储或环境变量。

## 云书库 / MinIO 扩展建议

不要让浏览器直接持有 MinIO 的 Access Key。建议增加独立后端或 Next.js Route Handler：

1. 用户登录后向后端申请短期预签名上传、下载 URL。
2. EPUB 以 `users/{userId}/books/{bookId}/original.epub` 存储。
3. 元数据、阅读进度与对象 key 写入数据库，不依赖 MinIO 列表作为书库索引。
4. 桶保持私有；限制文件大小、扩展名和 MIME，并在服务端验证 ZIP/EPUB 结构。
5. 保留现在的“本地打开”入口，云书库作为可选能力。

推荐的数据边界：

- MinIO：EPUB 原文件、封面缓存
- 数据库：书名、作者、对象 key、用户归属、章节进度
- 浏览器：阅读偏好、临时解析结果

## 隐私

默认模式下，EPUB 全程只在当前浏览器中解压和渲染。仓库不包含示例书籍或用户上传内容。
