import { platformUIRequiredPlugins } from "@oai/platform/ui/postcss";

export default {
  // We're still relying on the vite tailwindcss plugin to be loaded to have it work for Bazel.
  plugins: platformUIRequiredPlugins().slice(2),
};
