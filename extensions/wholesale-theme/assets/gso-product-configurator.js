(function () {
  function money(value) {
    var num = Number(value || 0);
    return "$" + num.toFixed(2);
  }

  function optionList(select, values, selectedValue) {
    select.innerHTML = "";
    (values || []).forEach(function (value) {
      var option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      if (value === selectedValue) option.selected = true;
      select.appendChild(option);
    });
  }

  function closestProductForm(el) {
    return el.closest("form[action*='/cart/add']") || document.querySelector("form[action*='/cart/add']");
  }

  function ensureInsideProductForm(root) {
    var form = closestProductForm(root);
    if (!form) return;

    var hiddenInputs = root.querySelectorAll("input[type='hidden'][name^='properties'], select[name^='properties']");
    hiddenInputs.forEach(function (input) {
      if (!form.contains(input)) {
        form.appendChild(input);
      }
    });
  }

  function setHidden(root, selector, value) {
    var el = root.querySelector(selector);
    if (el) el.value = value == null ? "" : String(value);
  }

  function getEndpoint(root) {
    var shop = root.dataset.shop;
    var handle = root.dataset.productHandle;
    var productGid = root.dataset.productGid;
    var material = root.querySelector("[data-gso-material]")?.value || "";
    var finish = root.querySelector("[data-gso-finish]")?.value || "";
    var bagColor = root.querySelector("[data-gso-bag-color]")?.value || "";
    var minQty = Number(root.dataset.minQuantity || 64);
    var qtyInput = root.querySelector("[data-gso-quantity]");
    var quantity = Math.max(Number(qtyInput?.value || minQty), minQty);

    if (qtyInput && Number(qtyInput.value || 0) < minQty) {
      qtyInput.value = String(minQty);
    }

    var params = new URLSearchParams();
    params.set("shop", shop);
    params.set("handle", handle);
    params.set("productGid", productGid);
    params.set("material", material);
    params.set("finish", finish);
    params.set("bagColor", bagColor);
    params.set("quantity", String(quantity));

    return "/apps/wholesale-lite/configurator?" + params.toString();
  }

  async function loadConfig(root, firstLoad) {
    var loading = root.querySelector("[data-gso-loading]");
    var body = root.querySelector("[data-gso-body]");
    var errorBox = root.querySelector("[data-gso-error]");

    if (firstLoad && loading) loading.hidden = false;
    if (errorBox) {
      errorBox.hidden = true;
      errorBox.textContent = "";
    }

    try {
      var response = await fetch(getEndpoint(root), {
        method: "GET",
        credentials: "same-origin",
        headers: { "Accept": "application/json" }
      });

      var data = await response.json();

      if (!data.ok || !data.active) {
        if (loading) loading.textContent = data.message || "Configurator unavailable for this product.";
        return;
      }

      var materialSelect = root.querySelector("[data-gso-material]");
      var finishSelect = root.querySelector("[data-gso-finish]");
      var bagColorSelect = root.querySelector("[data-gso-bag-color]");
      var qtyInput = root.querySelector("[data-gso-quantity]");

      if (firstLoad) {
        optionList(materialSelect, data.options.materials, data.selected.material);
        optionList(finishSelect, data.options.finishes, data.selected.finish);
        optionList(bagColorSelect, data.options.bagColors, data.selected.bagColor);
      }

      if (qtyInput) {
        qtyInput.min = String(data.product.minQuantity || 64);
        if (Number(qtyInput.value || 0) < Number(qtyInput.min)) qtyInput.value = qtyInput.min;
      }

      root.querySelector("[data-gso-price-each]").textContent = money(data.pricing.priceEach);
      root.querySelector("[data-gso-order-total]").textContent = money(data.pricing.orderTotal);
      root.querySelector("[data-gso-tier]").textContent = data.pricing.matchedRange || "-";

      setHidden(root, "[data-gso-prop-erp-product-id]", data.product.id);
      setHidden(root, "[data-gso-prop-shopify-product-gid]", data.product.shopifyProductGid);
      setHidden(root, "[data-gso-prop-shopify-variant-gid]", data.product.shopifyVariantGid);
      setHidden(root, "[data-gso-prop-price-each]", data.pricing.priceEach);
      setHidden(root, "[data-gso-prop-cost-each]", data.pricing.costEach);
      setHidden(root, "[data-gso-prop-tier]", data.pricing.matchedRange);
      setHidden(root, "[data-gso-prop-production-finish]", data.pricing.productionFinish);

      ensureInsideProductForm(root);

      if (loading) loading.hidden = true;
      if (body) body.hidden = false;

      if (!data.pricing.matched && errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = "No pricing rule matched this combination. Please choose another option.";
      }
    } catch (error) {
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = "GSO configurator error. Please refresh or contact us.";
      }
      if (loading) loading.hidden = true;
      console.error("GSO configurator error", error);
    }
  }

  function init(root) {
    var material = root.querySelector("[data-gso-material]");
    var finish = root.querySelector("[data-gso-finish]");
    var bagColor = root.querySelector("[data-gso-bag-color]");
    var quantity = root.querySelector("[data-gso-quantity]");

    loadConfig(root, true);

    [material, finish, bagColor, quantity].forEach(function (el) {
      if (!el) return;
      el.addEventListener("change", function () {
        loadConfig(root, false);
      });
      el.addEventListener("input", function () {
        clearTimeout(root._gsoTimer);
        root._gsoTimer = setTimeout(function () {
          loadConfig(root, false);
        }, 250);
      });
    });

    document.addEventListener("submit", function (event) {
      var form = event.target;
      if (!form || !form.matches("form[action*='/cart/add']")) return;
      ensureInsideProductForm(root);
    }, true);
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-gso-configurator]").forEach(init);
  });
})();
