/*
 * A minimal DOM, sufficient to boot shatool in Node.
 *
 * Neither jsdom nor a headless browser is available in this environment, and
 * adding either would put a node_modules tree into a repository that
 * otherwise has no build step and no dependencies. Without something, though,
 * the entire UI layer is untested: a misspelled function name in ui-canvas.js
 * fails at run time in the browser and at no point before it.
 *
 * So this implements just the parts of the DOM that shatool actually touches.
 * It is not a DOM implementation and should not grow into one. What it buys
 * is a smoke test that boots the real application against the real
 * index.html and exercises the real event handlers, which catches the large
 * class of bugs that are simply "that name does not exist".
 *
 * What it deliberately does NOT do is check anything about rendering. The
 * canvas context records nothing and measures nothing; innerHTML is stored as
 * a string and never parsed. A test that passes here can still look wrong on
 * screen. It cannot, however, throw on load.
 */

"use strict";

const fs = require("fs");

/** An event target with the handler bookkeeping the app relies on. */
class Node_ {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = Object.create(null);
    this.attributes = Object.create(null);
    this.style = {};
    this.dataset = {};
    this._className = "";
    this._textContent = "";
    this._innerHTML = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this.title = "";
    this.type = "";
    this.id = "";
    /* Non-zero so that geometry code divides by a sane number rather than
     * bailing out on a zero-sized element. */
    this.clientWidth = 1200;
    this.clientHeight = 640;
    this.offsetWidth = 120;
    this.offsetHeight = 40;

    const self = this;
    this.classList = {
      add(...cs) { self._setClasses(new Set([...self._classes(), ...cs])); },
      remove(...cs) {
        const s = self._classes();
        cs.forEach((c) => s.delete(c));
        self._setClasses(s);
      },
      contains(c) { return self._classes().has(c); },
      toggle(c, force) {
        const on = force === undefined ? !self._classes().has(c) : !!force;
        if (on) this.add(c); else this.remove(c);
        return on;
      },
    };
  }

  _classes() {
    return new Set(this._className.split(/\s+/).filter(Boolean));
  }
  _setClasses(set) { this._className = [...set].join(" "); }

  get className() { return this._className; }
  set className(v) { this._className = String(v || ""); }

  get textContent() { return this._textContent; }
  set textContent(v) {
    this._textContent = String(v);
    this.children = [];        // matches the real clearing behaviour
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    /* Stored, never parsed. Tests assert on the string, which is enough to
     * tell "this panel rendered something plausible" from "this panel is
     * empty because a handler threw". */
    this._innerHTML = String(v);
    this.children = [];
  }

  appendChild(child) {
    if (child && child._isFragment) {
      child.children.forEach((c) => this.appendChild(c));
      child.children = [];
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "id") this.id = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k)
      ? this.attributes[k] : null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners[type];
    if (l) this.listeners[type] = l.filter((f) => f !== fn);
  }

  focus() { doc.activeElement = this; }
  blur() { if (doc.activeElement === this) doc.activeElement = null; }
  select() {}

  getBoundingClientRect() {
    return {
      left: 0, top: 0,
      width: this.clientWidth, height: this.clientHeight,
      right: this.clientWidth, bottom: this.clientHeight,
    };
  }

  getContext(kind) {
    return kind === "2d" ? makeCtx() : null;
  }
}

/** A 2-D context that accepts every call shatool makes and records none. */
function makeCtx() {
  const noop = () => {};
  return {
    fillStyle: "", strokeStyle: "", lineWidth: 1,
    font: "", textAlign: "", textBaseline: "",
    save: noop, restore: noop, setTransform: noop,
    clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop,
    setLineDash: noop, fillText: noop, strokeText: noop,
    measureText: () => ({ width: 10 }),
    translate: noop, scale: noop, rotate: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
  };
}

/**
 * Dispatch an event to one element's own listeners.
 *
 * Real bubbling is not implemented; instead the caller names the element that
 * carries the listener and supplies the target, which is exactly how the
 * app's delegated handlers are written and therefore exactly what needs
 * exercising.
 */
function fire(el, type, props) {
  const ev = Object.assign({
    type,
    target: el,
    currentTarget: el,
    clientX: 0, clientY: 0,
    preventDefault() {}, stopPropagation() {},
  }, props || {});
  const l = el.listeners[type] || [];
  l.forEach((fn) => fn(ev));
  return ev;
}

/** Depth-first walk, collecting nodes that satisfy `pred`. */
function findAll(el, pred, out) {
  out = out || [];
  if (pred(el)) out.push(el);
  el.children.forEach((c) => findAll(c, pred, out));
  return out;
}

// ---------------------------------------------------------------------
// The document, built from the ids that index.html actually declares
// ---------------------------------------------------------------------

let doc = null;
const frameQueue = [];
let nextFrameId = 1;

/**
 * Run up to `n` queued animation frames.
 *
 * Each frame is taken from the queue before being run, so a callback that
 * schedules the next frame — which is how the sampling loop continues — is
 * picked up by the following iteration rather than immediately.
 *
 * @returns {number} how many frames actually ran
 */
function pumpFrames(n) {
  let ran = 0;
  for (let i = 0; i < n; i++) {
    const f = frameQueue.shift();
    if (!f) break;
    f.fn(ran * 16);
    ran++;
  }
  return ran;
}

/** How many frames are waiting. Zero means nothing is animating. */
function pendingFrames() { return frameQueue.length; }

/**
 * Install a global `document` (and the few window globals shatool uses)
 * populated from a real index.html.
 *
 * Elements are created for exactly the ids present in the file, with their
 * real tag names and — for <select> — their real <option> values. So an id
 * that the JS looks up but the HTML does not declare produces `null` here,
 * the app throws, and the smoke test fails. That is the intended behaviour:
 * it is the same failure a browser would show.
 */
function install(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const byId = new Map();

  /* Match an element's tag and its id together, so <canvas id="..."> becomes
   * a node that answers getContext and <select id="..."> gets its options. */
  for (const m of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const [, tag, id] = m;
    const el = new Node_(tag);
    el.id = id;
    el.setAttribute("id", id);
    byId.set(id, el);
  }

  /* <option> values for every <select>, in document order. */
  for (const m of html.matchAll(
    /<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const el = byId.get(m[1]);
    if (!el) continue;
    el.options = [...m[2].matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)]
      .map((o) => ({ value: o[1] }));
    el.selectedIndex = 0;
    if (el.options.length) el.value = el.options[0].value;
  }

  doc = {
    readyState: "complete",
    activeElement: null,
    listeners: Object.create(null),
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new Node_(tag),
    createDocumentFragment: () => {
      const f = new Node_("#fragment");
      f._isFragment = true;
      return f;
    },
    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    },
    /** Every element the stub knows about, for assertions. */
    _byId: byId,
  };

  globalThis.document = doc;
  globalThis.devicePixelRatio = 1;
  if (typeof globalThis.addEventListener !== "function") {
    globalThis.addEventListener = () => {};
  }

  /* Frames are queued, never fired on a timer, so a test drives the sampling
   * loop deterministically with pumpFrames() instead of waiting on wall
   * clock. Without this the loop would either not run at all under test or
   * run an unpredictable number of times. */
  frameQueue.length = 0;
  nextFrameId = 1;
  globalThis.requestAnimationFrame = (fn) => {
    const id = nextFrameId++;
    frameQueue.push({ id, fn });
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    const i = frameQueue.findIndex((f) => f.id === id);
    if (i >= 0) frameQueue.splice(i, 1);
  };
  /* Left undefined on purpose: ui-canvas.js guards on
   * `typeof ResizeObserver === "function"`, and leaving it absent exercises
   * the fallback path that older browsers take. */
  return doc;
}

module.exports = {
  install, fire, findAll, pumpFrames, pendingFrames, Node: Node_,
};
