import '@testing-library/jest-dom/vitest';

// jsdom does not implement scrollIntoView — patch before any component mounts.
if (typeof window !== 'undefined') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: function (_opts?: unknown) {
      /* noop */
    },
    writable: true,
    configurable: true,
  });
}
