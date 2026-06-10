# Known Errors

npm run typecheck currently reports many existing TypeScript issues across legacy/current ERP files.

Main categories:
- Polaris Badge children expecting string
- Polaris TextField defaultValue typing
- BlockStack/InlineStack gap type mismatches
- App Bridge s-app-nav / s-link JSX typings
- Existing quote/wholesale/calculator loader data typing issues
- Existing print log and RIP import type issues

These appear to be existing app-wide strict TypeScript issues, not caused by the configurator calculator itself.
