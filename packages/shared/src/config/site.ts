export const siteConfig = {
  name: "GPT2IMAGE",

  description:
    "AI-powered chat-to-image generation platform. Transform your words into stunning visuals through natural conversation.",

  url: process.env.NEXT_PUBLIC_APP_URL || "https://gpt2image.com",

  ogImage: "/og-image.png",

  author: {
    name: "GPT2IMAGE Team",
    url: "https://gpt2image.com",
    email: "hello@gpt2image.com",
  },

  links: {
    twitter: "https://twitter.com/gpt2image",
    github: "https://github.com/gaoren002/GPT2Image-Pro",
    discord: "",
  },

  keywords: [
    "AI Image Generation",
    "Chat to Image",
    "Text to Image",
    "AI Art",
    "GPT2IMAGE",
    "Image Generation API",
    "Creative AI",
  ],
} as const;

export type SiteConfig = typeof siteConfig;
