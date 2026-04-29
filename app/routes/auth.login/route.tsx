export default function AuthLogin() {
  return (
    <main style={{ maxWidth: 760, margin: "80px auto", padding: 24 }}>
      <h1>Log in</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const shop = new FormData(form).get("shop");

          if (!shop) return;

          window.top!.location.href =
            `/auth?shop=${encodeURIComponent(String(shop))}`;
        }}
      >
        <label>
          Shop domain
          <input
            name="shop"
            placeholder="942075-2.myshopify.com"
            style={{
              display: "block",
              width: "100%",
              padding: 10,
              marginTop: 8,
              marginBottom: 12,
            }}
          />
        </label>

        <button type="submit">Log in</button>
      </form>
    </main>
  );
}