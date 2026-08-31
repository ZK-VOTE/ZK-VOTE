import React, { createContext, useContext, useState, useEffect } from "react";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ar from "./locales/ar.json";
import de from "./locales/de.json";

export type Language = "en" | "es" | "fr" | "ar" | "de";

const translations: Record<Language, Record<string, string>> = {
  en,
  es,
  fr,
  ar,
  de,
};

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur"]);

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  dir: "ltr" | "rtl";
  t: (key: string, params?: Record<string, string | number>) => string;
  tPlural: (key: string, count: number, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

const LANGUAGE_KEY = "zkvote_app_language";

function detectBrowserLanguage(): Language {
  if (typeof window === "undefined" || !navigator.language) {
    return "en";
  }
  const code = navigator.language.split("-")[0].toLowerCase();
  if (code in translations) {
    return code as Language;
  }
  return "en";
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [language, setLanguageState] = useState<Language>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(LANGUAGE_KEY);
      if (stored && stored in translations) {
        return stored as Language;
      }
    }
    return detectBrowserLanguage();
  });

  const dir = RTL_LANGUAGES.has(language) ? "rtl" : "ltr";

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dir = dir;
      document.documentElement.lang = language;
    }
  }, [language, dir]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    if (typeof window !== "undefined") {
      localStorage.setItem(LANGUAGE_KEY, lang);
    }
  };

  const t = (key: string, params?: Record<string, string | number>): string => {
    const dict = translations[language] || translations.en;
    let text = dict[key] || translations.en[key] || key;

    if (params) {
      Object.entries(params).forEach(([pKey, pVal]) => {
        text = text.replace(
          new RegExp(`{{\\s*${pKey}\\s*}}`, "g"),
          String(pVal),
        );
      });
    }

    return text;
  };

  const tPlural = (
    key: string,
    count: number,
    params?: Record<string, string | number>,
  ): string => {
    const dict = translations[language] || translations.en;
    const pluralKey = `${key}_${getPluralForm(language, count)}`;
    let text = dict[pluralKey] || dict[key] || translations.en[key] || key;

    if (params) {
      Object.entries(params).forEach(([pKey, pVal]) => {
        text = text.replace(
          new RegExp(`{{\\s*${pKey}\\s*}}`, "g"),
          String(pVal),
        );
      });
    }

    // Replace {{count}} with the actual count
    text = text.replace(new RegExp(`{{\\s*count\\s*}}`, "g"), String(count));

    return text;
  };

  function getPluralForm(lang: Language, count: number): string {
    // English, German, French, Spanish: singular for 1, plural otherwise
    if (["en", "de", "fr", "es"].includes(lang)) {
      return count === 1 ? "one" : "other";
    }
    // Arabic has complex plural rules
    if (lang === "ar") {
      if (count === 0) return "zero";
      if (count === 1) return "one";
      if (count === 2) return "two";
      if (count % 100 >= 3 && count % 100 <= 10) return "few";
      if (count % 100 >= 11 && count % 100 <= 99) return "many";
      return "other";
    }
    return count === 1 ? "one" : "other";
  }

  return (
    <I18nContext.Provider value={{ language, setLanguage, dir, t, tPlural }}>
      <div dir={dir}>{children}</div>
    </I18nContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export function useTranslation(): I18nContextType {
  const context = useContext(I18nContext);
  if (!context) {
    // Fallback if rendered outside Provider
    const lang = "en";
    const dir = "ltr";
    const t = (key: string, params?: Record<string, string | number>) => {
      let text = (translations.en as Record<string, string>)[key] || key;
      if (params) {
        Object.entries(params).forEach(([pK, pV]) => {
          text = text.replace(new RegExp(`{{\\s*${pK}\\s*}}`, "g"), String(pV));
        });
      }
      return text;
    };
    const tPlural = (
      key: string,
      count: number,
      params?: Record<string, string | number>,
    ): string => {
      const dict = translations.en as Record<string, string>;
      const pluralKey = `${key}_${count === 1 ? "one" : "other"}`;
      let text = dict[pluralKey] || dict[key] || key;
      if (params) {
        Object.entries(params).forEach(([pK, pV]) => {
          text = text.replace(new RegExp(`{{\\s*${pK}\\s*}}`, "g"), String(pV));
        });
      }
      text = text.replace(new RegExp(`{{\\s*count\\s*}}`, "g"), String(count));
      return text;
    };
    return {
      language: lang,
      setLanguage: () => {},
      dir,
      t,
      tPlural,
    };
  }
  return context;
}
