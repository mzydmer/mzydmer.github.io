# Astro GitHub Blog

一个适合部署到 GitHub Pages 的 Astro 博客骨架，支持 Markdown/MDX、文章封面图、正文图片、RSS 和站点地图。

## 本地开发

```bash
npm install
npm run dev
```

## 写文章

文章放在 `src/content/posts/`，图片建议按文章放在 `public/images/posts/文章名/`。

```text
public/
  images/
    posts/
      hello-astro/
        cover.jpg
        photo.jpg
src/
  content/
    posts/
      hello-astro.md
```

Markdown 中引用图片：

```md
![图片说明](/images/posts/hello-astro/photo.jpg)
```

## 部署到 GitHub Pages

1. 新建仓库，推荐命名为 `<你的用户名>.github.io`。
2. 把本项目内容推送到仓库的 `main` 分支。
3. 在 GitHub 仓库设置中进入 `Settings -> Pages`。
4. Source 选择 `GitHub Actions`。
5. 推送后 Actions 会自动构建并部署。

如果你部署到普通仓库，例如 `blog`，Astro 会根据 `GITHUB_REPOSITORY` 自动把 `base` 设置为 `/blog/`。这种情况下，正文 Markdown 里的绝对图片路径也建议改成带仓库名前缀，例如 `/blog/images/posts/hello-astro/photo.jpg`。
