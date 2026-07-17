// Shopify App Bridge web components used by the embedded admin nav
// (app/routes/app.tsx). Declared here so <s-app-nav>/<s-link> type-check;
// they are custom elements rendered by App Bridge at runtime.
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    "s-link": React.DetailedHTMLProps<React.AnchorHTMLAttributes<HTMLElement>, HTMLElement> & {
      href?: string;
    };
  }
}
