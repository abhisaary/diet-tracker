import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: "#f8fafc",
    description: "Personal meal, macro, and gut symptom tracker.",
    display: "standalone",
    icons: [
      {
        purpose: "maskable",
        sizes: "1024x1024",
        src: "/app-icon.png",
        type: "image/png",
      },
    ],
    name: "Diet Tracker",
    short_name: "Diet Tracker",
    start_url: "/",
    theme_color: "#020617",
  };
}
