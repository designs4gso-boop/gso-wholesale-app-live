(function () {
  function money(value) {
    var number = Number(value || 0);
    return "$" + number.toFixed(2);
  }

  function clean(value) {
    return String(value || "").trim();
  }

  function gidToNumericId(gid) {
    var parts = String(gid || "").split("/");
    return parts[parts.length - 1] || "";
  }

  function optionHtml(values, selected) {
    return (values || []).map(function (value) {
      var safeValue = String(value || "");
      var isSelected = safeValue === selected ? " selected" : "";
      return '<option value="' + escapeHtml(safeValue) + '"' + isSelected + ">" + escapeHtml(safeValue) + "</option>";
    }).join("");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function findProductForm(root) {
    return (
      root.closest("product-info")?.querySelector('form[action*="/cart/add"]') ||
      root.closest("section")?.querySelector('form[action*="/cart/add"]') ||
      document.querySelector('form[action*="/cart/add"]')
    );
  }

  function ensureHidden(form, name) {
    var input = form.querySelector('input[name="' + name + '"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }
    return input;
  }

  function syncCartForm(root, state, payload) {
    var form = findProductForm(root);
    if (!form || !payload || !payload.active) return;

    var baseVariantGid =
      payload.product && payload.product.shopifyVariantGid
        ? payload.product.shopifyVariantGid
        : root.getAttribute("data-base-variant-gid");

    var baseVariantId = gidToNumericId(baseVariantGid);
    if (baseVariantId) {
      var idInput = form.querySelector('input[name="id"], select[name="id"]');
      if (idInput) {
        idInput.value = baseVariantId;
        idInput.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        ensureHidden(form, "id").value = baseVariantId;
      }
    }

    var qtyInput = form.querySelector('input[name="quantity"]');
    if (qtyInput) {
      qtyInput.value = String(state.quantity);
      qtyInput.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      ensureHidden(form, "quantity").value = String(state.quantity);
    }

    ensureHidden(form, "properties[Material]").value = state.material;
    ensureHidden(form, "properties[Finish]").value = state.finish;
    ensureHidden(form, "properties[Bag Color]").value = state.bagColor;
    ensureHidden(form, "properties[Sides]").value = "Double Sided";
    ensureHidden(form, "properties[ERP Product ID]").value = payload.product.id || "";
    ensureHidden(form, "properties[ERP Product Type]").value = "4x5 Stock Bag";
    ensureHidden(form, "properties[ERP Price Each]").value = money(payload.pricing.priceEach);
    ensureHidden(form, "properties[ERP Matched Tier]").value = payload.pricing.matchedRange || "";
    ensureHidden(form, "properties[_gso_configurator]").value = "true";
  }

  function initRoot(root) {
    if (!root || root.getAttribute("data-gso-ready") === "true") return;
    root.setAttribute("data-gso-ready", "true");

    var proxy = root.getAttribute("data-configurator-proxy") || "/apps/wholesale-lite/configurator";
    var shop = clean(root.getAttribute("data-shop"));
    var handle = clean(root.getAttribute("data-product-handle"));
    var productGid = clean(root.getAttribute("data-product-gid"));
    var minQty = Math.max(parseInt(root.getAttribute("data-minimum-quantity") || "64", 10) || 64, 1);

    var loading = root.querySelector(".gso-configurator__loading");
    var app = root.querySelector(".gso-configurator__app");
    var error = root.querySelector(".gso-configurator__error");

    var materialEl = root.querySelector('[data-gso-field="material"]');
    var finishEl = root.querySelector('[data-gso-field="finish"]');
    var bagColorEl = root.querySelector('[data-gso-field="bagColor"]');
    var quantityEl = root.querySelector('[data-gso-field="quantity"]');

    var state = {
      material: "",
      finish: "",
      bagColor: "",
      quantity: minQty
    };

    var lastPayload = null;
    var firstRender = true;

    quantityEl.min = String(minQty);
    quantityEl.value = String(minQty);

    function setText(key, value) {
      var el = root.querySelector('[data-gso-result="' + key + '"]');
      if (el) el.textContent = value;
    }

    function setVisible(key, visible) {
      var el = root.querySelector('[data-gso-result="' + key + '"]');
      if (el) el.hidden = !visible;
    }

    function showError(message) {
      if (loading) loading.hidden = true;
      if (app) app.hidden = true;
      if (error) {
        error.hidden = false;
        error.textContent = message || "Unable to load product configurator.";
      }
    }

    function buildUrl() {
      var params = new URLSearchParams();
      if (shop) params.set("shop", shop);
      if (handle) params.set("handle", handle);
      if (productGid) params.set("productGid", productGid);
      if (state.material) params.set("material", state.material);
      if (state.finish) params.set("finish", state.finish);
      if (state.bagColor) params.set("bagColor", state.bagColor);
      params.set("quantity", String(state.quantity || minQty));
      return proxy + "?" + params.toString();
    }

    function render(payload) {
      lastPayload = payload;

      if (!payload || !payload.ok || !payload.active) {
        showError((payload && payload.message) || "This product is not connected to the GSO configurator yet.");
        return;
      }

      var options = payload.options || {};
      var selected = payload.selected || {};
      var pricing = payload.pricing || {};
      var product = payload.product || {};

      state.material = selected.material || state.material || (options.materials && options.materials[0]) || "";
      state.finish = selected.finish || state.finish || (options.finishes && options.finishes[0]) || "";
      state.bagColor = selected.bagColor || state.bagColor || (options.bagColors && options.bagColors[0]) || "";
      state.quantity = Math.max(parseInt(selected.quantity || quantityEl.value || minQty, 10) || minQty, Number(product.minQuantity || minQty));

      materialEl.innerHTML = optionHtml(options.materials || [], state.material);
      finishEl.innerHTML = optionHtml(options.finishes || [], state.finish);
      bagColorEl.innerHTML = optionHtml(options.bagColors || [], state.bagColor);
      quantityEl.value = String(state.quantity);
      quantityEl.min = String(product.minQuantity || minQty);

      setVisible("priceEachBox", root.getAttribute("data-show-price-each") !== "false");
      setVisible("orderTotalBox", root.getAttribute("data-show-order-total") !== "false");
      setVisible("matchedTierBox", root.getAttribute("data-show-matched-tier") !== "false");

      var showInternal = root.getAttribute("data-show-profit-data") === "true";
      root.querySelectorAll(".gso-configurator__result--internal").forEach(function (el) {
        el.hidden = !showInternal;
      });

      setText("priceEach", money(pricing.priceEach));
      setText("orderTotal", money(pricing.orderTotal));
      setText("matchedTier", pricing.matchedRange || "No match");
      setText("costEach", money(pricing.costEach));
      setText("margin", Number(pricing.margin || 0).toFixed(1) + "%");

      var notice = root.querySelector('[data-gso-result="notice"]');
      if (notice) {
        notice.textContent =
          "Sides are set to " +
          (product.defaultSides || "Double Sided") +
          ". Minimum order is " +
          (product.minQuantity || minQty) +
          " units.";
      }

      if (loading) loading.hidden = true;
      if (error) error.hidden = true;
      if (app) app.hidden = false;

      syncCartForm(root, state, payload);

      if (firstRender) {
        firstRender = false;
        root.dispatchEvent(new CustomEvent("gso:configurator:ready", { bubbles: true, detail: payload }));
      }
    }

    function fetchAndRender() {
      if (loading && firstRender) loading.hidden = false;

      fetch(buildUrl(), { credentials: "same-origin" })
        .then(function (response) {
          return response.json();
        })
        .then(function (payload) {
          render(payload);
        })
        .catch(function (err) {
          console.error("GSO configurator error:", err);
          showError("Unable to load GSO configurator pricing.");
        });
    }

    function updateFromFields() {
      state.material = materialEl.value || state.material;
      state.finish = finishEl.value || state.finish;
      state.bagColor = bagColorEl.value || state.bagColor;
      state.quantity = Math.max(parseInt(quantityEl.value || String(minQty), 10) || minQty, minQty);
      fetchAndRender();
    }

    materialEl.addEventListener("change", updateFromFields);
    finishEl.addEventListener("change", updateFromFields);
    bagColorEl.addEventListener("change", updateFromFields);
    quantityEl.addEventListener("input", updateFromFields);
    quantityEl.addEventListener("change", updateFromFields);

    var form = findProductForm(root);
    if (form) {
      form.addEventListener("submit", function () {
        if (lastPayload) syncCartForm(root, state, lastPayload);
      });
    }

    fetchAndRender();
  }

  function initAll() {
    document.querySelectorAll(".gso-configurator").forEach(initRoot);
  }

  document.addEventListener("DOMContentLoaded", initAll);
  document.addEventListener("shopify:section:load", initAll);
  document.addEventListener("shopify:block:select", initAll);
  window.GSOProductConfiguratorInit = initAll;
})();
