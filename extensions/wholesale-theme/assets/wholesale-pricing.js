document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll(".wholesale-pricing-block").forEach(function (root) {
    var pricingProxy = root.getAttribute("data-app-proxy") || "/apps/wholesale-lite/pricing";
    var productId = root.getAttribute("data-product-id") || "";
    var selectedVariantId = root.getAttribute("data-selected-variant-id") || "";
    var customerEmail = root.getAttribute("data-customer-email") || "";
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
      return "$" + Number(value || 0).toFixed(2);
    }

    function escapeHtml(str) {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function nearestScope() {
      return root.closest("section") || document;
    }

    function qtyInput() {
      var scope = nearestScope();
      return (
        scope.querySelector('input[name="quantity"]') ||
        document.querySelector('input[name="quantity"]') ||
        document.querySelector('input.quantity__input')
      );
    }

    function getQty() {
      var input = qtyInput();
      var value = input ? parseInt(input.value, 10) : 1;
      return isNaN(value) || value < 1 ? 1 : value;
    }

    function variantInput() {
      var scope = nearestScope();
      return (
        scope.querySelector('input[name="id"]') ||
        scope.querySelector('select[name="id"]') ||
        document.querySelector('input[name="id"]') ||
        document.querySelector('select[name="id"]')
      );
    }

    function normalizeVariantId(rawId) {
      if (!rawId) return "";
      if (String(rawId).indexOf("gid://shopify/ProductVariant/") === 0) return String(rawId);
      return "gid://shopify/ProductVariant/" + String(rawId).trim();
    }

    function currentVariantId() {
      var input = variantInput();
      if (input && input.value) return normalizeVariantId(input.value);
      return selectedVariantId || variantIds[0] || "";
    }

    function calcPrice(retailPrice, tier) {
      if (!tier) return retailPrice;
      if (tier.discountType === "FIXED_PRICE") return Number(tier.value || 0);
      if (tier.discountType === "PERCENT_OFF") return Number((retailPrice * (1 - Number(tier.value || 0) / 100)).toFixed(2));
      if (tier.discountType === "AMOUNT_OFF") return Number(Math.max(0, retailPrice - Number(tier.value || 0)).toFixed(2));
      return retailPrice;
    }

    function activeTier(tiers, qty, cartQty, subtotal) {
      var best = null;
      (tiers || []).forEach(function (tier) {
        var meetsQty = qty >= Number(tier.minQuantity || 1);
        var meetsProductMOQ = !tier.minProductQuantity || qty >= Number(tier.minProductQuantity || 1);
        var meetsCartQty = !tier.minCartQuantity || cartQty >= Number(tier.minCartQuantity || 1);
        var meetsSubtotal = !tier.minSubtotal || subtotal >= Number(tier.minSubtotal || 0);
        if (meetsQty && meetsProductMOQ && meetsCartQty && meetsSubtotal) best = tier;
      });
      return best;
    }

    function parseCartContext() {
      var qty = getQty();
      return {
        quantity: qty,
        cartQuantity: qty,
        subtotal: 0
      };
    }

    function tierRows(retailPrice, tiers) {
      if (!tiers || !tiers.length) {
        return "<tr><td>1+</td><td>" + money(retailPrice) + "</td><td>Retail</td></tr>";
      }

      return tiers.map(function (tier) {
        var p = calcPrice(retailPrice, tier);
        var label =
          tier.discountType === "FIXED_PRICE"
            ? "Fixed price"
            : tier.discountType === "PERCENT_OFF"
              ? (Number(tier.value || 0) + "% off")
              : (money(Number(tier.value || 0)) + " off");

        return "<tr><td>" + Number(tier.minQuantity || 1) + "+</td><td>" + money(p) + "</td><td>" + label + "</td></tr>";
      }).join("");
    }

    function render(data) {
      var ctx = parseCartContext();
      var vId = currentVariantId();
      var variant = variants[vId] || variants[variantIds[0]];
      if (!variant) {
        content.innerHTML = "<p>Unable to load pricing.</p>";
        return;
      }

      var tiersByVariant = (data && data.tiersByVariant) || {};
      var metaByVariant = (data && data.metaByVariant) || {};
      var settings = (data && data.settings) || {};
      var customerTags = (data && data.customerTags) || [];
      var tiers = tiersByVariant[vId] || [];
      var active = activeTier(tiers, ctx.quantity, ctx.cartQuantity, ctx.subtotal);
      var retail = Number(variant.retailPrice || 0);
      var unit = calcPrice(retail, active);
      var total = Number((unit * ctx.quantity).toFixed(2));
      var minProductQty = Number((metaByVariant[vId] && metaByVariant[vId].minProductQuantity) || 1);

      var html = '<div class="wsp-inner">';
      html += '<h3 style="margin:0 0 10px 0; font-size:18px;">' + escapeHtml(heading) + '</h3>';

      if (showTable) {
        html += '<div style="display:grid; gap:8px; margin-bottom:14px;">';
        html += '<div><strong>Variant:</strong> ' + escapeHtml(variant.title) + '</div>';
        html += '<div><strong>Customer tags:</strong> ' + (customerTags.length ? escapeHtml(customerTags.join(", ")) : "public / none") + '</div>';
        html += '<div><strong>Quantity:</strong> ' + ctx.quantity + '</div>';
        html += '<div><strong>Active tier:</strong> ' + (active ? escapeHtml(active.title) : "Retail") + '</div>';
        html += '<div><strong>Unit price:</strong> ' + money(unit) + '</div>';
        html += '<div><strong>Total:</strong> ' + money(total) + '</div>';
        if (minProductQty > 1) html += '<div><strong>Minimum product quantity:</strong> ' + minProductQty + '</div>';
        if (settings.enforceMinCartQty) html += '<div><strong>Minimum total cart quantity:</strong> ' + Number(settings.minCartQuantity || 1) + '</div>';
        if (Number(settings.minimumSubtotal || 0) > 0) html += '<div><strong>Minimum subtotal:</strong> ' + money(settings.minimumSubtotal) + '</div>';
        html += '</div>';
      }

      if (showTierTable) {
        html += '<table style="width:100%; border-collapse:collapse;">';
        html += '<thead><tr><th style="text-align:left; padding:8px 6px; border-bottom:1px solid rgba(255,255,255,.15);">Qty</th><th style="text-align:left; padding:8px 6px; border-bottom:1px solid rgba(255,255,255,.15);">Unit price</th><th style="text-align:left; padding:8px 6px; border-bottom:1px solid rgba(255,255,255,.15);">Discount</th></tr></thead>';
        html += '<tbody>' + tierRows(retail, tiers) + '</tbody>';
        html += '</table>';
      }

      html += '<div style="margin-top:10px;font-size:12px;opacity:.8;">This phase updates the public pricing display and rule engine. Final checkout price enforcement comes in the next phase.</div>';
      html += '</div>';
      content.innerHTML = html;
    }

    function wire(data) {
      var rerender = function () { setTimeout(function () { render(data); }, 30); };
      document.addEventListener("change", rerender);
      document.addEventListener("input", rerender);
    }

    fetch(
      pricingProxy +
      "?product_id=" + encodeURIComponent(productId) +
      "&variant_ids=" + encodeURIComponent(variantIdsRaw) +
      "&customer_email=" + encodeURIComponent(customerEmail),
      { credentials: "same-origin" }
    )
      .then(function (r) { return r.json(); })
      .then(function (data) { render(data || {}); wire(data || {}); })
      .catch(function () { render({}); wire({}); });
  });
});
