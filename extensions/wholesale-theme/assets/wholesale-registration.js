document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".wholesale-registration-block").forEach((root) => {
    const form = root.querySelector(".wholesale-registration-form");
    const message = root.querySelector(".wholesale-registration-message");
    const endpoint = root.getAttribute("data-wholesale-app-proxy") || "/apps/wholesale-lite/";

    if (!form || !message) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      message.textContent = "Submitting...";

      const formData = new FormData(form);
      const response = await fetch(endpoint, {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });

      const payload = await response.json();
      message.textContent = payload.message || (payload.ok ? "Submitted." : "Unable to submit.");
      if (payload.ok) form.reset();
    });
  });
});
