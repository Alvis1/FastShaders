import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import './Toolbar.css';

const CONTACT = {
  name: 'Alvis Misjuns',
  email: 'alvis.misjuns@va.lv',
  website: 'alvismisjuns.lv',
  websiteUrl: 'https://alvismisjuns.lv',
};

export function Toolbar() {
  const shaderName = useAppStore((s) => s.shaderName);
  const setShaderName = useAppStore((s) => s.setShaderName);

  const [contactOpen, setContactOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLButtonElement>(null);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setShaderName(e.target.value);
    },
    [setShaderName]
  );

  // Close the contact popover on outside click or Escape
  useEffect(() => {
    if (!contactOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (brandRef.current?.contains(t)) return;
      setContactOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContactOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contactOpen]);

  const handleCopy = useCallback(async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      // Auto-revert the "Copied" label so the next copy still gives feedback
      window.setTimeout(() => {
        setCopiedKey((k) => (k === key ? null : k));
      }, 1500);
    } catch {
      // Clipboard API can fail in insecure contexts; silent fallback is fine here
    }
  }, []);

  return (
    <div className="toolbar">
      <div className="toolbar__left">
        <button
          ref={brandRef}
          type="button"
          className="toolbar__brand"
          onClick={() => setContactOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={contactOpen}
          title="About / Contact"
        >
          FastShaders
        </button>
        <span className="toolbar__version">v{__APP_VERSION__}</span>
        {contactOpen && (
          <div
            ref={popoverRef}
            className="toolbar__contact-popover"
            role="dialog"
            aria-label="Contact"
          >
            <div className="toolbar__contact-name">{CONTACT.name}</div>
            <div className="toolbar__contact-row">
              <a
                className="toolbar__contact-link"
                href={`mailto:${CONTACT.email}`}
              >
                {CONTACT.email}
              </a>
              <button
                type="button"
                className="toolbar__contact-copy"
                onClick={() => handleCopy('email', CONTACT.email)}
              >
                {copiedKey === 'email' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="toolbar__contact-row">
              <a
                className="toolbar__contact-link"
                href={CONTACT.websiteUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {CONTACT.website}
              </a>
              <button
                type="button"
                className="toolbar__contact-copy"
                onClick={() => handleCopy('web', CONTACT.websiteUrl)}
              >
                {copiedKey === 'web' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="toolbar__center">
        <input
          className="toolbar__name-input"
          type="text"
          value={shaderName}
          onChange={handleNameChange}
          placeholder="Shader name..."
          spellCheck={false}
        />
      </div>
      <div className="toolbar__right" />
    </div>
  );
}
