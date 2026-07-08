import { useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark";

// Get theme from DOM
function getThemeFromDOM(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// Subscribe to DOM class changes
function subscribeToTheme(callback: () => void) {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.attributeName === "class") {
        callback();
      }
    }
  });

  observer.observe(document.documentElement, { attributes: true });

  return () => observer.disconnect();
}

export function useTheme() {
  // Use useSyncExternalStore to sync with DOM class
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getThemeFromDOM,
    () => "light" as Theme, // Server fallback
  );

  // Initialize theme on first load
  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    const root = document.documentElement;

    if (
      stored === "dark" ||
      (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, []);

  const toggleTheme = () => {
    const root = document.documentElement;
    const newTheme = theme === "light" ? "dark" : "light";

    if (newTheme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }

    localStorage.setItem("theme", newTheme);
  };

  return { theme, toggleTheme };
}
