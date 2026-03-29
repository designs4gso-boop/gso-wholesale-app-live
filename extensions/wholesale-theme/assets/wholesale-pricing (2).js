document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll(".wholesale-pricing-block").forEach(function (root) {
    var proxy = root.getAttribute("data-app-proxy") || "/apps/wholesale-lite/pricing";
    var productId = root.getAttribute("data-product-id") || "";
    var selectedVariantId = root.getAttribute("data-selected-variant-id") || "";
    var variantIdsRaw = root.getAttribute("data-variant-ids") || "";
    var variantTitles = (root.getAttribute("data-variant-titles") || "").split("|||");
    var variantPricesRaw = (root.getAttribute("data-variant-prices") || "").split(",");
    var showTable = root.getAttribute("data-show-table") === "true";
    var showTierTable = root.getAttribute("data-show-tier-table") === "true";
    var heading = root.getAttribute("data-heading") || "Wholesale pricing available";

    var content = root.querySelector(".wholesale-pricing-content");
    if (!content || !productId || !variantIdsRaw) return;

    var variantIds = variantIdsRaw.split(",").filter(Boolean);
    var variants = {};
    for (var i = 0; i < variantIds.length; i++) {
      variants[variantIds[i]] = {
        id: variantIds[i],
        title: variantTitles[i] || "Variant " + (i + 1),
        retailPrice: parseFloat(variantPricesRaw[i]) || 0
      };
    }

    function money(value) {
      var num = Number(value || 0);
      return "$" + num.toFixed(2);
    }

    function escapeHtml(str) {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function parseDiscountedPrice(retail, discountType, value) {
      var price = retail;
      if (discountType === "PERCENT") {
        price = retail * (1 - Number(value || 0) / 100);
      } else if (discountType === "FIXED_AMOUNT") {
        price = Math.max(0, retail - Number(value || 0));
      }
      return Number(price.toFixed(2));
    }

    function getNearestProductForm() {
      return (
        root.closest('product-info') ||
        root.closest('section') ||
        document
      );
    }

    function getQuantityInput() {
      var scope = getNearestProductForm();
      return (
        scope.querySelector('input[name="quantity"]') ||
        document.querySelector('input[name="quantity"]') ||
        document.querySelector('input.quantity__input')
      );
    }

    function getCurrentQuantity() {
      var input = getQuantityInput();
      var qty = input ? parseInt(input.value, 10) : 1;
      return isNaN(qty) || qty < 1 ? 1 : qty;
    }

    function getVariantIdInput() {
      var scope = getNearestProductForm();
      return (
        scope.querySelector('input[name="id"]') ||
        document.querySelector('input[name="id"]') ||
        scope.querySelector('select[name="id"]') ||
        document.querySelector('select[name="id"]')
      );
    }

    function normalizeVariantId(rawId) {
      if (!rawId) return "";
      if (String(rawId).indexOf("gid://shopify/ProductVariant/") === 0) {
        return String(rawId);
      }
      return "gid://shopify/ProductVariant/" + String(rawId).trim();
    }

    function getCurrentVariantId() {
      var input = getVariantIdInput();
      if (input && input.value) {
        return normalizeVariantId(input.value);
      }
      return selectedVariantId || variantIds[0] || "";
    }

    function sortTiers(tiers) {
      return (tiers || []).slice().sort(function (a, b) {
        return Number(a.minQuantity || 0) - Number(b.minQuantity || 0);
      });
    }

    function getActiveTier(retailPrice, tiers, qty) {
      var sorted = sortTiers(tiers);
      var active = {
        minQuantity: 1,
        discountType: "PERCENT",
        value: 0,
        wholesalePrice: Number(retailPrice.toFixed(2)),
        label: "Retail"
      };

      for (var i = 0; i < sorted.length; i++) {
        var tier = sorted[i];
        if (qty >= Number(tier.minQuantity || 0)) {
          active = {
            minQuantity: Number(tier.minQuantity || 1),
            discountType: tier.discountType,
            value: Number(tier.value || 0),
            wholesalePrice: parseDiscountedPrice(retailPrice, tier.discountType, tier.value),
            label: Number(tier.minQuantity || 1) + "+ units"
          };
        }
      }

      return active;
    }

    function renderTableRows(retailPrice, tiers) {
      var sorted = sortTiers(tiers);
      if (!sorted.length) {
        return "<tr><td>1+</td><td>" + money(retailPrice) + "</td><td>Retail</td></tr>";
      }

      return sorted.map(function (tier) {
        var wholesalePrice = parseDiscountedPrice(retailPrice, tier.discountType, tier.value);
        var discountLabel =
          tier.discountType === "PERCENT"
            ? Number(tier.value || 0) + "% off"
            : money(Number(tier.value || 0)) + " off";

        return (
          "<tr>" +
            "<td>" + Number(tier.minQuantity || 1) + "+</td>" +
            "<td>" + money(wholesalePrice) + "</td>" +
            "<td>" + discountLabel + "</td>" +
          "</tr>"
        );
      }).join("");
    }

    function render(data) {
      var currentVariantId = getCurrentVariantId();
      var currentQty = getCurrentQuantity();
      var currentVariant = variants[currentVariantId] || variants[variantIds[0]] || null;

      if (!currentVariant) {
        content.innerHTML = "<p>Unable to load variant pricing.</p>";
        return;
      }

      var retailPrice = Number(currentVariant.retailPrice || 0);
      var tiersByVariant = (data && data.tiersByVariant) || {};
      var pricing = (data && data.pricing) || {};
      var variantTiers = tiersByVariant[currentVariantId] || [];

      if ((!variantTiers || !variantTiers.length) && pricing[currentVariantId]) {
        var p = pricing[currentVariantId];
        variantTiers = [{
          minQuantity: 1,
          discountType: p.discountType,
          value: p.value
        }];
      }

      var activeTier = getActiveTier(retailPrice, variantTiers, currentQty);
      var unitPrice = activeTier.wholesalePrice;
      var totalPrice = Number((unitPrice * currentQty).toFixed(2));
      var retailTotal = Number((retailPrice * currentQty).toFixed(2));
      var savings = Number((retailTotal - totalPrice).toFixed(2));

      var html = '<div class="wsp-inner">';
      html += '<h3 class="wsp-heading" style="margin:0 0 10px 0; font-size:18px;">' + escapeHtml(heading) + '</h3>';

      if (showTable) {
        html += ''
          + '<div class="wsp-summary" style="display:grid; gap:8px; margin-bottom:14px;">'
          +   '<div><strong>Variant:</strong> ' + escapeHtml(currentVariant.title) + '</div>'
          +   '<div><strong>Quantity:</strong> <span class="wsp-live-qty">' + currentQty + '</span></div>'
          +   '<div><strong>Active tier:</strong> <span class="wsp-live-tier">' + escapeHtml(activeTier.label) + '</span></div>'
          +   '<div><strong>Unit price:</strong> <span class="wsp-live-unit">' + money(unitPrice) + '</span></div>'
          +   '<div><strong>Total:</strong> <span class="wsp-live-total">' + money(totalPrice) + '</span></div>';

        if (savings > 0) {
          html += '<div><strong>You save:</strong> <span class="wsp-live-savings">' + money(savings) + '</span></div>';
        }

        html += '<div style="font-size:12px; opacity:.8;">Tier pricing updates as quantity changes. Final discounted price should also be enforced in cart.</div>';
        html += '</div>';
      }

      if (showTierTable) {
        html += ''
          + '<table class="wsp-table" style="width:100%; border-collapse:collapse;">'
          +   '<thead>'
          +     '<tr>'
          +       '<th style="text-align:left; padding:8px 6px; border-bottom:1px solid rgba(255,255,255,.15);">Qty</th>'
          +       '<th style="text-align:left; padding:8px 6px; border-bottom:1px solid rgba(255,255,255,.15);">Unit price</th>'
          +       '<th style="text-align:left; padding:8px 6px; border-bottom:1px solid rgba(255,255,255,.15);">Discount</th>'
          +     '</tr>'
          +   '</thead>'
          +   '<tbody>'
          +     renderTableRows(retailPrice, variantTiers)
          +   '</tbody>'
          + '</table>';
      }

      html += '</div>';
      content.innerHTML = html;
    }

    function attachLiveListeners(data) {
      var scope = getNearestProductForm();

      function rerenderSoon() {
        window.setTimeout(function () {
          render(data);
        }, 50);
      }

      scope.addEventListener("change", rerenderSoon);
      scope.addEventListener("input", rerenderSoon);

      var qtyInput = getQuantityInput();
      if (qtyInput) {
        qtyInput.addEventListener("change", rerenderSoon);
        qtyInput.addEventListener("input", rerenderSoon);
      }

      var variantInput = getVariantIdInput();
      if (variantInput) {
        variantInput.addEventListener("change", rerenderSoon);
        variantInput.addEventListener("input", rerenderSoon);
      }

      document.addEventListener("variant:change", rerenderSoon);
    }

    var url =
      proxy +
      "?product_id=" + encodeURIComponent(productId) +
      "&variant_ids=" + encodeURIComponent(variantIdsRaw);

    fetch(url, { credentials: "same-origin" })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        render(data || {});
        attachLiveListeners(data || {});
      })
      .catch(function (err) {
        console.error("Wholesale pricing fetch error:", err);
        render({});
        attachLiveListeners({});
      });
  });
});