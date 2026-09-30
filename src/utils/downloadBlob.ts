/**
 * THE browser download: blob → object URL → anchor click → revoke. One shape
 * for every file the app hands over (no `showSaveFilePicker`, no data: URL), so
 * Safari, the Tauri WKWebView and the desktop build behave one way.
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
