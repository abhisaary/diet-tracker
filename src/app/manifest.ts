import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  const isDevelopment = process.env.NODE_ENV === "development";
  const appName = isDevelopment ? "Diet Tracker Dev" : "Diet Tracker";

  return {
    background_color: "#f8fafc",
    description: "Personal meal, macro, and gut symptom tracker.",
    display: "standalone",
    icons: [
      {
        purpose: "maskable",
        sizes: "1024x1024",
        src: isDevelopment ? "/dev-app-icon.png" : "/app-icon.png",
        type: "image/png",
      },
    ],
    name: appName,
    short_name: appName,
    start_url: "/",
    theme_color: "#020617",
  };
}
