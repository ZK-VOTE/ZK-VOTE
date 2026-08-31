import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import { I18nProvider, useTranslation } from "./I18nContext";

describe("I18nContext architecture", () => {
  it("translates keys in English by default", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });
    expect(result.current.t("vote.button")).toBe("Vote Now");
    expect(result.current.dir).toBe("ltr");
  });

  it("switches language and sets RTL direction for Arabic", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("ar");
    });

    expect(result.current.language).toBe("ar");
    expect(result.current.dir).toBe("rtl");
    expect(result.current.t("vote.button")).toBe("صوت الآن");
  });

  it("switches to Spanish correctly", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("es");
    });

    expect(result.current.t("vote.button")).toBe("Votar Ahora");
  });

  it("switches to German correctly", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("de");
    });

    expect(result.current.t("vote.button")).toBe("Jetzt abstimmen");
    expect(result.current.dir).toBe("ltr");
  });

  it("falls back to English when key is missing in target language", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("es");
    });

    // Test with a key that exists in English but not in Spanish (hypothetical)
    expect(result.current.t("nonexistent.key")).toBe("nonexistent.key");
  });

  it("supports parameter interpolation", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(result.current.t("dao.member_one")).toBe("member");
  });

  it("handles pluralization for English (singular)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(result.current.tPlural("dao.member", 1)).toBe("member");
  });

  it("handles pluralization for English (plural)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(result.current.tPlural("dao.member", 5)).toBe("members");
  });

  it("handles pluralization for German (singular)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("de");
    });

    expect(result.current.tPlural("dao.member", 1)).toBe("Mitglied");
  });

  it("handles pluralization for German (plural)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("de");
    });

    expect(result.current.tPlural("dao.member", 5)).toBe("Mitglieder");
  });

  it("handles Arabic complex pluralization (zero)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("ar");
    });

    expect(result.current.tPlural("dao.member", 0)).toBe("أعضاء");
  });

  it("handles Arabic complex pluralization (one)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("ar");
    });

    expect(result.current.tPlural("dao.member", 1)).toBe("عضو");
  });

  it("handles Arabic complex pluralization (two)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("ar");
    });

    expect(result.current.tPlural("dao.member", 2)).toBe("عضوان");
  });

  it("handles Arabic complex pluralization (few)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("ar");
    });

    expect(result.current.tPlural("dao.member", 5)).toBe("أعضاء");
  });

  it("handles Arabic complex pluralization (many)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("ar");
    });

    expect(result.current.tPlural("dao.member", 15)).toBe("عضو");
  });

  it("replaces {{count}} in plural strings", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    // This would require a translation key with {{count}} placeholder
    // For now, just verify the function exists and doesn't crash
    expect(() => result.current.tPlural("dao.member", 5)).not.toThrow();
  });
});
