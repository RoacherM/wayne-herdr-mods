// Import first. tweetnacl looks for its random source on `self` (browsers) or through `require`
// (Node); QuickJS has neither, but it has Web Crypto on globalThis.
(globalThis as any).self ??= globalThis;
export {};
