/* GSO Zakeke bridge — 17C.1
 *
 * Zakeke is artwork customization only. GSO ERP stays the authority for options,
 * quantity, MOQ, price, cart and checkout.
 *
 * The theme's own zakeke-customizer-price.liquid defines zakekeBeforeAddToCart so
 * that it POSTs the $1 canonical variant to /cart/add and redirects to /cart. That
 * is a native purchase path around the configurator, so on configurator products we
 * replace the hook and hard-block native cart writes.
 *
 * This file only ships with the GSO configurator block, so it never loads on legacy
 * products; every behaviour is additionally gated on the block being on the page.
 */
(function () {
  "use strict";

  var PENDING_KEY = "gso_zakeke_pending_v1";
  var PREVIEW_BASE = "/apps/zakeke/preview/";
  var MAX_DESIGN_ID = 200;
  // Design ids are opaque to us, so accept only a conservative charset and bound the
  // length. Anything else is treated as "no design" rather than passed along.
  var DESIGN_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

  var pending = null;
  var blocked = 0;

  function root() {
    return document.querySelector(".gso-configurator");
  }

  function handle() {
    var el = root();
    return (el && el.getAttribute("data-product-handle")) || "";
  }

  /* ---------------- 6A: Stock Bag family exemption ----------------
   * LOCKED OWNER RULE: Stock Bags ship premade GSO artwork and never use Zakeke.
   *
   * The theme renders the Zakeke snippet from theme.liquid on every page, so the
   * customizer can appear on a Stock Bag PDP. Without this gate a completed
   * design would be captured by attach() and ride the cart -> checkout ->
   * _GSO Zakeke Design ID -> ProductionJobFile(zakeke/artwork) path onto a Stock
   * Bag job. CSS hiding would not prevent that; this is a functional block.
   *
   * DTP Pouches, Stickers and every other family are untouched.
   */
  var ZAKEKE_EXEMPT_TYPES = ["stock bag"];

  function productType() {
    var el = root();
    return String((el && el.getAttribute("data-product-type")) || "").trim().toLowerCase();
  }

  function zakekeAllowed() {
    return ZAKEKE_EXEMPT_TYPES.indexOf(productType()) === -1;
  }

  function sanitizeDesignId(value) {
    var raw = String(value == null ? "" : value).trim();
    if (!raw || raw.length > MAX_DESIGN_ID) return "";
    return DESIGN_ID_PATTERN.test(raw) ? raw : "";
  }

  // Derived from the id rather than taken from Zakeke, so the stored reference is
  // always a stable same-origin app-proxy path and never a transient blob: URL.
  function previewUrlFor(designId) {
    return designId ? PREVIEW_BASE + encodeURIComponent(designId) : "";
  }

  function persist() {
    try {
      if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch (err) {
      /* private mode / quota — the in-memory copy still drives this page view */
    }
  }

  function restore() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
      if (saved && sanitizeDesignId(saved.designId) && saved.handle === handle()) {
        pending = {
          designId: sanitizeDesignId(saved.designId),
          previewUrl: previewUrlFor(sanitizeDesignId(saved.designId)),
          handle: saved.handle,
          at: String(saved.at || "")
        };
      }
    } catch (err) {
      pending = null;
    }
  }

  function slot() {
    var el = root();
    if (!el) return null;
    var existing = el.querySelector("[data-gso-artwork]");
    if (existing) return existing;
    var made = document.createElement("div");
    made.setAttribute("data-gso-artwork", "");
    made.className = "gso-configurator__artwork";
    made.hidden = true;
    var addButton = el.querySelector("[data-gso-add-to-cart]");
    if (addButton && addButton.parentNode) addButton.parentNode.insertBefore(made, addButton);
    else el.appendChild(made);
    return made;
  }

  function render() {
    var box = slot();
    if (!box) return;
    if (!pending) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    box.hidden = false;
    box.textContent = "";

    var label = document.createElement("span");
    label.className = "gso-configurator__artwork-label";
    label.textContent = "Artwork attached";

    var ref = document.createElement("span");
    ref.className = "gso-configurator__artwork-ref";
    ref.textContent = "Design " + pending.designId;

    var preview = document.createElement("a");
    preview.className = "gso-configurator__artwork-link";
    preview.href = pending.previewUrl;
    preview.target = "_blank";
    preview.rel = "noopener";
    preview.textContent = "View";

    box.appendChild(label);
    box.appendChild(ref);
    box.appendChild(preview);
  }

  function announce(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (err) {
      /* CustomEvent unsupported — events are advisory only */
    }
  }

  function attach(designId) {
    // Enforced here, not only at the hook, so a direct GSOZakeke.attach(...) call
    // (or any third-party script) cannot smuggle a design onto a Stock Bag.
    if (!zakekeAllowed()) {
      announce("gso:zakeke:family-blocked", { productType: productType() });
      return null;
    }
    var clean = sanitizeDesignId(designId);
    if (!clean) return null;
    pending = {
      designId: clean,
      previewUrl: previewUrlFor(clean),
      handle: handle(),
      at: new Date().toISOString()
    };
    persist();
    render();
    announce("gso:zakeke:attached", { designId: pending.designId, previewUrl: pending.previewUrl });
    var el = root();
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return pending;
  }

  function clear() {
    pending = null;
    persist();
    render();
  }

  /** Drop any stored design without needing the render pass. */
  function clearPersisted() {
    pending = null;
    persist();
  }

  function isNativeCartWrite(url, method) {
    if (String(method || "GET").toUpperCase() !== "POST") return false;
    var path = String(url || "");
    // Only the native cart-add endpoints. The GSO checkout proxy lives under
    // /apps/wholesale-lite/ and must keep working.
    return path.indexOf("/cart/add") >= 0;
  }

  function reportBlocked(url) {
    blocked += 1;
    announce("gso:zakeke:native-blocked", { url: String(url || ""), count: blocked });
    if (window.console && console.warn) {
      console.warn("[GSO] native cart add blocked on a configurator product:", url);
    }
  }

  // Zakeke completes its add through a programmatic fetch, which fires no submit
  // event and clicks no button, so the configurator's submit listener and disabled
  // add buttons never see it. These guards close that path at the transport level.
  function guardNativeCart() {
    var originalFetch = window.fetch;
    if (typeof originalFetch === "function" && !originalFetch.__gsoZakekeGuarded) {
      var guardedFetch = function (input, init) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        var method = (init && init.method) || (input && input.method) || "GET";
        if (isNativeCartWrite(url, method)) {
          reportBlocked(url);
          return Promise.reject(new Error("GSO: native cart add is disabled on configurator products"));
        }
        return originalFetch.apply(this, arguments);
      };
      guardedFetch.__gsoZakekeGuarded = true;
      window.fetch = guardedFetch;
    }

    var originalOpen = XMLHttpRequest.prototype.open;
    if (typeof originalOpen === "function" && !originalOpen.__gsoZakekeGuarded) {
      var guardedOpen = function (method, url) {
        this.__gsoBlocked = isNativeCartWrite(url, method);
        return originalOpen.apply(this, arguments);
      };
      guardedOpen.__gsoZakekeGuarded = true;
      XMLHttpRequest.prototype.open = guardedOpen;

      var originalSend = XMLHttpRequest.prototype.send;
      var guardedSend = function () {
        if (this.__gsoBlocked) {
          reportBlocked("xhr /cart/add");
          throw new Error("GSO: native cart add is disabled on configurator products");
        }
        return originalSend.apply(this, arguments);
      };
      guardedSend.__gsoZakekeGuarded = true;
      XMLHttpRequest.prototype.send = guardedSend;
    }

    // form.submit() dispatches no submit event either, so the capture-phase listener
    // in the configurator cannot see it.
    var originalSubmit = HTMLFormElement.prototype.submit;
    if (typeof originalSubmit === "function" && !originalSubmit.__gsoZakekeGuarded) {
      var guardedSubmit = function () {
        var action = this.getAttribute("action") || "";
        if (isNativeCartWrite(action, "POST")) {
          reportBlocked(action);
          return undefined;
        }
        return originalSubmit.apply(this, arguments);
      };
      guardedSubmit.__gsoZakekeGuarded = true;
      HTMLFormElement.prototype.submit = guardedSubmit;
    }
  }

  function installHook() {
    // Zakeke treats a returned promise as "the host page is handling this", so the
    // theme's version never resolves. Keeping that contract is what stops Zakeke from
    // falling through to its own add-to-cart; the difference is that we hand the
    // design to the configurator instead of writing to the native cart.
    //
    // 6A: on an exempt family the hook is STILL installed, and still never
    // resolves — that is what keeps Zakeke from falling back to the theme's own
    // /cart/add version. It simply refuses to attach the design.
    window.zakekeBeforeAddToCart = function (designID) {
      if (!zakekeAllowed()) {
        announce("gso:zakeke:family-blocked", { productType: productType(), designId: sanitizeDesignId(designID) });
        if (window.console && console.warn) {
          console.warn("[GSO] Zakeke is not available on Stock Bags — design ignored.");
        }
        return new Promise(function () {});
      }
      attach(designID);
      return new Promise(function () {});
    };
  }

  function init() {
    if (!root()) return;
    // 6A: an exempt family never restores a persisted design either, so a design
    // started elsewhere in the session cannot resurface on a Stock Bag PDP.
    if (zakekeAllowed()) restore();
    else clearPersisted();
    // Native /cart/add stays blocked on every configurator product, exempt or not.
    guardNativeCart();
    installHook();
    render();
  }

  window.GSOZakeke = {
    designId: function () {
      return pending ? pending.designId : "";
    },
    previewUrl: function () {
      return pending ? pending.previewUrl : "";
    },
    get: function () {
      return pending ? JSON.parse(JSON.stringify(pending)) : null;
    },
    attach: attach,
    clear: clear,
    /* 6A: exposed so the family gate is observable (and testable) rather than
     * an invisible behaviour. Stock Bag -> false. */
    isAllowed: zakekeAllowed,
    productType: productType,
    sanitizeDesignId: sanitizeDesignId,
    previewUrlFor: previewUrlFor,
    blockedCount: function () {
      return blocked;
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
