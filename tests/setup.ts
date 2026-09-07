import { vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
Object.defineProperty(navigator, 'bluetooth', { value: {}, configurable: true });
Object.defineProperty(window, 'matchMedia', {
  value: vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
});
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
