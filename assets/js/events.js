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

export function emitCompat(bus, type, detail, { alsoWindow = true } = {}) {
  bus?.emit?.(type, detail);
  if (alsoWindow) window.dispatchEvent(new CustomEvent(type, { detail }));
}

export function makeEmitter(bus, opts) {
  return (type, detail) => emitCompat(bus, type, detail, opts);
}


export const bus = createEventBus();
