import type { NextConfig } from "next";

// The app serves no images, so the built-in optimizer is pure attack surface: it is the
// only thing that would ever invoke sharp and its bundled libvips.
const nextConfig: NextConfig = {
  images: { unoptimized: true },
};

export default nextConfig;
