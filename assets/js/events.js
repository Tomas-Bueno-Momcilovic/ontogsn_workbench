export function createEventBus() {
  const target = new EventTarget();

  function on(type, handler, options) {
    target.addEventListener(type, handler, options);
    return () => target.removeEventListener(type, handler, options);
  }

  function emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail }));
  }

  function once(type, handler) {
    const off = on(type, (e) => {
      off();
      handler(e);
    });
    return off;
  }

  return { on, once, emit, _target: target };
}
