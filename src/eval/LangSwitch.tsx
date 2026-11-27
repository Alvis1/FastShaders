import { useAppStore } from '@/store/useAppStore';
import { t, type Language } from '@/i18n';
import { SettingButton, type SettingOption } from '@/components/inputs/SettingButton';

/** Each language under its own name, so a reader of either finds theirs. */
export const LANGUAGE_OPTIONS: readonly SettingOption<Language>[] = [
  { value: 'en', label: 'English' },
  { value: 'lv', label: 'Latviešu' },
];

/** The language button's tooltip: the language that is on, then what a click
 *  does, written in the language it switches TO first, so a reader who cannot
 *  read the current one still finds the way. */
export function languageTitle(language: Language): string {
  return language === 'lv'
    ? 'Valoda: latviešu. Switch to English (Pārslēgt uz angļu valodu). Ar peles labo pogu: visas valodas.'
    : 'Language: English. Pārslēgt uz latviešu valodu (Switch to Latvian). Right-click: all languages.';
}

/** The study dialogs' own EN/LV switch, the intro window's and the lesson
 *  panel's: they are modal, so the toolbar's button is unreachable behind the
 *  backdrop. Like every setting button it shows the language that is ON
 *  (owner, 2026-11-26); a click switches, a right-click lists both. `named`
 *  puts "Language:" before it (the intro window). `disabled` freezes it while
 *  the questionnaire packs its answers. */
export function LangSwitch({ disabled = false, named = false }: { disabled?: boolean; named?: boolean }) {
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const button = (
    <SettingButton
      options={LANGUAGE_OPTIONS}
      value={language}
      onSelect={setLanguage}
      menuLabel={t('Language', language)}
      className="csv-import-modal__button eval-consent__lang"
      disabled={disabled}
      title={languageTitle(language)}
      aria-label={`${t('Language', language)}: ${language === 'lv' ? 'latviešu' : 'English'}`}
    >
      {language === 'lv' ? 'LV' : 'EN'}
    </SettingButton>
  );
  if (!named) return button;
  return (
    <span className="eval-consent__lang-named">
      <span className="eval-consent__lang-name" aria-hidden="true">
        {t('Language', language)}:
      </span>
      {button}
    </span>
  );
}
