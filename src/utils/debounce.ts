/**
 * Debounce utility
 * Delays function execution until after a specified wait time has passed
 */

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return function (...args: Parameters<T>) {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      func(...args);
    }, wait);
  };
}

/**
 * Debounce with immediate execution option
 * If immediate is true, trigger the function on the leading edge instead of trailing
 */
export function debounceImmediate<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
  immediate = false
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return function (...args: Parameters<T>) {
    const callNow = immediate && !timeout;

    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      timeout = null;
      if (!immediate) {
        func(...args);
      }
    }, wait);

    if (callNow) {
      func(...args);
    }
  };
}
