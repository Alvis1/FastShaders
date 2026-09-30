// Self-hosted fonts, shared by every entry point: the app must render with no
// network. LATIN + LATIN-EXT ONLY — the bare `400.css` entry declares all seven
// Google subsets (24 woff2 / 162 KB of dist nobody downloads), and Latvian sits
// inside latin-ext. A Cyrillic or Greek name falls back to a system font.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-ext-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-ext-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-ext-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-ext-500.css';
