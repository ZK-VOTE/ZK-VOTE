import { Globe } from "lucide-react";
import { useTranslation, type Language } from "../i18n/I18nContext";

const LANGUAGES: { code: Language; name: string; flag: string }[] = [
  { code: "en", name: "English", flag: "🇺🇸" },
  { code: "es", name: "Español", flag: "🇪🇸" },
  { code: "fr", name: "Français", flag: "🇫🇷" },
  { code: "de", name: "Deutsch", flag: "🇩🇪" },
  { code: "ar", name: "العربية", flag: "🇸🇦" },
];

export function LanguageSwitcher() {
  const { language, setLanguage, t } = useTranslation();

  return (
    <div className="relative inline-block text-left">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-muted/50 text-xs font-medium">
        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          className="bg-transparent border-none focus:outline-none focus:ring-0 text-xs text-foreground cursor-pointer"
          aria-label={t("language.select")}
        >
          {LANGUAGES.map((lang) => (
            <option
              key={lang.code}
              value={lang.code}
              className="bg-background text-foreground"
            >
              {lang.flag} {lang.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export default LanguageSwitcher;
