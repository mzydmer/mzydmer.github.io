import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
const owner = process.env.GITHUB_REPOSITORY?.split('/')[0] ?? 'your-username';
const site = process.env.SITE ?? `https://${owner}.github.io`;
const base = process.env.BASE_PATH ?? (repository && !repository.endsWith('.github.io') ? `/${repository}/` : '/');

export default defineConfig({
  site,
  base,
  integrations: [mdx(), sitemap()],
  markdown: {
    shikiConfig: {
      theme: 'github-dark'
    }
  }
});
