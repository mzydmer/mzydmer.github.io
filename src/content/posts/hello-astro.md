---
title: "我的第一篇 Astro 博客"
description: "这是一篇带封面图和正文配图的示例文章。"
pubDate: 2026-06-18
tags: ["Astro", "GitHub Pages", "博客"]
cover: "/images/posts/hello-astro/cover.svg"
draft: false
---

这篇文章演示了博客最常见的写作方式：正文用 Markdown，图片放在 `public/images/posts/文章名/` 下面。

![文章中的配图](/images/posts/hello-astro/photo.svg)

你可以把自己的图片复制到同一个目录，然后在文章里这样引用：

```md
![图片说明](/images/posts/hello-astro/your-image.jpg)
```

如果你以后想用 MDX，也可以在 `src/content/posts/` 里创建 `.mdx` 文件。
