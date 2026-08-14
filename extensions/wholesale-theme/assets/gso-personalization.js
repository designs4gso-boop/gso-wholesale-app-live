/* GSO Stock Bag personalization — ADD YOUR BRAND (Phase 3)
 *
 * Optional logo / QR upload attached to a premade Stock Bag design. Stock Bags
 * are NOT Zakeke products; this is a separate channel and deliberately shares no
 * field with zakekeDesignId / zakekePreviewUrl.
 *
 * Gating: this file exits immediately unless [data-gso-personalization] exists.
 * That container is rendered by Liquid only when the merchant setting is ON and
 * product.type == 'Stock Bag', so while the feature is off there is no UI, no
 * state, and no network call.
 *
 * Phase 3 scope: UI + upload + client state only. Nothing is added to the GSO
 * cart payload — Phase 4 owns that and will read window.GSOPersonalization.get().
 */
(function () {
  "use strict";

  var MAX_FILES = 5;
  var MAX_BYTES = 10 * 1024 * 1024;
  var ACCEPTED = ["image/png", "image/jpeg", "application/pdf"];
  var EXTENSION_LABEL = "PNG, JPG or PDF";

  // LOCAL -> UPLOADING -> (READY | PROCESSING | ERROR)
  var STATE_LOCAL = "LOCAL";
  var STATE_UPLOADING = "UPLOADING";
  var STATE_PROCESSING = "PROCESSING";
  var STATE_READY = "READY";
  var STATE_ERROR = "ERROR";

  var root = null;
  var input = null;
  var dropzone = null;
  var list = null;
  var statusLine = null;
  var uploadProxy = "";
  var assets = [];
  var seq = 0;

  function text(value) {
    return String(value == null ? "" : value);
  }

  function announce(message) {
    if (statusLine) statusLine.textContent = text(message);
  }

  function activeUploadCount() {
    return assets.filter(function (asset) {
      return asset.status === STATE_UPLOADING;
    }).length;
  }

  /* An asset may enter the GSO cart only when it carries BOTH a durable Shopify
   * id and the server-issued claim. PROCESSING qualifies — checkout re-resolves
   * the URL server-side — but a resolved asset missing its claim does not,
   * because checkout would refuse it. */
  function isCartEligible(asset) {
    if (asset.status !== STATE_READY && asset.status !== STATE_PROCESSING) return false;
    return Boolean(asset.assetId) && Boolean(asset.assetClaim);
  }

  /* Phase 4 add-to-cart policy: an upload still running, a failed upload the
   * customer has not removed or retried, and a resolved-but-unclaimable asset
   * all block. Silently dropping any of them would lose the customer's artwork
   * without telling them. */
  function blockingAsset() {
    return assets.filter(function (asset) {
      if (asset.status === STATE_UPLOADING || asset.status === STATE_ERROR) return true;
      return !isCartEligible(asset);
    })[0] || null;
  }

  function blockMessageFor(asset) {
    if (!asset) return "";
    if (asset.status === STATE_UPLOADING) return "Please wait for your files to finish uploading.";
    return "Please remove or retry " + asset.originalFileName + " before adding to cart.";
  }

  /* ---------------- client-side validation (convenience only) ----------------
   * The server is authority. These checks exist so a customer gets an instant,
   * specific message instead of a round trip.
   */
  function validate(file, currentCount) {
    if (currentCount >= MAX_FILES) {
      return "You can upload up to " + MAX_FILES + " files.";
    }
    if (ACCEPTED.indexOf(file.type) === -1) {
      // SVG is refused here for UX; the server refuses it authoritatively too.
      return file.name + " isn't supported. Upload " + EXTENSION_LABEL + ".";
    }
    if (file.size > MAX_BYTES) {
      return file.name + " is larger than 10 MB.";
    }
    if (!file.size) {
      return file.name + " is empty.";
    }
    return null;
  }

  /* ---------------- rendering ---------------- */

  function labelFor(asset) {
    if (asset.status === STATE_UPLOADING) return "Uploading…";
    if (asset.status === STATE_PROCESSING) return "Processing…";
    if (asset.status === STATE_READY) return "Ready";
    if (asset.status === STATE_ERROR) return asset.errorMessage || "Upload failed";
    return "Selected";
  }

  function render() {
    if (!list) return;
    list.textContent = "";

    assets.forEach(function (asset) {
      var item = document.createElement("li");
      item.className = "gso-personalization__item gso-personalization__item--" + asset.status.toLowerCase();
      item.setAttribute("data-gso-personalization-item", asset.localId);

      var name = document.createElement("span");
      name.className = "gso-personalization__name";
      name.textContent = asset.originalFileName;

      var state = document.createElement("span");
      state.className = "gso-personalization__state";
      state.textContent = labelFor(asset);

      item.appendChild(name);
      item.appendChild(state);

      if (asset.status === STATE_ERROR) {
        var retry = document.createElement("button");
        retry.type = "button";
        retry.className = "gso-personalization__retry";
        retry.textContent = "Retry";
        retry.setAttribute("aria-label", "Retry uploading " + asset.originalFileName);
        retry.addEventListener("click", function () {
          retryAsset(asset.localId);
        });
        item.appendChild(retry);
      }

      // Removal is a browser-configuration action. Any Shopify file already
      // created is left to the orphan-retention sweep rather than deleted here.
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "gso-personalization__remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Remove " + asset.originalFileName);
      remove.addEventListener("click", function () {
        removeAsset(asset.localId);
      });
      item.appendChild(remove);

      list.appendChild(item);
    });

    syncAddToCart();
  }

  /* ---------------- add-to-cart guard ----------------
   * aria-disabled + a capture-phase click block, never the `disabled` property:
   * the configurator's own script owns that property (request-quote states), so
   * writing to it here could fight it. PROCESSING never blocks — those assets
   * already hold a durable Shopify assetId.
   */
  function syncAddToCart() {
    var button = document.querySelector("[data-gso-add-to-cart]");
    if (!button) return;
    var busy = blockingAsset() !== null;
    if (busy) {
      button.setAttribute("aria-disabled", "true");
      button.setAttribute("data-gso-personalization-busy", "1");
    } else if (button.getAttribute("data-gso-personalization-busy")) {
      button.removeAttribute("aria-disabled");
      button.removeAttribute("data-gso-personalization-busy");
    }
  }

  function guardAddToCart(event) {
    var button = event.target && event.target.closest ? event.target.closest("[data-gso-add-to-cart]") : null;
    if (!button) return;
    var blocked = blockingAsset();
    if (blocked) {
      event.preventDefault();
      event.stopImmediatePropagation();
      announce(blockMessageFor(blocked));
    }
  }

  /* ---------------- upload ---------------- */

  function applyResponseAsset(asset, payloadAsset) {
    asset.assetId = text(payloadAsset.assetId);
    // Phase 4: the claim is opaque here. The browser cannot verify the HMAC and
    // must not try — it only preserves what the server issued so checkout can
    // prove this asset came through GSO.
    asset.assetClaim = text(payloadAsset.assetClaim);
    asset.fileName = text(payloadAsset.fileName);
    asset.fileUrl = payloadAsset.fileUrl || null;
    asset.mimeType = text(payloadAsset.mimeType) || asset.mimeType;
    asset.byteSize = Number(payloadAsset.byteSize || asset.byteSize);
    asset.assetRole = text(payloadAsset.assetRole) || "personalization";
    // PROCESSING is a normal outcome, never a failure: Shopify Files is async.
    asset.status = payloadAsset.status === STATE_READY ? STATE_READY : STATE_PROCESSING;
    asset.errorCode = null;
    asset.errorMessage = "";
  }

  function failAsset(asset, code, message) {
    asset.status = STATE_ERROR;
    asset.errorCode = code || "UPLOAD_FAILED";
    asset.errorMessage = message || "We could not upload this file. Please try again.";
  }

  function upload(asset) {
    if (!asset.file) {
      failAsset(asset, "UPLOAD_FAILED", "This file is no longer available. Please select it again.");
      render();
      return Promise.resolve();
    }

    asset.status = STATE_UPLOADING;
    asset.errorCode = null;
    asset.errorMessage = "";
    render();
    announce("Uploading " + asset.originalFileName + "…");

    var body = new FormData();
    body.append("files", asset.file, asset.originalFileName);

    return fetch(uploadProxy, { method: "POST", body: body, credentials: "same-origin" })
      .then(function (response) {
        return response.text().then(function (raw) {
          var payload = null;
          try {
            payload = JSON.parse(raw);
          } catch (err) {
            payload = null;
          }
          if (!payload) throw new Error("BAD_RESPONSE");
          return payload;
        });
      })
      .then(function (payload) {
        if (payload.ok && payload.assets && payload.assets.length) {
          applyResponseAsset(asset, payload.assets[0]);
          announce(asset.originalFileName + (asset.status === STATE_READY ? " uploaded." : " is processing."));
        } else {
          // The endpoint returns bounded, customer-safe messages; show them as-is.
          var failed = payload.failedFile ? payload.failedFile + ": " : "";
          failAsset(asset, payload.code, failed + (payload.message || ""));
          announce(asset.errorMessage);
        }
      })
      .catch(function () {
        failAsset(asset, "UPLOAD_FAILED", "We could not upload this file. Please try again.");
        announce(asset.errorMessage);
      })
      .then(function () {
        render();
      });
  }

  /* ---------------- state actions ---------------- */

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    var accepted = [];
    files.forEach(function (file) {
      var problem = validate(file, assets.length + accepted.length);
      if (problem) {
        announce(problem);
        return;
      }
      seq += 1;
      accepted.push({
        localId: "gso-p-" + seq,
        originalFileName: text(file.name),
        byteSize: Number(file.size || 0),
        mimeType: text(file.type),
        assetId: null,
        assetClaim: null,
        fileName: null,
        fileUrl: null,
        assetRole: "personalization",
        status: STATE_LOCAL,
        errorCode: null,
        errorMessage: "",
        file: file,
      });
    });

    if (!accepted.length) {
      render();
      return;
    }

    assets = assets.concat(accepted);
    render();
    accepted.forEach(function (asset) {
      upload(asset);
    });
  }

  function removeAsset(localId) {
    var target = assets.filter(function (asset) {
      return asset.localId === localId;
    })[0];
    assets = assets.filter(function (asset) {
      return asset.localId !== localId;
    });
    if (target) announce(target.originalFileName + " removed.");
    render();
  }

  function retryAsset(localId) {
    var target = assets.filter(function (asset) {
      return asset.localId === localId;
    })[0];
    // Never re-upload something that already succeeded.
    if (!target || target.status === STATE_READY || target.status === STATE_PROCESSING) return;
    upload(target);
  }

  /* ---------------- init ---------------- */

  function bind() {
    input.addEventListener("change", function (event) {
      addFiles(event.target.files);
      // allow re-selecting the same file after a remove
      event.target.value = "";
    });

    ["dragenter", "dragover"].forEach(function (name) {
      dropzone.addEventListener(name, function (event) {
        event.preventDefault();
        dropzone.classList.add("is-dragover");
      });
    });

    ["dragleave", "dragend"].forEach(function (name) {
      dropzone.addEventListener(name, function () {
        dropzone.classList.remove("is-dragover");
      });
    });

    dropzone.addEventListener("drop", function (event) {
      event.preventDefault();
      dropzone.classList.remove("is-dragover");
      // dataTransfer.files carries every dropped file — multi-drop supported.
      if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files);
    });

    document.addEventListener("click", guardAddToCart, true);
  }

  function init() {
    root = document.querySelector("[data-gso-personalization]");
    if (!root) return; // feature off, or not a Stock Bag — do nothing at all

    input = root.querySelector("[data-gso-personalization-input]");
    dropzone = root.querySelector("[data-gso-personalization-drop]");
    list = root.querySelector("[data-gso-personalization-list]");
    statusLine = root.querySelector("[data-gso-personalization-status]");
    if (!input || !dropzone) return;

    uploadProxy = root.getAttribute("data-upload-proxy") || "/apps/wholesale-lite/personalization-upload";
    MAX_FILES = Number(root.getAttribute("data-max-files")) || MAX_FILES;
    MAX_BYTES = Number(root.getAttribute("data-max-bytes")) || MAX_BYTES;

    bind();
    render();
  }

  /* The configurator reads this to build the cart payload. Only resolved assets
   * are exposed, and the raw File object is never handed out. */
  window.GSOPersonalization = {
    get: function () {
      return assets
        .filter(function (asset) {
          return asset.status === STATE_READY || asset.status === STATE_PROCESSING;
        })
        .map(function (asset) {
          return {
            assetId: asset.assetId,
            assetClaim: asset.assetClaim,
            fileName: asset.fileName,
            originalFileName: asset.originalFileName,
            fileUrl: asset.fileUrl,
            mimeType: asset.mimeType,
            byteSize: asset.byteSize,
            assetRole: asset.assetRole,
            status: asset.status,
          };
        });
    },
    /* What actually goes into the GSO cart item, and therefore into the
     * browser's saved cart.
     *
     * Deliberately four small fields. fileUrl/mimeType/byteSize are omitted
     * because the server re-derives them and would ignore posted copies anyway,
     * and no File, Blob or encoded file content is ever handed out. */
    cartAssets: function () {
      return assets.filter(isCartEligible).map(function (asset) {
        return {
          assetId: asset.assetId,
          assetClaim: asset.assetClaim,
          originalFileName: asset.originalFileName,
          status: asset.status,
        };
      });
    },
    isBusy: function () {
      return activeUploadCount() > 0;
    },
    /* True when Add to Cart must be refused: an upload in flight, a failed file
     * still on screen, or a resolved file with no usable claim. */
    blocksAddToCart: function () {
      return blockingAsset() !== null;
    },
    clear: function () {
      assets = [];
      render();
    },
    states: {
      LOCAL: STATE_LOCAL,
      UPLOADING: STATE_UPLOADING,
      PROCESSING: STATE_PROCESSING,
      READY: STATE_READY,
      ERROR: STATE_ERROR,
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
